#!/usr/bin/env node
// wcu — Windows Computer Use CLI for WorkBuddy skills.
// A thin, dependency-free front-end over the vendored PowerShell UIA engine
// (scripts/windows-uia.ps1). A detached daemon keeps one `-Persistent` backend
// alive so repeated actions cost ~10-50ms instead of ~2.8s of PowerShell start-up.
//
// Usage:  node bin/wcu.mjs <action> [--flag value ...] [--json '<json>']
//         node bin/wcu.mjs status | stop | resume | preview | abort | takeover on|off
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Takeover, STOPPED, DEFAULT_TAKEOVER, normalizeTakeover } from "../lib/takeover.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PS_BACKEND = path.join(SKILL_ROOT, "scripts", "windows-uia.ps1");
const TAKEOVER_SCRIPT = path.join(SKILL_ROOT, "scripts", "windows-takeover.ps1");
const CONFIG_PATH = path.join(SKILL_ROOT, "takeover.json");
const RUNTIME_DIR = path.join(SKILL_ROOT, ".runtime");
const PAUSE_PATH = path.join(RUNTIME_DIR, "paused.json");
const POWERSHELL = process.env.WCU_POWERSHELL || "powershell.exe";
const IDLE_MS = Number(process.env.WCU_IDLE_MS || 30 * 60 * 1000);
const DEFAULT_TIMEOUT_MS = Number(process.env.WCU_TIMEOUT_MS || 60000);
const PAUSE_TTL_MS = Number(process.env.WCU_PAUSE_TTL_MS || 10 * 60 * 1000);
// Screenshots and OCR frames land in this skill-owned folder instead of the
// system TEMP, so they are easy to find and easy to purge.
const SHOTS_DIR = process.env.WCU_SHOTS_DIR || path.join(RUNTIME_DIR, "shots");
const SHOT_TTL_MS = Number(process.env.WCU_SHOT_TTL_MS || 30 * 60 * 1000);
const SHOT_MAX = Number(process.env.WCU_SHOT_MAX || 40);
const LOG_MAX_BYTES = Number(process.env.WCU_LOG_MAX_BYTES || 2 * 1024 * 1024);

const PIPE_PATH = "\\\\.\\pipe\\wcu-" + crypto.createHash("sha1").update(SKILL_ROOT).digest("hex").slice(0, 12);

// ---------------------------------------------------------------------------
// indicator / stop-key settings: takeover.json, overridable per shell
// ---------------------------------------------------------------------------
function loadTakeoverConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")); } catch { file = {}; }
  const env = { ...file };
  if (process.env.WCU_TAKEOVER === "0") env.enabled = false;
  if (process.env.WCU_TAKEOVER === "1") env.enabled = true;
  if (process.env.WCU_INDICATOR_TEXT) env.indicatorText = process.env.WCU_INDICATOR_TEXT;
  if (process.env.WCU_INDICATOR_POSITION) env.position = process.env.WCU_INDICATOR_POSITION;
  if (process.env.WCU_STOP_SHORTCUT !== undefined) env.stopShortcut = process.env.WCU_STOP_SHORTCUT;
  if (process.env.WCU_CURSOR_LABEL === "0") env.cursorIndicator = false;
  return normalizeTakeover(env);
}

function savePause(paused, reason) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(PAUSE_PATH, JSON.stringify({ paused, reason: reason || null, at: new Date().toISOString() }));
  } catch {}
}

function loadPause() {
  try {
    const saved = JSON.parse(fs.readFileSync(PAUSE_PATH, "utf8"));
    if (!saved.paused) return null;
    const age = Date.now() - Date.parse(saved.at || 0);
    if (!Number.isFinite(age) || age > PAUSE_TTL_MS) return null;
    return saved.reason || STOPPED;
  } catch { return null; }
}

function writeTakeoverConfig(patch) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")); } catch {}
  const next = normalizeTakeover({ ...file, ...patch });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

// ---------------------------------------------------------------------------
// housekeeping: screenshots are transient artefacts, not output
// ---------------------------------------------------------------------------
const SHOT_PATTERN = /^windows-computer-use-[0-9a-f]+\.png$/i;

