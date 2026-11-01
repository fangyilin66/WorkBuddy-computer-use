---
name: windows-computer-use
version: 1.1.1
display_name: Windows 电脑操控
display_name_en: Windows Computer Use
description: 让 AI 直接"看"和"操作"本机 Windows 桌面应用——通过 UI Automation 读取控件树、按元素 ID 点击/输入/设值、截图、OCR 文字识别、启动与窗口管理，无需用户手动搬运鼠标键盘。当用户要求"操作某个桌面软件/窗口/按钮"、"帮我在这台电脑上点一下/输入/复制粘贴"、"识别屏幕上的文字"、"自动填写表单"、"打开某个程序并操作它"、或任何需要读取真实 Windows 界面状态的桌面自动化任务时使用。
description_zh: Windows 桌面操控技能（UI Automation + 截图 + OCR + 输入）：读取窗口控件树、按元素 ID 精确点击/输入/设值、等待界面变化、管理窗口与启动程序，用于真实桌面自动化。
description_en: Windows desktop automation for the agent: UI Automation tree reads, element-id based click/type/set-value, screenshots, OCR, window management and app launching, driven by a persistent PowerShell engine.
agent_created: true
---

# Windows 电脑操控 (Windows Computer Use)

把本机 Windows 桌面变成 agent 可读可写的界面：**观察 → 定位 → 执行 → 确认** 四步循环。
底层是本技能自带的 PowerShell UI Automation 引擎（常驻进程），命令行入口是 `bin/wcu.mjs`。

## 何时用 / 何时不用

**用**：用户要在真实桌面软件上完成操作（Office、记事本、资源管理器、微信、IDE、设置页……）；需要读取某个窗口里有哪些按钮/输入框；需要按文字找元素并点击；需要 OCR 屏幕上看得见但 UIA 读不到的文字；需要启动程序、切窗口、等界面刷新。

**不用**：
- 纯网页任务且能用浏览器自动化完成 → 优先 `workbuddy-browser-use`（后台、不动鼠标），本技能只作为兜底（操作浏览器原生对话框、chrome 界面、iframe 内容）。
- 只是读写本地文件/跑命令 → 直接用 Read/Bash，不要绕桌面。
- 用户没要求的破坏性操作（删除、发送、支付、改账户设置）→ 必须先问。

## 调用方式

技能根目录（下称 `$SKILL`）：

```
%USERPROFILE%\.workbuddy\skills\windows-computer-use
```

统一入口（bash / PowerShell 都可以，输出为 JSON）：

```bash
node "$SKILL/bin/wcu.mjs" <action> [--flag value ...] [--json '<json>']
node "$SKILL/bin/wcu.mjs" status          # 常驻后端 + 提示条状态
node "$SKILL/bin/wcu.mjs" stop            # 停掉常驻后端（卡住/收尾时用）
node "$SKILL/bin/wcu.mjs" preview         # 只闪一下提示条，验证用户能看到
node "$SKILL/bin/wcu.mjs" resume          # 解除 Esc 之后的停止状态
node "$SKILL/bin/wcu.mjs" abort           # 程序化"按 Esc"（测试/应急）
node "$SKILL/bin/wcu.mjs" clean           # 立即清空截图与临时目录（--all 连日志一起清）
node "$SKILL/bin/wcu.mjs" takeover on|off # 开关提示条与 Esc 停止
```

- 首次调用会拉起常驻后端（约 1–3 秒，含提示条助手），之后每次约 **20–200ms**；30 分钟空闲自动退出。
- 参数名就是 `docs/tools.md` 里的 camelCase 字段，命令行写成 kebab-case：`windowTitle` → `--window`（别名）/`--window-title`，`processId` → `--pid`，`nativeWindowHandle` → `--hwnd`，`elementId` → `--id`。
- 复杂参数（数组/嵌套）用 `--json '{"keys":["ctrl","l"]}'`。
- 长文本/多行/含中文标点的输入用 `--text-file <path>`（UTF-8 文件），避免命令行转义踩坑。
- 默认输出精简 JSON；截图字段只返回 `path`（base64 已剥离）——需要看图就 `ViewImage` 那个路径。

## 屏幕接管提示与 Esc 停止

每个动作执行期间，屏幕上会出现（动作结束后自动淡出）：

- **屏幕四周淡蓝光晕** + 顶部/底部一条深色小条：`● AI 正在控制电脑 [Esc 停止]`（位置、文案可配）；
- **鼠标旁的小标签**（默认 `AI`），只在真的借用鼠标键盘时跟随指针。

同时装了一个全局键盘钩子：**任何时候按 Esc 立即中断正在执行的动作**，并把这一轮标记为"用户已停止"。要点：

