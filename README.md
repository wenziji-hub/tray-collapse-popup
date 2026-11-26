# Tray Collapse Popup —— GNOME 托盘折叠（弹窗版）

把面板上越堆越多的 AppIndicator 托盘图标，收进一个**点开才出现**的弹窗里 —— 像 Windows 的
溢出区（那个小箭头）一样，平时只留一个小按钮，需要时再展开。

> ⚠️ **本仓库是 [fnidore/tray-collapse](https://github.com/fnidore/tray-collapse) 的修改版**（fork）。
> 上游把图标收进"在面板里横向铺开的抽屉"；本版本改成**浮层弹窗**，并补上了外观设置、
> 右键进设置、淡入淡出、鼠标离开自动收起等改动。许可同为 **GPL-2.0-or-later**。
> 改动清单见 [CHANGELOG.md](CHANGELOG.md)，技术细节见 [docs/how-it-works.md](docs/how-it-works.md)。

## 效果

```
平时：      [任务栏……]  [胶囊▭] [系统图标…]
点一下：              ┌──────────────────────┐
                      │ [图标] [图标] [图标] │   ← 浮层淡入，出现在面板上方
                      └──────────────────────┘
鼠标移开：  0.45 秒后淡出收起
```

- **点胶囊** → 浮层淡入（220ms）
- **鼠标在浮层上** → 保持打开；**移开** → 0.45 秒后淡出（300ms）收起
- **点图标** → 正常弹出该程序自己的菜单，鼠标移到菜单上也不会把浮层收走，菜单项、子菜单都可以正常点
- **菜单开着时点另一个图标** → 直接换成那个图标的菜单（不用点两次）
- **右键点胶囊** → 直接打开本扩展的设置
- **多显示器** → 每块屏的面板上都有胶囊（其他屏的面板需要 Dash to Panel），点哪块屏的，浮层就弹在哪块屏上
- **老式 XEmbed 图标（QQ 这类）** → 留在面板上，不收纳（原因见下文）

## 为什么不用 GNOME 的 PopupMenu（这是本项目最核心的一处）

GNOME 的弹出菜单**共用一套模态抓取**，而托盘图标**本身就是菜单按钮**（`PanelMenu.Button`）。
把一堆菜单按钮塞进另一个菜单里，两套抓取必然打架，实测四种组合都会坏：

| 尝试 | 结果 |
|---|---|
| 图标菜单保持登记 | 鼠标一碰图标，弹窗被 GNOME 的"切换菜单"逻辑关掉 |
| 收纳期间把图标菜单从菜单管理器摘掉 | 弹窗不关了，但**菜单项点不动**（被弹窗的抓取拦住） |
| 图标菜单打开后让弹窗收起 | 竞态：关弹窗会连带把图标菜单一起关掉 |
| 弹窗退出菜单管理器 + 自己实现点外关闭 | 菜单能开但留不住 |

最终方案：**不用菜单机制，自己画一个普通浮层**（`Main.layoutManager.addChrome` 的 actor）：

- 浮层本身不进任何菜单管理器 → 不占抓取
- 浮层里图标的菜单交给扩展自己的 `TrayMenuManager`（托盘语义）：菜单照常有抓取、菜单项能点；
  但**不做悬停切换**，菜单开着时点另一个图标会直接切到它的菜单。
  面板自带的管理器是「菜单栏」语义，在挤成一排的浮层里会出现"右键图标弹不出菜单"
  （详见 [docs/how-it-works.md](docs/how-it-works.md)）
- 点外关闭、鼠标离开关闭都自己实现（stage 上的 `captured-event` + 只在浮层打开时运行的轮询）
- 有菜单开着时不自动收起

老式 XEmbed 图标（QQ 等）**不收进浮层**：它们的菜单是应用自己画的 **X11 窗口**，
按图标在面板上的位置弹出；收进浮层后实测表现为"点了没反应"。
所以这类图标保留在面板上，行为与原来完全一致。

## 安装

要求：**GNOME Shell 42 / X11**（Ubuntu 22.04 默认环境）+ Ubuntu 自带的 AppIndicator 扩展。

```bash
git clone git@github.com:wenziji-hub/tray-collapse-popup.git
cd tray-collapse-popup
./install.sh
```

脚本会：编译 gsettings schema → 复制到 `~/.local/share/gnome-shell/extensions/` → 提示重启 Shell。
X11 下可以只重启 Shell（不丢窗口、不丢程序）：按 **Alt+F2**，输入 `r`，回车。

> 本扩展**沿用上游的 uuid**（`tray-collapse@fnidore.top`），所以安装会覆盖上游版本 —— 二选一，不能共存。

## 用法

| 操作 | 效果 |
|---|---|
| 左键点胶囊 | 展开/收起浮层 |
| 右键点胶囊 | 打开设置 |
| 点浮层里的图标 | 弹出该程序自己的菜单（正常可用） |
| 菜单开着时点另一个图标 | 直接换成那个图标的菜单 |
| 中键点图标 | 发送 SecondaryActivate（多数程序是显示/隐藏主窗口） |
| 鼠标移开 | 自动淡出收起 |
| `gnome-extensions prefs tray-collapse@fnidore.top` | 打开设置（等同右键胶囊） |

## 设置项

设置界面分四组：

| 分组 | 内容 |
|---|---|
| **通用** | 新出现的图标是否默认收进浮层 |
| **间距** | 浮层内图标间距、面板托盘图标内边距 |
| **弹窗外观** | **不透明度**（滑块）、**背景色**（取色器）、**圆角**、**上下留白** —— 改完立即生效 |
| **托盘图标** | 列出见过的所有图标，逐个切换"收进浮层 / 留在面板" |

也可以直接命令行改（同样是立即生效）：

```bash
S=~/.local/share/gnome-shell/extensions/tray-collapse@fnidore.top/schemas
export GSETTINGS_SCHEMA_DIR=$S
gsettings set org.gnome.shell.extensions.tray-collapse popup-opacity 0.85   # 0–1
gsettings set org.gnome.shell.extensions.tray-collapse popup-bg-color '#2e2e32'
gsettings set org.gnome.shell.extensions.tray-collapse popup-radius 12
gsettings set org.gnome.shell.extensions.tray-collapse popup-padding 6
```

动效与时序参数（改 `src/extension.js` 后重启 Shell 生效）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `FADE_IN_MS` | 180 | 展开动画时长（ms） |
| `FADE_OUT_MS` | 200 | 收起动画时长（ms） |
| `AUTO_HIDE_DELAY_MS` | 450 | 鼠标离开后多久开始收起（ms） |
| `POINTER_MARGIN` | 14 | 鼠标容差（px），胶囊与浮层之间的空隙不会误触发 |

## 已知限制

- **只适配 GNOME Shell 42 / X11**（上游也只声明 42）；其它版本未测试。
- **老式 XEmbed 图标不能收纳**（X11 窗口层级限制，见上文）。
- 浮层本身是"普通 actor"而非 GNOME 菜单，不能用键盘打开；图标菜单打开后，Esc / 方向键照常可用。
- 沿用上游 uuid，安装会覆盖上游版本。

## 卸载

```bash
./uninstall.sh
# 或手动
gnome-extensions disable tray-collapse@fnidore.top
rm -rf ~/.local/share/gnome-shell/extensions/tray-collapse@fnidore.top
```

禁用/卸载会把所有图标**原样还原**回面板，不留残留。

## 署名与许可

- 上游项目：[fnidore/tray-collapse](https://github.com/fnidore/tray-collapse)（作者 **fnidore**），
  本仓库基于其发布版 **v2** 修改。
- 本仓库的改动：见 [CHANGELOG.md](CHANGELOG.md)。
- 许可：**GPL-2.0-or-later**（与上游一致），全文见 [LICENSE](LICENSE)。
