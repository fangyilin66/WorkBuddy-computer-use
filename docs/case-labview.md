# 案例：LabVIEW / NI 自绘应用（LVDChild 子窗）

> 适用对象：LabVIEW、Multisim、NI MAX 等 National Instruments 桌面程序。这类程序的窗口结构违反常规假设，套用标准 UIA 流程一定失败。
> 本文件是实测结论，不是推测。验证时间 2026-11，LabVIEW 2026 Q3 简体中文版。

---

## 1. 症状：一开头就会卡住

```
$ wcu screenshot --hwnd 12454642
{"ok":false,"error":"No top-level window matched the requested target."}
```

`activate-window` / `tree` / `snapshot` / `find` 全部同样报错。`list-windows` 里却能看见它：

```
12454642  31724  'LabVIEW'  LVDChild  {x:638, y:336, width:1286, height:855}
 853794  31724  'LabVIEW'  LVFrame   {x:0,   y:0,   width:0,    height:0}
```

**根因**：主窗 `LVDChild` 是 `LVFrame` 的子窗，而父窗 `LVFrame` 尺寸是 **0×0**。引擎判定"顶层可见窗"时两者都不合格，于是永远匹配不上。窗口矩形本身是有效的，只是身份不合法。

**不要**因此下结论"这个程序无法自动化"——绕开"指定窗口"就能动。

---

## 2. 可行配方：不指定窗口 + 全屏截图

### 2.1 观察

```bash
wcu screenshot --scope desktop          # 不查 UIA，直出整屏
```

`bounds = {0,0,<屏宽>,<屏高>}`、`imageScale` 一般为 0.625（160% 缩放）。
`screen = 图像像素 / imageScale`（0.625 时就是 **×1.6**）。

### 2.2 输入：绝对坐标，**不带任何 target 参数**

```bash
wcu click        --x 1208 --y 707
wcu double-click --x 1208 --y 707
wcu click        --x 900  --y 800 --button right
wcu type-text    --text "2.0"           # 默认 clipboard-paste，中文可靠
wcu keypress     --key "ctrl+r"
```

不带 target 时，动作落在"最近给过输入的那扇窗"，正好是刚操作过的 LabVIEW 窗口。**只要加 `--hwnd/--pid`，就会重新掉进第 1 节的错误。**

### 2.3 把 LabVIEW 带到前台

- `activate-window` 用不了（同第 1 节）。
- `keypress --key "alt+tab"` **无效**：SendKeys 发完会把前台**还原**，等于没切。
- 可用：点任务栏图标；或先点它露出来的一小块可见区域（点击本身会让该窗激活并置顶）；或从别的程序点进去。
- 实测中有时它自己就成了前台（跑完 CLI 或新开窗口后）。**先 `health` 看 `activeWindow`，别瞎切。**

---

## 3. LabVIEW 特有的坑

### 3.1 `Ctrl+Space`（Quick Drop）被中文输入法吃掉
中文系统下 `Ctrl+Space` 是切输入法，LabVIEW 收不到。Quick Drop 这条路直接放弃。

### 3.2 选板搜索：**中文版必须用中文关键词**
LabVIEW 的选板搜索索引的是**本地化名称**。简体中文版里搜 `Wait Until Next ms Multiple` 是 **0 命中**——列表空，但搜索确实执行了。判断依据：

| 输入 | 列表 |
|---|---|
| 空关键词 | 全部条目（.NET容器、ActiveX容器、DAQmx换算名 …） |
| 英文名 | 空 |

正确关键词：`等待下一个`、`数值常量`、`仿真信号`、`波形图`。

### 3.3 选板搜索框抢不到键盘焦点
LabVIEW 的选板是**非激活工具窗**，点它不改变键盘焦点归属，焦点仍在前面板 → `type-text` 的粘贴会落到**前面板画布**上，变成一个自由标签。

- 表现：画布上多出你输入的几个字。
- 处理：`keypress --key "ctrl+z"` 撤销（LabVIEW 撤销对自由标签、控件值都有效）。
- 这是**已知未打通环节**：中文关键词还没成功送进搜索框。`--activate true`、`--method background`（要 target，拿不到）、`--method sendinput` 三种都试过，均未成功。

### 3.4 选板会跟着鼠标重新弹出
每次右键/点搜索，选板位置相对鼠标变化。**每次操作前重新截图定位**，不要复用上一轮的坐标。

---

## 4. 已验证可用的操作（2026-11 实测）

| 操作 | 命令 | 结果 |
|---|---|---|
| 打开近期文件 | `double-click --x --y` 点"所有近期文件"条目 | 窗口标题变为 `xxx.vi前面板`，VI 打开 |
| 改数值控件 | `double-click` 框内 → `type-text "2.0"` → `keypress enter` | 值 1.0→2，生效 |
| 运行 | `keypress --key "ctrl+r"` | 波形出现，幅值随之变化，Y 轴自动缩放 |
| 停止 | `click` 前面板「停止」按钮 | 停止运行 |
| 切前面板/框图 | `keypress --key "ctrl+e"` | 另一个窗口打开 |
| 调函数/控件选板 | 空白处 `click --button right` | 选板弹出，带搜索框 |
| 撤销误操作 | `keypress --key "ctrl+z"` | 自由标签/控件值撤销 |

**未打通**：在框图里放新节点 + 连线（卡在 3.3 的焦点问题）。拖拽图标到框图也未验证——选板坐标漂移，风险是把节点误丢进结构框内。

---

## 5. 收尾纪律

- **动手前先备份 `.vi`**。实测中 LabVIEW 进程中途重启过（pid 变化、窗口回到起始页），未保存的改动全部丢失。
- 全程**不按 Ctrl+S**，最后 `ctrl+z` 还原，磁盘文件保持原样。
- 收尾：`esc` 关选板 → 截图确认画布干净 → 告知用户"未保存，文件未变"。

---

## 6. 顺带：LabVIEWCLI 和 COM 都产不出 VI

如果目标是"生成 .vi"而不是"操作已有 VI"，这两条路都走不通，别再花时间：

- **LabVIEWCLI**（`ni-labview-command-line-interface`，本机在 `D:\NI_Circuit_Design_Suite_14_0\...\Shared\LabVIEW CLI\`）只有 7 个操作：`MassCompile / ExecuteBuildSpec / RunVI / CloseLabVIEW / CreateComparisonReport / RunVIAnalyzer / RunUnitTests`，第一个参数都是**已存在 VI 的路径**。它自己就是 VI 编的（`Operations\RunVI\` 里是 `.lvclass + RunOperation.vi`）。
- **COM / VI Server**：类型库 38 个类型、1465 个成员，可用方法只有 `GetPanelImage / SetControlValue / Run / PrintVIToRTF / SaveInstrument`，没有"新建节点/连线"。
- `.vi` 是二进制容器，只有编辑器能写。**能"运行"，不能"创作"。**