- 提示条与指针标签默认**不进截图**（`WDA_EXCLUDEFROMCAPTURE`），所以我拍到的画面是干净的，不会把提示条当成界面元素。
- Esc 是物理按键才生效，agent 自己合成的按键不会触发（防止自我中断）。
- Esc 之后后端返回 `COMPUTER_USE_STOPPED_BY_USER`、`paused:true`、退出码 3，**同一轮不要重试**；用户明确说继续时，先 `wcu resume` 再接着做。
- 状态存在 `.runtime/paused.json`，默认 10 分钟后自动过期（可用 `WCU_PAUSE_TTL_MS` 调）。
- 助手起不来（无桌面会话/显卡限制）只会退化成"没有提示条"，桌面操作本身不受影响。

配置在 `$SKILL/takeover.json`（改完自动生效，`takeover on|off` 会重启后端）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉则没有提示条也没有 Esc 停止 |
| `indicatorText` | `AI 正在控制电脑` | 提示条文案（≤120 字符） |
| `position` | `top` | `top` / `bottom` |
| `idleMs` | `900` | 动作结束后停留多久（200–3000ms） |
| `cursorIndicator` | `true` | 是否显示鼠标旁标签 |
| `cursorLabel` | `AI` | 标签文字（≤12 字符） |
| `visibleInCapture` | `false` | `true` 则提示条也会出现在截图/录屏里 |
| `stopShortcut` | `""` | 额外停止键，如 `Ctrl+Shift+F12`；Esc 永远有效 |

## 截图落盘与自动清理

`screen capture` 类动作（`screenshot` / `snapshot` / `ocr` / `wait-for` 的视觉确认）会把 PNG 写到这里，**不再散落到系统 `%TEMP%`**：

```
%USERPROFILE%\.workbuddy\skills\windows-computer-use\.runtime\shots\windows-computer-use-<32位hex>.png
```

清理策略（全自动，无需干预）：

- 每次后台进程启动、以及每隔 ≥60 秒的动作结束时自动扫一遍；
- 超过 **30 分钟**的截图删除；总数超过 **40 张**时从最旧的开始删；
- 2 分钟内新建的文件受保护，避免删掉我刚要看的那张；
- 同目录下的 `wcu-native-*.dll` / `wcu-ocr-*.dll` 是编译缓存，**不会被清**（删了只是下次多花几百毫秒重编译）。

想立刻清空（比如任务收尾）就 `node "$SKILL/bin/wcu.mjs" clean`；连日志一起清用 `clean --all`。
环境变量可调：`WCU_SHOT_TTL_MS`（默认 1800000）、`WCU_SHOT_MAX`（默认 40）、`WCU_SHOTS_DIR`、`WCU_LOG_MAX_BYTES`。

## 四步循环（必须遵守）

1. **观察**：`list-windows` 找目标窗口 → `find`/`snapshot` 读控件（`tree` 很重，非必要不用）。
2. **定位**：优先拿 `elementId`（`uia:rt:...`），只有 UIA 读不到的元素才退回 `screenshot` + `ocr` 拿屏幕坐标。
3. **执行**：`click` / `type-text` / `set-value` / `keypress` / `invoke` …（输入类操作返回 `ok` 只代表"已发送"，不代表界面已变化）。
4. **确认**：`wait-for`（等元素/窗口/文字出现）或再 `find`/`screenshot` 复查。没看到预期变化就重新观察，**不要盲目重放**。

## 常用命令速查

```bash
W='node %USERPROFILE%/.workbuddy/skills/windows-computer-use/bin/wcu.mjs'

# 1. 环境与窗口
$W health
$W list-windows --max-windows 60            # 每项含 pid/hwnd/标题/包围盒/isOffscreen

# 2. 读界面（三种粒度，优先用最省的）
$W find --pid 1234 --query "保存"            # 按名字/文本找，返回 elementId + 包围盒
$W snapshot --pid 1234 --max-depth 4 --max-nodes 120 --include-screenshot false
$W tree --pid 1234 --max-depth 6 --max-nodes 300

# 3. 操作
$W click --pid 1234 --id "uia:rt:42-1182694"              # 先点击再输入，确保控件拿到焦点
$W type-text --pid 1234 --id <id> --text "内容" --method clipboard   # 中文/长文本用 clipboard（默认 auto 也会走剪贴板）
$W set-value --pid 1234 --id <id> --value "直接赋值"
$W keypress --pid 1234 --key "ctrl+s"                     # 或 --keys ctrl,shift,tab；不支持 Win 键
$W invoke --pid 1234 --id <id>                            # 按钮/菜单项首选，不移动鼠标
$W activate-window --pid 1234
$W launch-app --target notepad.exe            # 或已安装应用的路径/AUMID
$W wait-for --pid 1234 --condition element --query "已保存" --timeout-ms 5000
$W close-window --pid 1234                    # 发 WM_CLOSE，让应用自己保存/拒绝

# 4. 视觉兜底（UIA 盲区：游戏、自绘 Qt/Tk、canvas、RDP）
$W screenshot --pid 1234 --max-width 1400     # -> result.screenshot.path
$W ocr --pid 1234 --query "提交" --resolve-control true   # 文字 + 词框屏幕坐标 + 命中的控件
```