function shotFiles() {
  try {
    return fs.readdirSync(SHOTS_DIR)
      .filter(name => SHOT_PATTERN.test(name))
      .map(name => {
        const file = path.join(SHOTS_DIR, name);
        try { return { name, file, mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size }; }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

// Deletes shots older than ttlMs, then trims to `max` keeping the newest.
// Anything younger than keepRecentMs survives: it is most likely the picture
// the agent is about to look at.
function pruneShots({ ttlMs = SHOT_TTL_MS, max = SHOT_MAX, keepRecentMs = 120000 } = {}) {
  const now = Date.now();
  const kept = [];
  let removed = 0;
  for (const entry of shotFiles()) {
    const age = now - entry.mtime;
    if (age > ttlMs && age > keepRecentMs) {
      try { fs.unlinkSync(entry.file); removed++; } catch {}
    } else {
      kept.push(entry);
    }
  }
  kept.sort((a, b) => a.mtime - b.mtime);
  while (kept.length > max) {
    const entry = kept.shift();
    try { fs.unlinkSync(entry.file); removed++; } catch {}
  }
  return { removed, kept: kept.length };
}

// The daemon's log is opened in append mode, so it can only be rotated while
// no daemon holds it: do it right before spawning one.
function rotateLog() {
  const file = path.join(RUNTIME_DIR, "daemon.log");
  try {
    if (fs.statSync(file).size < LOG_MAX_BYTES) return false;
    fs.renameSync(file, path.join(RUNTIME_DIR, "daemon.log.1"));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// action names: CLI kebab-case -> backend action
// ---------------------------------------------------------------------------
const ACTIONS = {
  "health": "health",
  "snapshot": "snapshot",
  "tree": "tree",
  "accessibility-tree": "tree",
  "list-windows": "list_windows",
  "find": "find",
  "element-info": "element_info",
  "click": "click",
  "double-click": "double_click",
  "move": "move",
  "drag": "drag",
  "scroll": "scroll",
  "type-text": "type_text",
  "keypress": "keypress",
  "focus": "focus",
  "invoke": "invoke",
  "set-value": "set_value",
  "activate-window": "activate_window",
  "cursor-pos": "cursor_pos",
  "screen-info": "screen_info",
  "wait-for": "wait_for",
  "wait": "wait",
  "close-window": "close_window",
  "move-window": "move_window",
  "launch-app": "launch_app",
  "screenshot": "screenshot",
  "ocr": "ocr",
  "tools": "tools",
};

// Actions that touch the real desktop: these are the ones that arm the stop
// listener and carry the helper pid to the backend.
const INPUT_ACTIONS = new Set(["launch_app", "click", "double_click", "move", "drag", "scroll",
  "type_text", "keypress", "focus", "invoke", "set_value", "activate_window", "close_window", "move_window"]);

// friendly flag -> backend argument
const FLAG_ALIASES = {  "window": "windowTitle",
  "title": "windowTitle",
  "pid": "processId",
  "hwnd": "nativeWindowHandle",
  "id": "elementId",
  "element": "elementId",
  "query": "query",
  "name": "name",
  "text": "text",
  "key": "key",
  "scope": "scope",
  "button": "button",
  "dispatch": "dispatch",
  "q": "query",
};

// Args that must reach PowerShell as numbers / booleans, never as strings.
const NUMERIC = new Set([
  "x", "y", "toX", "toY", "fromX", "fromY", "width", "height", "delta", "deltaX", "deltaY",
  "processId", "nativeWindowHandle", "maxDepth", "maxNodes", "maxResults", "maxWidth",
  "milliseconds", "treeTimeoutMs", "timeoutMs", "count", "depth", "index", "step", "amount",
  "screenX", "screenY", "tolerance", "maxWindows",
]);
const BOOLEAN = new Set([
  "activate", "includeOffscreen", "includeScreenshot", "includeInvisible", "captureWindow",
  "resolveControl", "foreground", "keepForeground", "noWait", "newInstance", "hidden",
  "clearFirst", "expected", "checked",
]);

function toCamel(flag) {
  return flag.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function coerce(key, raw) {
  if (NUMERIC.has(key)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    return raw;
  }
  if (BOOLEAN.has(key)) {
    if (raw === "true" || raw === "false") return raw === "true";
    return raw;
  }
  return raw;
}

function parseArgs(argv) {
  const args = {};
  let action = null;
  let pretty = false;
  let keepBase64 = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--pretty") { pretty = true; continue; }
    if (token === "--keep-base64") { keepBase64 = true; continue; }
    if (token === "--json") {
      const raw = argv[++i];
      if (raw === undefined) throw new Error("--json needs a JSON object");
      Object.assign(args, JSON.parse(raw));
      continue;
    }
    if (token === "--text-file") {
      const file = argv[++i];
      if (!file) throw new Error("--text-file needs a path");
      args.text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      continue;
    }
    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const eq = raw.indexOf("=");
      let key = eq >= 0 ? raw.slice(0, eq) : raw;
      let value = eq >= 0 ? raw.slice(eq + 1) : undefined;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("--") && next.length > 2)) value = "true";
        else { value = next; i++; }
      }
      key = FLAG_ALIASES[key] || toCamel(key);
      args[key] = coerce(key, value);
      continue;
    }
    if (action === null) { action = token; continue; }
    throw new Error(`Unexpected argument '${token}'. Use --flag value pairs.`);
  }
  if (typeof args.key === "string") {
    // --key "Ctrl+L" / --key Enter  ->  keys: ["Ctrl","L"] / ["Enter"]
    const chord = args.key;
    delete args.key;
    args.keys = chord.split("+").map(part => part.trim()).filter(Boolean);
  }
  if (typeof args.keys === "string") {
    args.keys = args.keys.split(",").map(part => part.trim()).filter(Boolean);
  }
  return { action, args, pretty, keepBase64 };
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
function connect(timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE_PATH);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("CONNECT_TIMEOUT")); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", err => { clearTimeout(timer); reject(err); });
  });
}

