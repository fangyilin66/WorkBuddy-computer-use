#!/usr/bin/env node
// Self-test for the windows-computer-use skill.
// Starts an isolated WinForms fixture window, drives it through bin/wcu.mjs
// (read → locate → click → type → set value → keypress → screenshot → wait →
// OCR → close) and reports PASS/FAIL per step. It only ever touches its own
// fixture window.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "wcu.mjs");
const RUNTIME = path.join(ROOT, ".runtime", "selftest");
const TITLE = "WCU Self Test";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  const text = detail === undefined ? "" : String(detail).replace(/\s+/g, " ").slice(0, 150);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${text ? "  — " + text : ""}`);
}

function wcu(action, ...flags) {
  const out = spawnSync(process.execPath, [CLI, action, ...flags], { encoding: "utf8", timeout: 120000 });
  const text = (out.stdout || "").trim();
  try { return JSON.parse(text); } catch {
    return { ok: false, error: text || (out.stderr || "").trim() || "no output" };
  }
}

function readState(name) {
  try { return JSON.parse(fs.readFileSync(path.join(RUNTIME, name), "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.rmSync(RUNTIME, { recursive: true, force: true });
  fs.mkdirSync(RUNTIME, { recursive: true });

  // A previous Esc leaves the series stopped; the test needs a clean slate.
  wcu("resume");

  const fixtureLog = fs.openSync(path.join(RUNTIME, "fixture.log"), "a");
  // A detached PowerShell child does not survive its bootstrap on this
  // platform, so the fixture runs attached and owns its own log handles.
  const fixture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(ROOT, "test", "fixture.ps1"), "-OutDir", RUNTIME], { stdio: ["ignore", fixtureLog, fixtureLog] });
  fixture.on("error", err => console.log("fixture spawn error:", err.message));
  fixture.unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !readState("fixture.json")) await sleep(200);
  const info = readState("fixture.json");
  record("fixture window launched", !!info, info ? `pid=${info.pid}` : "fixture.json never appeared");
  if (!info) return finish();
  await sleep(800);

  const target = ["--pid", String(info.pid)];

  const health = wcu("health");
  record("health", health.ok === true && health.result?.uiAutomation === true, health.error);

  const windows = wcu("list-windows", "--max-windows", "80");
  const listed = (windows.result?.windows || []).find(w => w.processId === info.pid && w.name === TITLE);
  record("list-windows finds the fixture by pid+title", !!listed, listed ? `hwnd=${listed.nativeWindowHandle}` : "not listed");

  const editId = wcu("find", ...target, "--query", "fixture-edit").result?.results?.[0]?.id;
  record("find control by automation name", !!editId, editId);

  const buttonId = wcu("find", ...target, "--query", "Fixture Button").result?.results?.[0]?.id;
  record("find control by visible text", !!buttonId, buttonId);

  const clickedEdit = wcu("click", ...target, "--id", editId || "", "--dispatch", "foreground");
  record("click element (real input, focus)", clickedEdit.ok === true, clickedEdit.error);
  await sleep(300);

  const typed = wcu("type-text", ...target, "--id", editId || "", "--text", "hello 中文 wcu", "--method", "clipboard");
  await sleep(600);
  const typedValue = readState("edit.json")?.text || "";
  record("type-text (CJK via clipboard)", typed.ok === true && typedValue.includes("hello 中文 wcu"), typedValue || typed.error);

  const setVal = wcu("set-value", ...target, "--id", editId || "", "--value", "set value 中文");
  await sleep(500);
  const setValue = readState("edit.json")?.text || "";
  record("set-value", setVal.ok === true && setValue === "set value 中文", setValue || setVal.error);

  const invoked = wcu("invoke", ...target, "--id", buttonId || "");
  await sleep(700);
  const clicked = !!readState("click.json");
  record("invoke button / handler fired", invoked.ok === true && clicked, clicked ? "" : invoked.error || "click.json missing");

  const keys = wcu("keypress", ...target, "--key", "ctrl+a");
  record("keypress chord", keys.ok === true, keys.error);

  const shot = wcu("screenshot", ...target, "--max-width", "900");
  const shotPath = shot.result?.screenshot?.path;
  record("screenshot written to disk", !!shotPath && fs.existsSync(shotPath), shotPath || shot.error);

  const waited = wcu("wait-for", ...target, "--condition", "element", "--query", "fixture-edit", "--timeout-ms", "4000");
  record("wait-for element", waited.result?.verification === "observed", JSON.stringify(waited.result || waited).slice(0, 120));

  const ocr = wcu("ocr", ...target, "--query", "Ready");
  const ocrText = ocr.result?.text || "";
  record("ocr returns text", ocr.ok === true && ocrText.length > 0, ocrText.slice(0, 60) || ocr.error);

  const closed = wcu("close-window", ...target);
  await sleep(1200);
  const stillListed = (wcu("list-windows", "--max-windows", "80").result?.windows || []).some(w => w.processId === info.pid && w.name === TITLE);
  record("close-window", closed.ok === true && !stillListed, stillListed ? "window still listed" : "");

  try { process.kill(fixture.pid); } catch {}
  finish();
}

function finish() {
  const failed = results.filter(r => !r.ok);
  console.log("\n" + "=".repeat(64));
  console.log(`RESULT: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map(r => r.name).join(" | "));
    process.exitCode = 1;
  }
  wcu("stop");
  wcu("clean");
}

main().catch(err => { console.error("selftest crashed:", err); process.exitCode = 1; });
