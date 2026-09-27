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
- 所以"收纳"的本质就是 **reparen（重新挂父节点）**：把 `.container` 从面板右盒摘下来，
  挂到我们自己的盒子里；展开时再挂回去。搬的是**同一个 actor**，
  菜单、点击、动态更新全都原样保留。

## 2. 为什么不能用 PopupMenu 做弹窗

GNOME 的弹出菜单由一个 `PopupMenuManager` 统管（`Main.panel.menuManager`），要点：

```js
// popupMenu.js —— 菜单打开时压入一个模态抓取
_onMenuOpenState(menu, open) {
    if (open) {
        this._grab = Main.pushModal(menu.actor, this._grabParams);
        this.activeMenu = menu;
        oldMenu?.close(...);            // 关掉上一个菜单
    }
}

// 同一个文件 —— 鼠标进入"另一个菜单源"就切换菜单
_onCapturedEvent(actor, event) {
    if (event.type() === Clutter.EventType.ENTER) {
        let hoveredMenu = this._findMenuSource(targetActor);   // 沿父节点往上找
        if (hoveredMenu && hoveredMenu !== menu)
            this._changeMenu(hoveredMenu);
    }
}
```

把托盘图标（本身就是菜单按钮）放进另一个菜单里，会出现两种必然的坏结果：

1. **鼠标一碰图标，外层菜单被关掉** —— `_onCapturedEvent` 把图标当成"另一个菜单源"，
   于是 `_changeMenu` 关掉我们的菜单去开图标的菜单。
2. **不让它关，菜单项就点不动** —— 如果把图标的菜单从 `menuManager` 摘掉（这样
   `_findMenuSource` 找不到它、不会再触发切换），那它自己就没有模态抓取了；
   而我们的菜单有 → 点菜单项时事件被我们菜单的抓取拦掉，表现为"菜单看得见，点任何一项都没反应"。

顺带说明：`PopupMenu.open()` 里还有 `if (this.isEmpty()) return;` ——
**菜单内容为空时干脆不打开**。所以"点了没反应"有时是正常的（那个程序本身没有托盘菜单项）。

## 3. 本版本的做法：自绘浮层

```
Main.layoutManager.addChrome(overlay, { affectsInputRegion: true, affectsStruts: false })
```

- 一个普通的 `St.BoxLayout`，**不注册进任何菜单管理器** → 没有模态抓取、
  也不会触发"切换菜单"的逻辑
- 位置自己算：取胶囊的屏幕坐标，浮层放在它上方（面板在下半屏时），
  并夹在显示器范围内
- **点别处关闭**：浮层打开时在 `global.stage` 上挂一个 `captured-event`，
  点到浮层/胶囊之外就收起
- **鼠标离开自动收起**：每 250ms 用 `global.get_pointer()` 查一次指针
  （这是本地调用，不会像同步 D-Bus 那样堵住主循环），离开超过 450ms 才收，
  容差 14px —— 覆盖"胶囊 → 浮层"之间的空隙
- **有菜单开着就不收**：既看自己挂钩的图标菜单计数，也直接查
  `Main.panel.menuManager.activeMenu` —— 后者能覆盖右键菜单等所有 GNOME 菜单。
  否则鼠标移向菜单的途中浮层会先跑掉，菜单项就点不到了
- **淡入淡出**：Clutter `ease({opacity})`；收起时带一个 280ms 兜底定时器，
  保证动画即使被打断也最终 `hide()`，不会卡在半透明状态
- **外观用内联样式**：`overlay.set_style(...)` 而不是只写进 `stylesheet.css` ——
  内联样式优先级最高，不会被主题或其它扩展的样式覆盖

## 4. 老式 XEmbed 图标为什么不能收纳

这类图标的菜单**不是 GNOME 画的**，而是应用自己弹的一个 **X11 窗口**。
X11 窗口永远画在 GNOME Shell 的 UI **下面**，而浮层是 UI 的一部分 ——
图标一收进浮层，它的菜单就被浮层挡住，用户看到的就是"点了没反应"。

所以在 `_shouldCollapse()` 里对 `legacy:` 开头的 id 直接返回 `false`：这类图标留在面板上，
菜单行为与原来完全一致。

## 5. 调试这类问题的经验

- **改扩展代码后必须重启 Shell**：`gnome-extensions disable/enable` **不会**重新读 `.js`
  （GJS 有模块缓存）。只有设置（dconf/gsettings）是即时生效的。
- 想知道"扩展到底看到了什么"，最省事的办法是**临时加 `log()`**（本仓库的提交历史里有这种做法），
  重启后从 `journalctl` 里看；比盯着屏幕猜快得多。
- **不要**在扩展里做同步 D-Bus 调用：扩展和锁屏界面在同一个进程、同一条主循环里，
  一次同步调用卡住就是"整个桌面没反应，连输密码都不行"。
  需要跨进程查询时用异步调用（`Gio.DBus.session.call(...)` + 回调）。
- 用 `xdotool` + `scrot` 可以写自动化验证脚本（例如"鼠标移开后浮层是否收起"），
  但**做像素判断时要小心**：别的窗口（浏览器、编辑器）也会动，容易误判。