完整参数表：`docs/tools.md`（每个 action 的字段、取值、默认值）。

## 硬规则（违反会出事故)

- **不猜坐标**：能拿到 `elementId` 就不要用 x/y；坐标只作最后手段，且必须来自同一次 `screenshot`/`ocr` 的 `imageBounds`，并注意 `imageScale` 缩放比。
- **输入前先聚焦**：后台窗口直接 `type-text` 往往打不进目标控件。正确顺序是 `click --id`（或 `focus --id`）→ `type-text`。
- **一次一步**：每次只做一个动作，然后确认；不做"连点 10 次再说"。
- **`ok:true` ≠ 成功**：输入类结果里的 `verified:false`/`method:postmessage` 都表示未确认，必须用 `wait-for` 或复查确认。
- **敏感操作先问**：发送消息、提交表单、支付、删除、修改账户设置、安装软件——除非用户明确要求该步骤。
- **绝不代填密码/验证码**：让用户自己输入，或提示用户接管。
- **别碰管理员/UAC 窗口**：提权弹窗无法自动化，直接告知用户。
- **不打断用户**：能用 `invoke`/`set-value` 在后台完成的，不要 `click` 抢前台；确实需要真鼠标键盘时，动作会临时借用前台再归还，向用户说明即可。
- **被 Esc 停下就停手**：返回 `COMPUTER_USE_STOPPED_BY_USER` / `paused:true` 时，同一轮不许重试、不许绕路换坐标；只在用户明确要求继续时 `wcu resume`。

## 排错

| 现象 | 处理 |
|---|---|
| 首次调用慢（1–3s） | 正常：冷启动 PowerShell 引擎 + 提示条助手（C# 编译）；后续走常驻后端 |
| 操作`ok:false` / `WCU_BACKEND_EXITED` | 后端崩了：`wcu status` → `wcu stop` → 重新调用（会自动重启） |
| 卡住不返回 | `wcu stop` 强停；看 `.runtime/daemon.log` 尾部 |
| 一直返回 `COMPUTER_USE_PAUSED` | 之前按过 Esc：`wcu resume`（或等 10 分钟自动过期） |
| 看不到提示条 | `wcu preview` 试一下；`wcu takeover status` 看 `helper.ready`；`.runtime/daemon.log` 搜 takeover |
| Esc 按了没反应 | 提示条未 armed（动作已结束）属正常；确认 `helper.armed=true` 时再按 |
| 树很浅 / `hint` 提示 UIA 稀疏 | 该应用无无障碍树：改 `screenshot` + `ocr` |
| 窗口找不到 | 可能是最小化（`isOffscreen`）或标题变了：`list-windows --include-invisible true` |
| 中文打不进去 | 用 `--method clipboard`，或用 `--text-file` 传文本文件 |
| 一律报 `No top-level window matched` | 目标窗是子窗（如 LabVIEW 的 `LVDChild`，父窗 0×0）：**去掉所有 target 参数**，改 `screenshot --scope desktop` + 绝对坐标点击 |
| 焦点跑掉 / 前台被抢 | 目标窗口 `activate:true` 需显式加 `--activate true`；否则默认"借前台再归还" |
| 截图占空间 / 想马上清掉 | `wcu clean`（30 分钟、40 张内本就会自动清） |

## 实战要点：Qt 自绘应用（微信 / QQ / 钉钉）

这类应用（窗口类名形如 `Qt51514QWindowIcon`）的 UIA 树几乎是空的（只有 `Window` + 几个 `Pane`），全部界面自绘，**不要指望 elementId**，按下面的路子走：

1. `screenshot` → `ViewImage` 看真实界面，确认当前在哪个会话/页面。
2. 用 `ocr --query "文字"` 拿 **屏幕坐标** 的 word box，点它的中心（坐标比眼看截图可靠）。
3. 输入框类控件：先点准输入框内部再输入；点偏了不会报错，但文字会进空气。输入后**必须截图确认**再发送。
4. 中文输入：`--method clipboard`（富文本编辑器）或 `--method sendinput`；两者都无效 = 焦点没拿住，回到上一步重新点。
5. 抽屉式搜索结果（微信搜索）常是独立浮层窗且被主窗遮挡（点击会报 `POINT_COVERED`）→ 改键盘：输入后 `keypress enter` 打开第一条结果。
6. 托盘隐藏的窗口（`isOffscreen: true`）`activate_window` 无效（只处理最小化），重新 `launch-app` 该程序更省事。

