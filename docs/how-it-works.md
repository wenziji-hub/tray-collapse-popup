# 原理与踩坑记录

这份文档记录本修改版的实现思路，以及**为什么不能简单地用 GNOME 自带的弹出菜单**。
给想改这个扩展的人（包括未来的我）留个路标。

## 1. 托盘图标在 GNOME 里长什么样

- 托盘桥是 Ubuntu 自带的 **`ubuntu-appindicators@ubuntu.com`** 扩展：
  - SNI 图标（`org.kde.StatusNotifierItem`）：`Main.panel.statusArea['appindicator-<uniqueId>']`
  - 老式 XEmbed 图标：`Main.panel.statusArea['appindicator-legacy:<窗口类>:<pid>']`
- 每个托盘图标**本身就是一个 `PanelMenu.Button`**（appindicator 的
  `IndicatorStatusIcon extends BaseStatusIcon extends PanelMenu.Button`），
  真正挂在面板上的是它的 `.container`（`St.Bin`）。
- 所以"收纳"的本质就是**重新挂父节点**：把 `.container` 从面板右盒摘下来，
  挂到我们自己的盒子里。搬的是**同一个 actor**，菜单、点击、动态更新全都原样保留。

## 2. 为什么不能用 PopupMenu 做弹窗

GNOME 42 的弹出菜单由 `PopupMenuManager` 统管（`Main.panel.menuManager`），要点：

```js
// popupMenu.js —— 菜单打开时把输入抓到菜单 actor 上
_onMenuOpenState(menu, open) {
    if (open) {
        this._grab = Main.pushModal(menu.actor, this._grabParams);
        this.activeMenu = menu;
        oldMenu?.close(...);            // 关掉上一个菜单
    }
}

// 同一个文件 —— 挂在每个菜单 actor 的 captured-event 上
_onCapturedEvent(actor, event) {
    if (event.type() === Clutter.EventType.ENTER) {
        let hoveredMenu = this._findMenuForSource(targetActor);   // 沿父节点往上找
        if (hoveredMenu && hoveredMenu !== menu)
            this._changeMenu(hoveredMenu);                       // 悬停即切换
    } else if (BUTTON_PRESS && !actor.contains(targetActor)) {
        menu.close(...);                                         // 点在菜单外：关掉
    }
}
```

把托盘图标（本身就是菜单按钮）放进另一个 PopupMenu 里，会出现两种必然的坏结果：

1. **鼠标一碰图标，外层菜单被关掉** —— 图标被当成"另一个菜单源"，`_changeMenu` 关掉外层菜单去开图标的菜单。
2. **不让它关，菜单项就点不动** —— 输入被外层菜单的抓取拦住。

顺带说明：`PopupMenu.open()` 里有 `if (this.isEmpty()) return;` ——
**菜单内容为空时干脆不打开**。所以有的图标"点了没反应"是正常的（那个程序没有托盘菜单项）。

## 3. 本版本的做法：自绘浮层 + 托盘语义的菜单管理器

```
Main.layoutManager.addChrome(overlay, { affectsInputRegion: true, affectsStruts: false })
```

- 浮层是一个普通的 `St.BoxLayout`（reactive，点在空白处不算点到外面），**不进任何菜单管理器**，
  自身没有模态抓取。
- 位置：打开时记下胶囊的屏幕位置，浮层放在它上方（面板在下半屏时）并夹在显示器范围内。
  之后面板被智能隐藏也不跟着跳。
- **点别处关闭**：没有菜单开着时，在 `global.stage` 的 `captured-event` 上判断；
  有菜单开着时 stage 收不到这些事件（见第 4 节），由 `TrayMenuManager` 处理。
- **鼠标离开自动收起**：浮层打开期间每 150ms 用 `global.get_pointer()` 查一次指针，
  离开超过 450ms 才收（容差 14px，覆盖胶囊与浮层之间的空隙）；菜单开着时不收。收起后没有任何定时器。
- **淡入淡出**：`ease({opacity})`，状态分 hidden / shown / hiding 三种；淡出途中重新打开会直接打断淡出。
- **外观**：底色、不透明度、圆角、留白来自设置，用内联样式 `set_style()` 实时生效；边框和阴影在 `stylesheet.css`。

## 4. 右键图标"有时弹不出菜单"的根因（1.1.0 修复）

GNOME 42 的 `Main.pushModal()` 是 Clutter 抓取：菜单打开后，事件只沿抓取 actor（菜单）这条链分发，
**目标不在菜单里的点击不会再送到目标本身**。叠加第 2 节的两条规则：

1. 菜单 A 开着，鼠标划过图标 B → `ENTER` → 自动切到 B 的菜单；
2. 这时右键 B → 对 B 的菜单来说这是"点在菜单外" → **关掉 B 的菜单，这次点击被吞掉**。

