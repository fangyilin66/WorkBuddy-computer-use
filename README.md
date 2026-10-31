# WorkBuddy-computer-use

**简体中文** | [English](#english)

> 本项目由 [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)（DeepSeek Harness 的 Windows 电脑操控插件）**移植**而来，核心 PowerShell 引擎原样保留，外层改造为 [WorkBuddy](https://www.workbuddy.cn) 技能（Skill）形态。上游衍生自 [cgissing/windows-computer-use](https://github.com/cgissing/windows-computer-use)。

让 AI 直接"看"和"操作"真实的 Windows 桌面：读取任意窗口的控件树、按元素精确点击/输入/设值、截图、OCR 文字识别、管理窗口、启动程序。专为 WorkBuddy 的 Skill 体系设计，也可以独立作为命令行工具使用。

```
✅ 已在真实环境验证：微信 4.x（Qt 全自绘 UI）上完成"搜索联系人 → 打开会话 → 输入并发送消息"全流程
```

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 控件读取 | UI Automation 树 / 快照 / 按名字或文本查找元素 |
| 精确操作 | 点击、双击、拖拽、滚动、输入、设值、按键、Invoke——优先走元素 ID，不动鼠标 |
| 视觉兜底 | PrintWindow / 屏幕区域截图 + Windows.Media.Ocr 文字识别 + 词框屏幕坐标 |
| 等待确认 | `wait_for` 等窗口 / 元素 / 文字出现，返回明确的 `verification: observed` |
| 窗口管理 | 激活、移动、关闭（WM_CLOSE 优雅关闭）、启动应用 |
| 后台优先 | 能后台完成的动作（BM_CLICK、EM_REPLACESEL、UIA Pattern）绝不抢前台、不动鼠标 |
| 屏幕接管提示 | 操作时屏幕边缘光晕 + "AI 正在控制电脑"提示条 + 鼠标旁标签，且默认**不进入截图** |
| 随时可停 | 全局 Esc 立即中断正在执行的动作；也可 `wcu abort` 程序化停止 |
| 自清理 | 截图落在本技能目录内，30 分钟自动过期 + 数量上限 + `wcu clean` 手动清空 |

共 25 个动作，完整参数表见 [`docs/tools.md`](docs/tools.md)。

## 工作原理

```
WorkBuddy Agent
   │  bash: node bin/wcu.mjs <action> [--flag value ...]
   ▼
bin/wcu.mjs（CLI + 常驻后台进程，命名管道单例，动作串行排队）
   │  JSON lines
   ▼
scripts/windows-uia.ps1（PowerShell 5.1 引擎，UIA + SendInput + 截图 + OCR）
   │
   └── lib/takeover.mjs → scripts/windows-takeover.ps1/.cs
       （屏幕提示条 + 全局 Esc 钩子，通过命名事件通知引擎取消）
```

- **无第三方依赖**：只用 Windows 自带 PowerShell 5.1 与 Node.js 标准库。
- **常驻加速**：引擎以 `-Persistent` 模式长驻，冷启动约 1–3 秒，之后每个动作 20–200ms；30 分钟空闲自动退出。
- **本地处理**：截图、OCR、控件读取全部在本机完成，不上传任何数据。

## 安装

### 环境要求

- **Windows 10 2004+ / Windows 11**（提示条的截图排除依赖 `WDA_EXCLUDEFROMCAPTURE`，旧系统会自动降级为"截图里可见"）
- PowerShell 5.1（系统自带，无需安装）
- Node.js ≥ 20（WorkBuddy 内置运行时即可）
- 已安装并登录 WorkBuddy（作为 Skill 使用时）

### 方式一：命令行克隆（推荐，便于后续更新）

```bash
# 1. 克隆到 WorkBuddy 用户技能目录（目录名必须保持 windows-computer-use）
git clone https://github.com/fangyilin66/WorkBuddy-computer-use.git "%USERPROFILE%\.workbuddy\skills\windows-computer-use"

# 2. 验证引擎可用（首次会拉起后台进程，约 1–3 秒）
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" health

# 3. （可选）看一眼屏幕接管提示条长什么样
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" preview

# 4. 重启 WorkBuddy（或重新打开会话），技能即可被自动发现
```

以后想更新技能，在同一个目录里 `git pull` 即可。

安装后，在 WorkBuddy 里直接说"帮我在 XX 软件里点一下/输入/看看屏幕上有什么"，技能会自动触发。

### 方式二：下载 ZIP，在 WorkBuddy 面板里上传

不想碰命令行也没关系：GitHub 页面右上角 **Code → Download ZIP** 下载整个项目，然后

1. 打开 WorkBuddy → **技能 → 添加技能 → 上传技能**
2. 把下载好的压缩包直接拖进去
3. 面板会解压并自动识别技能（识别成功后重启 WorkBuddy 或新开一个会话即可用）

> 上传入口随 WorkBuddy 版本略有差异，如果你的版本里找不到这个入口，用上面的方式一（命令行）一样可以。
> 另外，GitHub 打包出来的顶层目录叫 `WorkBuddy-computer-use-main`，多数面板能自动处理这层目录；若导入后提示"未识别到技能"，把压缩包解压出来，把里面的 `windows-computer-use` 文件夹整个放到 `%USERPROFILE%\.workbuddy\skills\` 下即可（目录名必须是 `windows-computer-use`）。

### 快速上手

```bash
W='node %USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs'

$W list-windows --max-windows 60          # 列出所有可见窗口
$W find --pid 1234 --query "保存"          # 按文字找控件，返回 elementId
$W click --pid 1234 --id "uia:rt:42-123"   # 点击元素（不移动鼠标）
$W type-text --pid 1234 --id <id> --text "你好" --method clipboard
$W screenshot --pid 1234 --max-width 1400  # 截图，返回本地路径
$W ocr --pid 1234 --query "提交"           # OCR 定位屏幕文字
```

### 自检

```bash
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\test\selftest.mjs"
```

自检会启动一个独立的 WinForms 窗口（不碰你的任何程序），跑 14 步全链路验证，结束时自动清理。

## 卸载

```bash
# 1. 停掉常驻后台（引擎 + 提示条助手）
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" stop

# 2. （可选）清空运行产物（截图、日志、暂停状态）
node "%USERPROFILE%\.workbuddy\skills\windows-computer-use\bin\wcu.mjs" clean --all

# 3. 删除技能目录
rmdir /s /q "%USERPROFILE%\.workbuddy\skills\windows-computer-use"
# 或 PowerShell: Remove-Item -Recurse -Force "$env:USERPROFILE\.workbuddy\skills\windows-computer-use"

# 4. 重启 WorkBuddy
```

卸载不会遗留任何系统级改动：技能不写注册表、不装服务、不添加开机自启，所有文件都在技能目录内（截图在 `.runtime\shots\`，随目录一起删除）。

> 如果你是用"上传 ZIP"的方式装的，在 WorkBuddy 的技能面板里移除即可；面板没提供移除入口时，按上面的步骤删掉 `windows-computer-use` 文件夹同样能卸载干净。

## 注意事项

**安全**

- Agent 可以真实地移动鼠标、敲击键盘、点击按钮。涉及**发送消息、提交表单、支付、删除、修改账户设置**时，务必先向用户确认——这是技能内置的硬规则，也应该是每个使用者的底线。
- 按 **Esc** 随时中断当前动作；中断后同一轮不会重试，需要 `wcu resume` 解除。
- 无法操作管理员权限（UAC）窗口；不要试图绕过。
- 助手装有全局键盘钩子（这正是 Esc 生效的机制）。部分安全软件可能提示，属预期行为；Agent 自己合成的按键不会触发停止（防止自我中断）。

**隐私**

- 截图与 OCR 全部本地处理。截图默认**不进入** Agent 拍到的画面（`WDA_EXCLUDEFROMCAPTURE`），但你屏幕上看得见。
- 截图文件落在本技能 `.runtime\shots\`，30 分钟自动过期、最多保留 40 张、`wcu clean` 立即清空。若对截图留存有顾虑，可将 `WCU_SHOT_TTL_MS` 调小或用后手动清理。

**兼容性**

- Win32 / WinForms / WPF / Electron 应用支持最好；**Qt 自绘应用（微信 4.x、QQ、钉钉）UIA 树为空**，需走截图 + OCR + 坐标路线（技能内已内置该实战流程）。
- 游戏、DirectX 全屏、RDP 内部窗口同样依赖 OCR 兜底。
- 多显示器支持（虚拟屏幕坐标、DPI 感知）。

## 贡献

欢迎 Issue 与 PR！

1. Fork → 新建分支（`feat/xxx` 或 `fix/xxx`）
2. 改动后跑自检：`node test/selftest.mjs`（14 步必须全绿）
3. 引擎层（`scripts/windows-uia.ps1`）改动请同步更新 `docs/tools.md` 的参数表
4. 提交 PR，说明动机、改动点与验证方式

方向建议：更多应用的适配经验（尤其 Qt/自绘 UI）、OCR 兜底策略、新的后台派发路径、文档改进。涉及上游引擎的行为变化请先在上游仓库讨论。

> 我目前还是学生，Issue 和 PR 的回复可能会慢一些，请多包涵；也欢迎直接开 Issue，我会尽量及时处理。

## 许可证

[MIT](LICENSE) — 与上游 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 一致。

版权链：`cgissing/windows-computer-use`（原始引擎）→ `Yu-tao-Li/dsh-computer-use-win`（DSH 适配与大幅扩展）→ 本项目（WorkBuddy Skill 移植）。详见 [THIRD_PARTY.md](THIRD_PARTY.md)。

---

<a id="english"></a>
## English

**WorkBuddy-computer-use** is a port of [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) (a DeepSeek Harness plugin, which itself derives from [cgissing/windows-computer-use](https://github.com/cgissing/windows-computer-use)) into a [WorkBuddy](https://www.workbuddy.cn) Skill. The PowerShell UIA engine is vendored unchanged; the MCP layer was replaced by a CLI + resident daemon so every capability is callable from an agent's shell tool.

**Install**: clone into `%USERPROFILE%\.workbuddy\skills\windows-computer-use`, then run `node bin/wcu.mjs health` to verify — or skip the command line entirely: **Code → Download ZIP** on GitHub, then upload the archive in WorkBuddy → Skills → Add skill → Upload skill (if the panel does not pick it up, unzip and drop the `windows-computer-use` folder into `%USERPROFILE%\.workbuddy\skills\`). **Uninstall**: `node bin/wcu.mjs stop && node bin/wcu.mjs clean --all`, then delete the folder — nothing is written outside the skill directory. **Safety**: the agent really moves your mouse and types; confirm before any send/pay/delete action, press **Esc** anytime to abort. Screenshots stay local and auto-expire after 30 minutes. **License**: MIT (same as upstream), see [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md) for the full provenance chain. Contributions welcome — run `node test/selftest.mjs` before submitting PRs.
