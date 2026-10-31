// Takeover helper bridge: the on-screen "AI 正在控制电脑" indicator and the
// global Esc stop key.
//
// The helper (scripts/windows-takeover.ps1 + .cs) owns two things the CLI
// process cannot own itself:
//   - layered, click-through overlays on every display plus a label next to
//     the pointer, so the user always sees when the agent drives the machine;
//   - a low-level keyboard hook that swallows Esc and sets a named event, so a
//     running action can be cancelled even while the backend is busy.
// The named event is what the UIA backend polls: it is handed to the backend
// process through WCU_CANCEL_EVENT and to the helper through -CancelEvent.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const STOPPED = "COMPUTER_USE_STOPPED_BY_USER: 用户按 Esc（或自定义停止键）中止了本次操作。不要在同一轮里重试桌面输入；如果用户明确要求继续，先运行 `wcu resume`。";

export const DEFAULT_TAKEOVER = Object.freeze({
  enabled: true,
  indicatorText: "AI 正在控制电脑",
  position: "top",
  idleMs: 900,
  cursorIndicator: true,
  cursorLabel: "AI",
  // false = keep the overlay out of screen captures, so the agent's own
  // screenshots stay clean while the user still sees the indicator.
  visibleInCapture: false,
  stopShortcut: "",
});

export function normalizeTakeover(input = {}) {
  const value = { ...DEFAULT_TAKEOVER, ...(input || {}) };
  return {
    enabled: value.enabled !== false,
    indicatorText: typeof value.indicatorText === "string" && value.indicatorText.trim()
      ? value.indicatorText.trim().slice(0, 120) : DEFAULT_TAKEOVER.indicatorText,
    position: value.position === "bottom" ? "bottom" : "top",
    idleMs: Number.isFinite(Number(value.idleMs))
      ? Math.min(3000, Math.max(200, Number(value.idleMs))) : DEFAULT_TAKEOVER.idleMs,
    cursorIndicator: value.cursorIndicator !== false,
    cursorLabel: typeof value.cursorLabel === "string" && value.cursorLabel.trim()
      ? value.cursorLabel.trim().slice(0, 12) : DEFAULT_TAKEOVER.cursorLabel,
    visibleInCapture: value.visibleInCapture === true,
    stopShortcut: typeof value.stopShortcut === "string" ? value.stopShortcut : "",
  };
}

export class Takeover {
  constructor({ script, powershell = "powershell.exe", config, onStop = () => {}, log = () => {} }) {
    this.script = script;
    this.powershell = powershell;
    this.config = normalizeTakeover(config);
    this.onStop = onStop;
    this.log = log;
    this.eventName = "Local\\WCU-" + randomUUID();
    this.child = null;
    this.pid = null;
    this.active = 0;
    this.starting = null;
    this.unavailable = !this.config.enabled;
    this.closed = false;
    this.waiters = new Map();
    this.nextId = 0;
  }

  commandPayload() {
    return {
      indicatorEnabled: true,
      indicatorText: this.config.indicatorText,
      indicatorPosition: this.config.position,
      indicatorIdleMs: this.config.idleMs,
      cursorIndicatorEnabled: this.config.cursorIndicator,
      cursorLabel: this.config.cursorLabel,
      remoteIndicatorVisible: this.config.visibleInCapture,
      stopShortcut: this.config.stopShortcut,
    };
  }

  async start() {
    if (this.unavailable || this.closed) throw new Error("TAKEOVER_DISABLED");
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      let buffer = "";
      let diagnostic = "";
      let ready = false;
      const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
        "-File", this.script, "-CancelEvent", this.eventName];
      const child = spawn(this.powershell, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      this.pid = child.pid;
      const deadline = setTimeout(() => {
        this.unavailable = true;
        reject(new Error("接管助手启动超时（显卡/钩子不可用？）"));
        try { child.kill(); } catch {}
      }, 25000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
      child.stdout.on("data", chunk => {
        buffer += chunk;
        for (;;) {
          const at = buffer.indexOf("\n");
          if (at < 0) break;
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.kind === "ready") {
            ready = true;
            clearTimeout(deadline);
            this.log("takeover ready pid=" + child.pid + " monitors=" + message.monitors);
            resolve();
            continue;
          }
          if (message.kind === "stopped") {
            this.log("takeover stopped reason=" + message.reason);
            this.onStop(message.reason || "escape");
            continue;
          }
          const pending = this.waiters.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.waiters.delete(message.id);
          message.ok ? pending.resolve(message) : pending.reject(new Error(message.error));
        }
      });
      const died = error => {
        clearTimeout(deadline);
        if (this.child === child) this.child = null;
        const failure = error || new Error("接管助手已退出" + (diagnostic ? ": " + diagnostic.trim().slice(-400) : ""));
        if (!ready) { this.unavailable = true; reject(failure); }
        for (const [id, pending] of this.waiters) {
          clearTimeout(pending.timer);
          pending.reject(failure);
          this.waiters.delete(id);
        }
        if (ready) this.log("takeover helper died: " + failure.message);
      };
      child.once("error", died);
      child.once("exit", code => died(code === 0 ? undefined : new Error("接管助手退出码 " + code)));
      child.stdin.on("error", () => {});
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async command(command, params = {}, timeoutMs = 8000) {
    if (this.closed) throw new Error("TAKEOVER_CLOSED");
    await this.start();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`接管助手无响应: ${command}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...params, id, command }) + "\n", error => {
        if (error) { clearTimeout(timer); this.waiters.delete(id); reject(error); }
      });
    });
  }

  // Show the indicator and arm the stop key for one action.
  async begin() {
    if (this.unavailable || this.closed) return false;
    try {
      await this.command("begin", this.commandPayload());
      this.active++;
      return true;
    } catch (error) {
      this.unavailable = true;
      this.log("takeover begin failed: " + error.message);
      try { this.child?.kill(); } catch {}
      this.child = null;
      return false;
    }
  }

  // Called when an action finishes; the overlay fades after idleMs.
  async end() {
    if (!this.child || this.closed) return;
    this.active = Math.max(0, this.active - 1);
    try { await this.command("end"); } catch (error) { this.log("takeover end failed: " + error.message); }
  }

  async resume() {
    if (!this.child || this.closed) return;
    try { await this.command("resume"); } catch (error) { this.log("takeover resume failed: " + error.message); }
  }

  async preview(config) {
    if (config) this.config = normalizeTakeover(config);
    await this.command("preview", this.commandPayload());
  }

  // Programmatic equivalent of the user pressing Esc.
  async stop() {
    if (!this.child) return;
    await this.command("stop", {});
  }

  status() {
    return {
      enabled: this.config.enabled,
      helperPid: this.pid,
      ready: !!this.child,
      active: this.active,
      unavailable: this.unavailable,
      eventName: this.eventName,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.child) return;
    const child = this.child;
    try { await this.command("close", {}, 2000); } catch {}
    child.stdin.end();
    const force = setTimeout(() => { try { child.kill(); } catch {} }, 1500);
    force.unref();
  }
}