在面板上这是"菜单栏"的正常手感；可浮层里的图标挨成一排，几乎每次换着点都会踩中，
表现就是"右键图标弹不出菜单，得再点一次"。

修法：收进浮层的图标，菜单从 `Main.panel.menuManager` 移到扩展自己的 `TrayMenuManager`。
它的抓取方式和 GNOME 一样（`pushModal(menu.actor)`），但用托盘语义：

- 不处理 `ENTER`：**不做悬停切换**；
- 点在菜单外时先看点的是不是另一个托盘图标：是 → 直接打开那个图标的菜单；
  点的是浮层空白处 → 只关菜单；点的是胶囊或屏幕其他地方 → 菜单和浮层一起收；
- Esc 关菜单、↓ 进入菜单，与 GNOME 一致。

中键要单独接：appindicator 的中键处理会去关 `Main.panel.menuManager.activeMenu`，
菜单不在那里时它会报错，所以由本扩展在图标的 `event` 信号上直接转发 `SecondaryActivate`。

## 5. appindicator 会把图标拽回面板

appindicator 在图标重新就绪（`ready`）时会再调一次 `Panel.addToStatusArea()`，
而 `_addToPanelBox()` 会**把 container 从当前父节点摘下、插回面板右盒，并把菜单重新交给面板的菜单管理器**。
所以扩展不能记"这个图标我搬过了"，而是在面板右盒每次 `actor-added` 后（合并到下一帧前执行），
按图标的**实际父节点和菜单归属**重新校正。校正可以重复执行。

## 5.5 多显示器：每块屏一个胶囊（1.2.0）

`Main.panel` 只在一块显示器上（GNOME 的主显示器，或 Dash to Panel 设置里的「主面板显示器」），
托盘图标也只挂在它上面。其他显示器的面板是 Dash to Panel 另外建的 standalone 面板。

- 图标只有一份，住在浮层里；浮层不属于任何面板，所以可以弹在任意一块屏上。
- 每个面板放一个胶囊按钮：主面板用 `Main.panel.addToStatusArea()`；其他面板用
  Dash to Panel 专门留给其他扩展的 `panel.addToStatusArea()`（见它的 panel.js，
  注释写着 *needed by other extensions to add elements to the secondary panel*）。
- Dash to Panel 重建面板（插拔显示器、改面板设置）时会销毁旧面板、发出 `panels-created`；
  旧胶囊随旧面板一起销毁，收到信号后（等它这一轮初始化做完）给新面板补上胶囊。
- 它可能比本扩展晚启用，或被关掉再打开，所以同时监听 `extension-state-changed`，
  `global.dashToPanel` 换了对象就重新连接。

## 6. 图标身份与 known-indicators

- 收纳名单和 `known-indicators` 用的 id 是 AppIndicator 上报的 `Id`
  （appindicator 要拿到 Id 才会把图标放上面板，跨重启稳定）；老式图标用 `legacy:<窗口类>`（去掉进程号）。
- **没有 Id 的图标一律不动、不记**：它要么还没就绪，要么正在销毁（应用退出时代理属性会先被清空）。
  1.0.0 在这里退回用 `uniqueId`，里面含 D-Bus 临时总线名 `:1.NNN`，每次都不一样；
  RustDesk 每重启一次托盘就多记一条，两个月涨到 800 多条。1.1.0 首次运行时会把这些条目清掉。
- 个别应用每次启动报随机 Id、但 Title 稳定：同 Title 且不在线的旧条目视为同一应用的旧身份，
  合并并迁移收纳设置；同 Title 而曾同时在线的（如两个"更新通知"）互记为 peers，永不合并。

## 7. 老式 XEmbed 图标为什么不收纳

这类图标的菜单**不是 GNOME 画的**，而是应用自己弹出的 X11 窗口，位置按图标在面板上的 X11 坐标算；
收进浮层后实测表现为"点了没反应"。所以 `legacy:` 开头的 id 固定留在面板上，行为与原来完全一致。

## 8. 调试这类问题的经验

- **改扩展代码后必须重启 Shell**：`gnome-extensions disable/enable` **不会**重新读 `.js`
  （GJS 有模块缓存）。只有设置（dconf/gsettings）是即时生效的。X11 下按 Alt+F2 → `r`。
- 想知道"扩展到底看到了什么"，最省事的办法是**临时加 `log()`**，重启后从 `journalctl` 里看。
- 对照 GNOME 源码：`gresource extract /usr/lib/gnome-shell/libgnome-shell.so /org/gnome/shell/ui/popupMenu.js`。
- **不要**在扩展里做同步 D-Bus 调用：扩展和锁屏界面在同一个进程、同一条主循环里，
  一次同步调用卡住就是"整个桌面没反应，连输密码都不行"。需要跨进程查询时用异步调用。
- 注意 GNOME 默认在锁屏时禁用扩展、解锁时再启用：`disable()` 必须把图标、菜单、信号、定时器全部还原，
  否则每锁一次屏就漏一份。
