# WorkBuddy-computer-use

[简体中文](#) | **English**

> 
> This project is ported from [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) (a Windows computer control plugin for DeepSeek Harness). The core PowerShell engine remains unchanged, while the outer layer is refactored into a [WorkBuddy](https://www.workbuddy.cn) Skill. It is derived upstream from [cgissing/windows-computer-use](https://github.com/cgissing/windows-computer-use).

Let AI directly "see" and operate your real Windows desktop: read the control tree of any window, click/input/set values precisely by element, capture screenshots, perform OCR text recognition, manage windows, and launch programs. Designed exclusively for WorkBuddy’s Skill system; it can also be used independently as a command-line tool.

```
✅ Verified in real-world testing: Completed the full workflow of "search contact → open chat → type and send message" on WeChat 4.x (Qt fully custom-drawn UI)
```

---

## What it can do

| Capability | Description |
| --- | --- |
| Control Tree Reading | UI Automation tree / snapshot / locate elements by name or text |
| Precise Operation | Click, double-click, drag, scroll, type text, set values, send keystrokes, invoke — prioritized by element ID without moving the mouse |
| Visual Fallback | PrintWindow / region screenshot + Windows.Media.OCR text recognition + word bounding box screen coordinates |
| Wait for Confirmation | `wait_for` to wait for windows / elements / text to appear, returns explicit `verification: observed` |
| Window Management | Activate, move, gracefully close (WM_CLOSE), launch applications |
| Background-First | Actions that can run in the background (BM_CLICK, EM_REPLACESEL, UIA Pattern) will not grab foreground focus or move the mouse |
| Screen Overlay Hint | Glow border at screen edges + "AI is controlling your computer" banner + mouse label; these hints are excluded from screenshots by default |
| Instant Stop | Press global Esc to abort ongoing actions; you may also stop programmatically via `wcu abort` |
| Auto Cleanup | Screenshots stored inside the skill directory, auto-expire after 30 minutes, capped by quantity limit; use `wcu clean` for manual cleanup |

There are 25 actions in total. See [`docs/tools.md`](docs/tools.md) for the full parameter reference.

## How it works

```
WorkBuddy Agent
   │  bash: node bin/wcu.mjs <action> [--flag value ...]
   ▼
bin/wcu.mjs (CLI + persistent background daemon, named pipe singleton, serialized action queue)
   │  JSON lines
   ▼
scripts/windows-uia.ps1 (PowerShell 5.1 engine, UIA + SendInput + screenshot + OCR)
   │
   └── lib/takeover.mjs → scripts/windows-takeover.ps1/.cs
       (Screen hint banner + global Esc hook, cancellation notification via named event)
```

- **No third-party dependencies**: Only uses Windows built-in PowerShell 5.1 and Node.js standard libraries.
- **Persistent Mode for Speed**: The engine runs in `-Persistent` mode. Cold startup takes roughly 1–3 seconds; subsequent actions take 20–200ms. It exits automatically after 30 minutes of inactivity.
- **Local Processing**: Screenshots, OCR and control tree parsing run locally on your device. No data is uploaded.

## Installation

### Requirements

- **Windows 10 2004+ / Windows 11** (screenshot exclusion for the hint banner relies on `WDA_EXCLUDEFROMCAPTURE`; older systems degrade gracefully and the banner will appear in screenshots)
- PowerShell 5.1 (preinstalled with Windows, no extra setup needed)
- Node.js ≥ 20 (WorkBuddy’s built-in runtime works fine)
- WorkBuddy installed and logged in (when used as a Skill)

### Steps

```
# 1. Clone into WorkBuddy user skill directory (folder name must stay windows-computer-use)
git clone [https://github.com/fangyilin66/WorkBuddy-computer-use.git](https://github.com/fangyilin66/WorkBuddy-computer-use.git) "%USERPROFILE%\.workbuddy\skills\windows-computer-use"

# 2. Verify engine health (spawns background daemon on first run, ~1–3 seconds)
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" health

# 3. (Optional) Preview the AI control hint overlay
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" preview

# 4. Restart WorkBuddy (or reopen session) — the skill will be auto-discovered
```

After installation, you can tell WorkBuddy directly: "Help me click / type / check what is on screen in XX software", and the skill will trigger automatically.

You may also download the whole archive, open WorkBuddy → Skills → Add Skill → Upload Skill, then drag the archive in. I have not tested this method personally; it is provided as an alternative.

### Quick Start

```
W='node %USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs'

$W list-windows --max-windows 60        # List all visible windows
$W find --pid 1234 --query "Save"       # Find control by text, returns elementId
$W click --pid 1234 --id "uia:rt:42-123" # Click element (mouse does not move)
$W type-text --pid 1234 --id <id> --text "Hello" --method clipboard
$W screenshot --pid 1234 --max-width 1400 # Capture window screenshot, returns local path
$W ocr --pid 1234 --query "Submit"      # Locate target text on screen via OCR
```

### Self-Test

```
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\test\selftest.mjs"
```

The self-test launches an isolated WinForms window (it will not touch your other programs) and runs a 14-step end-to-end validation. It cleans up automatically when finished.

## Uninstall

```
# 1. Stop persistent background processes (engine + overlay helper)
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" stop

# 2. (Optional) Clear runtime artifacts (screenshots, logs, pause state)
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" clean --all

# 3. Delete skill directory
rmdir /s /q "%USERPROFILE%\.workbuddy\skills\windows-computer-use"
# Or PowerShell: Remove-Item -Recurse -Force "$env:USERPROFILE\.workbuddy\skills\windows-computer-use"

# 4. Restart WorkBuddy
```

Uninstallation leaves no system-wide modifications: this skill does not write to the registry, install services or add startup entries. All files are contained within the skill folder (screenshots under `.runtime\shots\`, removed together with the folder).

## Notes

**Security**

- The Agent can physically move the mouse, send keystrokes and press buttons. For actions such as sending messages, submitting forms, payments, deletions or modifying account settings, user confirmation is mandatory — this is a hard rule built into the skill and a baseline for all users.
- Press **Esc** to abort the current action at any time. The agent will not retry automatically after interruption; run `wcu resume` to unlock.
- It cannot interact with elevated UAC windows. Do not attempt to bypass UAC.
- A global keyboard hook is installed for the Esc hotkey (this is expected behavior). Some antivirus software may alert you. Keystrokes synthesized by the agent itself will not trigger interruption, to avoid self-abort.

**Privacy**

- Screenshot capture and OCR run entirely locally. The hint banner is excluded from screenshots by default via `WDA_EXCLUDEFROMCAPTURE`, though it is visible on your screen.
- Screenshots are saved in `.runtime\shots\` inside the skill folder. They auto-expire after 30 minutes, with a hard cap of 40 files. Run `wcu clean` to wipe them immediately. If you are concerned about screenshot retention, reduce `WCU_SHOT_TTL_MS` or manually clean after use.

**Compatibility**

- Best support for Win32 / WinForms / WPF / Electron apps. **Qt custom-drawn UIs (WeChat 4.x, QQ, DingTalk) expose empty UIA trees**, so the skill falls back to screenshot + OCR + coordinate-based control (this fallback workflow is built in).
- Games, DirectX fullscreen apps and windows inside RDP sessions also rely on the OCR fallback path.
- Multi-monitor support (virtual screen coordinates, DPI-aware).

## Contributing

Issues and PRs are welcome!

1. Fork this repo and create a branch (`feat/xxx` or `fix/xxx`)
2. Run self-test after changes: `node test/selftest.mjs` — all 14 checks must pass
3. For engine changes inside `scripts/windows-uia.ps1`, update the parameter table in `docs/tools.md` accordingly
4. Submit a PR explaining your motivation, changes and verification steps

Suggested directions: adaptation guides for more apps (especially Qt/custom UIs), improved OCR fallback strategies, new background dispatch paths, documentation improvements. Changes affecting upstream engine behavior should first be discussed in the upstream repository.

> 
> I am a student and may reply slowly. Thank you for your understanding.

## License

[MIT](LICENSE) — consistent with upstream [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win).

Copyright lineage: `cgissing/windows-computer-use` (original engine) → `Yu-tao-Li/dsh-computer-use-win` (DSH adaptation and major extensions) → this project (WorkBuddy Skill port). See [THIRD_PARTY.md](THIRD_PARTY.md).