**坐标换算铁律**：截图返回的 `bounds` + `imageScale` 才是真值（`screen = bounds.origin + 图像像素 / imageScale`）。查看器显示时会缩放，凭"眼睛里的像素"算坐标必错。

## 实战要点：LabVIEW 等 NI 应用（`LVDChild` 子窗）

窗口结构特殊：主窗类名 `LVDChild`，父窗 `LVFrame` 尺寸 **0×0**。因此**所有带 target 的动作都会报 `No top-level window matched`**（`activate-window` / `screenshot` / `tree` / `snapshot` / `find` 全中）。这不是"不能自动化"，是身份判定不合格。

**配方：不指定窗口 + 全屏截图 + 绝对坐标。**

```bash
W='node %USERPROFILE%/.workbuddy/skills/windows-computer-use/bin/wcu.mjs'
$W screenshot --scope desktop                          # 不查 UIA，直出整屏
$W double-click --x 1208 --y 707                       # 开近期文件 / 点控件
$W type-text --text "2.0"                              # 改值
$W keypress --key "enter"                              # 或 ctrl+r 运行 / ctrl+e 切框图 / ctrl+z 撤销
```

- 加 `--hwnd/--pid` 就会重新掉进上面的错误，**一个 target 参数都别加**。
- `alt+tab` **无效**：SendKeys 发完会把前台还原。切窗口请点任务栏，或先 `health` 看 `activeWindow`。
- 选板/对话框会**跟着鼠标重新弹出**，每轮都要重新截图定位，不要复用旧坐标。
- **选板搜索按本地化名称建索引**：简体中文版搜英文名必然 0 命中，要用 `等待下一个` / `数值常量` 这类中文词。
- 选板是**非激活工具窗**，点它不夺焦点 → `type-text` 会贴到画布上成自由标签，`ctrl+z` 撤销。
- `Ctrl+Space`（Quick Drop）被中文输入法占用，用不了。
- **动手前先备份**：实测中进程会中途重启，未保存的改动全部丢失。

完整案例、已验证/未打通清单：`docs/case-labview.md`。

## 目录

```
bin/wcu.mjs                  CLI + 常驻后端管理（唯一入口）
lib/takeover.mjs             提示条/Esc 助手桥（命名事件 + 全局钩子）
scripts/windows-uia.ps1      UI Automation 引擎（Windows 自带 PowerShell 5.1，无需安装依赖）
scripts/windows-takeover.ps1 提示条与 Esc 监听助手（+ .cs 渲染层）
takeover.json                提示条配置（开关/文案/位置/停止键）
docs/tools.md                每个 action 的完整参数表
docs/case-labview.md         LabVIEW / NI 应用案例（LVDChild 子窗绕行法、选板中文搜索、已验证清单）
test/selftest.mjs            自检：14 步，起一个独立 WinForms 窗口验证全链路
test/fixture.ps1             自检用的窗口（不碰用户任何程序）
.runtime/                    daemon.log / daemon.pid / paused.json / shots（运行产物，可随时删）
.runtime/shots/              截图与 OCR 图的落盘处（30 分钟自动过期）
LICENSE, THIRD_PARTY.md      上游 MIT 许可与来源
```

自检：`node "$SKILL/test/selftest.mjs"`（在本机验证引擎是否健康）。

## 与上游 DSH 插件的差异

本技能由 [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)（MIT）改造而来：

- **保留**：完整的 PowerShell UIA 引擎（25 个能力：控件树、点击、输入、窗口、截图、OCR、wait_for 等），原样 vendor，未改一行；提示条与 Esc 助手（`windows-takeover.ps1/.cs`）保留，只把指针标签从 `DSH` 改成可配的 `AI`、默认文案改成中文 `AI 正在控制电脑`。
- **替换**：MCP stdio 服务 → `bin/wcu.mjs` 命令行 + 常驻后端（进程内复用，不再需要 MCP 客户端）；DSH 的"操作系列/轮次"概念 → 单次动作 + Esc 后的暂停态（`.runtime/paused.json`，10 分钟 TTL 或 `wcu resume` 解除）。
- **去掉**：DSH 的设置页/工具开关、浏览器 CDP 通道（网页任务交给 `workbuddy-browser-use`，桌面兜底由本技能负责）。
- **新增**：`status`/`stop`/`resume`/`preview`/`abort`/`takeover on|off` 生命周期、提示条默认不进截图、`--text-file`、截图 base64 自动剥离、`--pid/--hwnd/--id` 简写、14 步自检。