function request(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    connect().then(socket => {
      let buffer = "";
      const limit = timeoutMs + 15000;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("WCU_DAEMON_TIMEOUT")); }, limit);
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        socket.end();
        let parsed;
        try { parsed = JSON.parse(buffer.slice(0, nl)); } catch (err) { reject(new Error("Bad daemon response: " + err.message)); return; }
        resolve(parsed);
      });
      socket.on("error", err => { clearTimeout(timer); reject(err); });
      socket.write(JSON.stringify(payload) + "\n");
    }).catch(reject);
  });
}

async function ensureDaemon() {
  try { const s = await connect(400); s.destroy(); return; } catch { /* not running */ }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  rotateLog();
  const out = fs.openSync(path.join(RUNTIME_DIR, "daemon.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__daemon"], {
    detached: true, windowsHide: true, stdio: ["ignore", out, out],
  });
  child.unref();
  fs.writeFileSync(path.join(RUNTIME_DIR, "daemon.pid"), String(child.pid));
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    try { const s = await connect(500); s.destroy(); return; } catch { /* keep waiting */ }
  }
  throw new Error("WCU backend did not start. See .runtime/daemon.log");
}

function stripBase64(value) {
  if (Array.isArray(value)) return value.map(stripBase64);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "base64" && typeof v === "string") out[k] = `<${v.length} base64 chars omitted; use path>`;
      else out[k] = stripBase64(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// daemon: one long-lived PowerShell backend + one serialized request queue
// ---------------------------------------------------------------------------
function runDaemon() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let backend = null;
  let backendGen = 0;
  const pending = new Map(); // id -> {resolve, reject, timer}
  let nextId = 1;
  let inflight = null; // {id, payload} currently written to the backend
  const queue = [];
  let lastUsed = Date.now();
  let lastPrune = 0;
  let paused = loadPause();

  function log(...parts) { try { process.stdout.write(`[${new Date().toISOString()}] ${parts.join(" ")}\n`); } catch {} }

  const takeover = new Takeover({
    script: TAKEOVER_SCRIPT, powershell: POWERSHELL, config: loadTakeoverConfig(), log,
    onStop: reason => {
      // Esc: the helper already set the cancel event, so the running action
      // throws at its next checkpoint. Pause the series so nothing new starts.
      paused = STOPPED;
      savePause(true);
      log("stopped by user (" + reason + ")");
      const job = inflight;
      if (job) {
        // Give the backend a moment to notice the event; if it is wedged in a
        // blocking call, kill it so the stop is actually immediate.
        setTimeout(() => {
          if (inflight && inflight.id === job.id) {
            log("backend did not honour the stop; killing it");
            try { backend?.kill(); } catch {}
          }
        }, 1200);
      }
    },
  });

  function startBackend() {
    if (!fs.existsSync(PS_BACKEND)) throw new Error("Missing backend script: " + PS_BACKEND);
    const gen = ++backendGen;
    // WCU_CANCEL_EVENT is how the backend sees the helper's stop event.
    const env = { ...process.env };
    if (takeover.config.enabled) env.WCU_CANCEL_EVENT = takeover.eventName;
    else delete env.WCU_CANCEL_EVENT;
    // Point the engine's TEMP at the skill's own shots folder: every capture
    // then lands next to the skill instead of scattered through %TEMP%.
    try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); env.TEMP = SHOTS_DIR; env.TMP = SHOTS_DIR; } catch {}
    const child = spawn(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_BACKEND, "-Persistent"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env,
    });
    backend = child;
    log("backend started pid=" + child.pid);
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { log("non-JSON stdout:", line.slice(0, 200)); continue; }
        const entry = pending.get(msg.id);
        if (!entry) { log("orphan response id=" + msg.id); continue; }
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (inflight && inflight.id === msg.id) { inflight = null; dispatchNext(); }
        entry.resolve(msg);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => log("backend stderr:", String(chunk).trim().slice(0, 500)));
    child.on("exit", code => {
      log("backend exited code=" + code);
      if (gen !== backendGen) return;
      backend = null;
      // After Esc the killed backend is expected: report the stop, not a crash.
      const err = new Error(paused ? STOPPED : "WCU_BACKEND_EXITED:" + code);
      for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(err); pending.delete(id); }
      inflight = null;
    });
    child.stdin.on("error", err => log("backend stdin error:", err.message));
  }

  function dispatchNext() {
    if (inflight || !queue.length) return;
    if (!backend) {
      try {
        startBackend();
      } catch (err) {
        while (queue.length) {
          const job = queue.shift();
          const entry = pending.get(job.id);
          if (!entry) continue;
          pending.delete(job.id);
          clearTimeout(entry.timer);
          entry.reject(err);
        }
        return;
      }
    }
    const job = queue.shift();
    inflight = { id: job.id, payload: job.payload };
    const entry = pending.get(job.id);
    if (!entry) { inflight = null; return dispatchNext(); }
    // The helper's pid lets the backend notice a helper that died mid-action
    // and fail closed instead of running on without a stop key.
    const args = { ...job.payload.args };
    if (takeover.pid && takeover.config.enabled && INPUT_ACTIONS.has(job.payload.action) && args._wcuTakeoverPid === undefined) {
      args._wcuTakeoverPid = takeover.pid;
    }
    try {
      backend.stdin.write(JSON.stringify({ id: job.id, action: job.payload.action, args }) + "\n");
    } catch (err) {
      pending.delete(job.id);
      clearTimeout(entry.timer);
      inflight = null;
      entry.reject(err);
      dispatchNext();
    }
  }

  function submit(payload) {
    return new Promise((resolve, reject) => {
      if (paused) {
        // Esc leaves the series stopped: nothing new starts until `wcu resume`
        // or the pause TTL expires.
        reject(new Error(paused === STOPPED ? STOPPED : `COMPUTER_USE_PAUSED: ${paused}`));
        return;
      }
      const id = nextId++;
      const timeoutMs = Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`WCU_TIMEOUT after ${timeoutMs}ms (action drifted or window unresponsive)`));
        // A wedged backend cannot be trusted with input state: kill and respawn lazily.
        try { backend?.kill(); } catch {}
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      queue.push({ id, payload });
      dispatchNext();
    });
  }

  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async chunk => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let payload;
      try { payload = JSON.parse(line); } catch (err) {
        socket.end(JSON.stringify({ ok: false, error: "bad request: " + err.message }) + "\n");
        return;
      }
      lastUsed = Date.now();
      if (payload.action === "__ping") {
        const result = {
          pid: process.pid, backend: backend ? backend.pid : null, queued: queue.length,
          inflight: !!inflight, paused: paused || null, uptimeMs: Math.round(process.uptime() * 1000),
          takeover: takeover.status(),
        };
        if (payload.withHelper && takeover.child) {
          try { result.helper = await takeover.command("status", {}, 4000); } catch (err) { result.helper = { error: err.message }; }
        }
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
        return;
      }
      if (payload.action === "__resume") {
        paused = null;
        savePause(false);
        await takeover.resume();
        socket.end(JSON.stringify({ ok: true, result: { resumed: true, takeover: takeover.status() } }) + "\n");
        return;
      }
      if (payload.action === "__preview") {
        try {
          await takeover.preview(payload.config);
          socket.end(JSON.stringify({ ok: true, result: { previewed: true, takeover: takeover.status() } }) + "\n");
        } catch (err) {
          socket.end(JSON.stringify({ ok: false, error: err.message }) + "\n");
        }
        return;
      }
      if (payload.action === "__abort") {
        try {
          await takeover.stop();
          socket.end(JSON.stringify({ ok: true, result: { stopped: true } }) + "\n");
        } catch (err) {
          socket.end(JSON.stringify({ ok: false, error: err.message }) + "\n");
        }
        return;
      }
      if (payload.action === "__shutdown") {
        socket.end(JSON.stringify({ ok: true, result: { stopping: true } }) + "\n");
        setTimeout(shutdown, 50);
        return;
      }
      // The indicator is up for as long as an action is running, and stays a
      // moment after it ends, so a series of commands reads as one gesture.
      const shown = await takeover.begin();
      try {
        const result = await submit(payload);
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
      } catch (err) {
        socket.end(JSON.stringify({ ok: false, error: err.message, paused: !!paused }) + "\n");
      } finally {
        if (shown) await takeover.end();
        // Keep the shots folder bounded without making every action pay for it.
        if (Date.now() - lastPrune > 60000) {
          lastPrune = Date.now();
          const swept = pruneShots();
          if (swept.removed) log(`pruned ${swept.removed} old screenshot(s), ${swept.kept} kept`);
        }
      }
    });
    socket.on("error", () => {});
  });

  server.on("error", err => {
    if (err.code === "EADDRINUSE") { log("another daemon owns the pipe; exiting"); process.exit(0); }
    log("pipe error:", err.message);
  });

  function shutdown() {
    try { backend?.kill(); } catch {}
    takeover.close().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  }

  server.listen(PIPE_PATH, () => {
    log("daemon listening pid=" + process.pid + " pipe=" + PIPE_PATH + " takeover=" + (takeover.config.enabled ? "on" : "off"));
    const swept = pruneShots();
    if (swept.removed) log(`pruned ${swept.removed} old screenshot(s) on start, ${swept.kept} kept`);
    try { startBackend(); } catch (err) { log("backend start failed:", err.message); }
    // Warm the takeover helper in the background: it compiles C# on start, so
    // paying that while the first action runs keeps the indicator snappy.
    if (takeover.config.enabled) takeover.start().catch(err => log("takeover helper unavailable: " + err.message));
    setInterval(() => {
      if (Date.now() - lastUsed > IDLE_MS && !inflight && !queue.length) {
        log("idle exit");
        shutdown();
      }
    }, 60000).unref();
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "__daemon") { runDaemon(); return; }
  if (process.platform !== "win32") {
    console.log(JSON.stringify({ ok: false, error: "This skill only runs on Windows." }));
    process.exit(1);
  }
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(JSON.stringify({ ok: true, usage: "node bin/wcu.mjs <action> [--flag value ...] [--json '<json>']", actions: Object.keys(ACTIONS), daemon: ["status", "stop", "resume", "preview", "abort", "clean [--all]", "takeover on|off"] }));
    return;
  }
  if (argv[0] === "status" || argv[0] === "stop") {
    try {
      const res = await request({ action: argv[0] === "status" ? "__ping" : "__shutdown" }, 5000);
      console.log(JSON.stringify(res));
    } catch {
      console.log(JSON.stringify({ ok: true, running: false, takeover: { enabled: loadTakeoverConfig().enabled } }));
    }
    return;
  }
  if (argv[0] === "resume") {
    // Clears the stop state left behind by Esc.
    await ensureDaemon();
    const res = await request({ action: "__resume" }, 30000);
    console.log(JSON.stringify(res));
    if (!res.ok) process.exit(1);
    return;
  }
  if (argv[0] === "preview") {
    // Shows the indicator for ~1.8s without touching any window.
    await ensureDaemon();
    const res = await request({ action: "__preview" }, 40000);
    console.log(JSON.stringify(res));
    if (!res.ok) process.exit(1);
    return;
  }
  if (argv[0] === "abort") {
    // Programmatic Esc: cancels the running action and pauses the series.
    const res = await request({ action: "__abort" }, 15000);
    console.log(JSON.stringify(res));
    if (!res.ok) process.exit(1);
    return;
  }
  if (argv[0] === "clean") {
    // Manual sweep: purge every shot, the throwaway test/render folders and,
    // with --all, the daemon log too.
    const before = shotFiles();
    const bytes = before.reduce((sum, file) => sum + file.size, 0);
    let removed = 0;
    for (const file of before) { try { fs.unlinkSync(file.file); removed++; } catch {} }
    const extras = [];
    for (const dir of ["selftest", "render"]) {
      const target = path.join(RUNTIME_DIR, dir);
      if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); extras.push(dir + "/"); }
    }
    const rotate = rotateLog();
    if (rotate) extras.push("daemon.log→daemon.log.1");
    if (argv.includes("--all")) {
      for (const name of ["daemon.log", "daemon.log.1", "daemon.pid"]) {
        const target = path.join(RUNTIME_DIR, name);
        if (fs.existsSync(target)) { try { fs.unlinkSync(target); extras.push(name); } catch {} }
      }
    }
    console.log(JSON.stringify({ ok: true, removed, freedBytes: bytes, shotsDir: SHOTS_DIR, extras }));
    return;
  }
  if (argv[0] === "takeover") {
    const mode = (argv[1] || "status").toLowerCase();
    if (mode === "on" || mode === "off") {
      const config = writeTakeoverConfig({ enabled: mode === "on" });
      try { await request({ action: "__shutdown" }, 5000); } catch {}
      console.log(JSON.stringify({ ok: true, takeover: config }));
      return;
    }
    if (mode === "status") {
      let daemonStatus = { running: false };
      try { daemonStatus = (await request({ action: "__ping", withHelper: true }, 8000)).result || daemonStatus; } catch {}
      console.log(JSON.stringify({ ok: true, config: loadTakeoverConfig(), daemon: daemonStatus }));
      return;
    }
    console.log(JSON.stringify({ ok: false, error: "用法: wcu takeover on|off|status" }));
    process.exit(2);
  }

  const { action, args, pretty, keepBase64 } = parseArgs(argv);
  const backendAction = ACTIONS[action];
  if (!backendAction) {
    console.log(JSON.stringify({ ok: false, error: `Unknown action '${action}'`, actions: Object.keys(ACTIONS) }));
    process.exit(2);
  }
  // args.timeoutMs is the backend's own wait budget (wait_for); the transport
  // must allow at least that long, or a legitimate wait looks like a hang.
  const waitBudget = Number(args.timeoutMs) || 0;
  const timeoutMs = Math.max(DEFAULT_TIMEOUT_MS, waitBudget + 15000);
  await ensureDaemon();
  const res = await request({ action: backendAction, args, timeoutMs }, timeoutMs);
  const output = !res.ok
    ? { ok: false, error: res.error, ...(res.paused ? { paused: true, hint: "用户已用 Esc 停止。除非用户明确要求继续，否则不要重试；继续前先运行 wcu resume。" } : {}) }
    : { ok: true, result: keepBase64 ? res.result : stripBase64(res.result) };
  console.log(JSON.stringify(output, null, pretty ? 2 : 0));
  if (!res.ok) process.exit(res.paused ? 3 : 1);
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  process.exit(1);
});
