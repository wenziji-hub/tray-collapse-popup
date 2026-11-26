// Tray Collapse Popup — GNOME Shell 42
//
// 把 AppIndicator 托盘图标收进一个浮层弹窗（类似 Windows 的托盘溢出区）：
// 面板上只留一个胶囊按钮，点开后图标浮在按钮旁边，鼠标离开自动收起。
//
// 设计要点（都是踩过坑才定下来的，改之前先读一遍）：
//
// 1. 浮层是普通 chrome actor，不是 PopupMenu。
//    PopupMenu 打开时会抢模态抓取，嵌在里面的托盘图标就弹不出自己的菜单。
//
// 2. 收进浮层的图标，菜单交给本扩展的 TrayMenuManager 管理，不再归面板的
//    Main.panel.menuManager。面板的管理器是「菜单栏」语义：某个菜单开着时，
//    鼠标划过别的按钮会自动切过去；而 GNOME 42 会把输入抓在当前菜单上，这时再
//    去点那个按钮，会被当成「点在菜单外」——菜单被关掉，这次点击也被吞掉。
//    浮层里的图标挨成一排，这就是「右键图标有时弹不出菜单」的根因。
//    TrayMenuManager 用托盘语义：不做悬停切换；菜单开着时点另一个图标，直接
//    打开那个图标的菜单；点到别处则菜单和浮层一起收起。
//
// 3. 位置靠「校正」而不是「记账」。appindicator 在图标重新就绪时会再调一次
//    Panel.addToStatusArea()，把图标从任何地方拽回面板，并把菜单重新交给面板
//    管理器。所以 _sync() 每次都按实际父节点和菜单归属重新校正，可以重复执行。
//
// 4. 图标身份用 AppIndicator 上报的 Id（appindicator 要拿到 Id 才把图标放上
//    面板）。没有 Id 的图标要么还没就绪、要么正在销毁（应用退出时代理属性会先
//    被清空），这类图标一律不动、不记。旧版本在这里退回用 uniqueId（含 D-Bus
//    临时总线名 :1.NNN，每次启动都变），RustDesk 每重启一次托盘就多记一条。
//
// 5. 老式 XEmbed 图标（legacy:*）固定留在面板：它们的菜单是应用自己画的
//    X11 窗口，按图标在面板上的位置弹出，放进浮层会错位。
//
// 6. 每块显示器的面板上都有一个胶囊。图标只有一份，住在浮层里；点哪块屏的胶囊，
//    浮层就弹在哪块屏上。主面板（Main.panel，托盘图标所在）只在一块显示器上，
//    其他显示器上的面板来自 Dash to Panel：用它专门留给其他扩展的
//    panel.addToStatusArea() 放胶囊；它重建面板时（插拔显示器、改面板设置）会发
//    'panels-created'，这里跟着重新放。

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;

const Main = imports.ui.main;
const BoxPointer = imports.ui.boxpointer;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const ROLE = 'tray-collapse';
const DASH_TO_PANEL_UUID = 'dash-to-panel@jderose9.github.com';
const APPINDICATOR_PREFIX = 'appindicator-';
const AUTO_HIDE_DELAY_MS = 450;   // 鼠标离开浮层多久后自动收起
const POINTER_POLL_MS = 150;      // 浮层打开期间检查鼠标位置的间隔（收起后不运行）
const POINTER_MARGIN = 14;        // 胶囊与浮层之间有空隙，移动途中不算离开
const OVERLAY_GAP = 6;            // 浮层与胶囊按钮之间的距离
const SCREEN_MARGIN = 8;          // 浮层与屏幕边缘的最小距离
const FADE_IN_MS = 180;
const FADE_OUT_MS = 200;

// legacy 图标的 id 形如 legacy:<窗口类>:<进程号>，进程号每次都变，去掉才是稳定键
function canonicalId(id) {
    const m = /^legacy:(.+):\d+$/.exec(String(id));
    return m ? `legacy:${m[1]}` : String(id);
}

function isLegacyId(id) {
    return String(id).startsWith('legacy:');
}

// 以 D-Bus 临时总线名（:1.NNN）开头的 id：旧版本误记的，跨重启没有意义
function isBusNameId(id) {
    return String(id).startsWith(':');
}

// 图标身份 {id, title}；没有可靠 id（还没就绪或正在销毁）时返回 null
function indicatorInfo(indicator) {
    const sni = indicator._indicator;          // SNI 图标才有（AppIndicator 对象）
    if (sni) {
        try {
            if (!sni.isReady || !sni.id)
                return null;
            const id = canonicalId(sni.id);
            return { id, title: sni.title ? String(sni.title) : id };
        } catch (e) {
            return null;                       // 代理已随应用退出被销毁
        }
    }

    // 老式 XEmbed 图标：uniqueId = legacy:<窗口类>:<进程号>
    let uniqueId;
    try {
        uniqueId = indicator.uniqueId;
    } catch (e) {
        return null;                           // 图标已被销毁
    }
    if (!uniqueId || !isLegacyId(uniqueId))
        return null;
    const id = canonicalId(uniqueId);
    return { id, title: id.slice('legacy:'.length) };
}

// 浮层里图标的菜单管理器（托盘语义，见文件头第 2 点）。
// 抓取方式与 GNOME 42 的 PopupMenuManager 相同：菜单打开时 pushModal 到菜单 actor。
var TrayMenuManager = class {
    constructor(host) {
        this._host = host;
        this._menus = new Set();
        this._grab = null;
        this.activeMenu = null;
    }

    has(menu) {
        return this._menus.has(menu);
    }

    addMenu(menu) {
        if (this._menus.has(menu))
            return;
        this._menus.add(menu);
        menu.connectObject(
            'open-state-changed', this._onOpenStateChanged.bind(this),
            'destroy', () => this.removeMenu(menu), this);
        menu.actor.connectObject(
            'captured-event', this._onCapturedEvent.bind(this), this);
    }

    removeMenu(menu) {
        if (!this._menus.has(menu))
            return;
        if (menu.isOpen)
            menu.close(BoxPointer.PopupAnimation.NONE);   // 走正常关闭流程，释放抓取
        if (this.activeMenu === menu) {                    // 兜底：菜单没发出关闭信号
            this.activeMenu = null;
            this._releaseGrab();
        }
        menu.disconnectObject(this);
        menu.actor.disconnectObject(this);
        this._menus.delete(menu);
    }

    destroy() {
        for (const menu of [...this._menus])
            this.removeMenu(menu);
        this._releaseGrab();
        this._host = null;
    }

    _releaseGrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onOpenStateChanged(menu, open) {
        if (open) {
            if (this.activeMenu === menu)
                return;
            const oldMenu = this.activeMenu;
            const oldGrab = this._grab;
            this._grab = Main.pushModal(menu.actor, { actionMode: Shell.ActionMode.POPUP });
            this.activeMenu = menu;
            oldMenu?.close(BoxPointer.PopupAnimation.FADE);
            if (oldGrab)
                Main.popModal(oldGrab);
        } else if (this.activeMenu === menu) {
            this.activeMenu = null;
            this._releaseGrab();
        }
        this._host?._onTrayMenuStateChanged();
    }

    _findMenuForSource(actor) {
        for (; actor; actor = actor.get_parent()) {
            for (const menu of this._menus) {
                if (menu.sourceActor === actor)
                    return menu;
            }
        }
        return null;
    }

    _onCapturedEvent(actor, event) {
        const menu = actor._delegate;
        const type = event.type();

        if (type === Clutter.EventType.KEY_PRESS) {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Down && global.stage.get_key_focus() === menu.actor) {
                actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Escape && menu.isOpen) {
                menu.close(BoxPointer.PopupAnimation.FULL);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        // 不处理 ENTER：浮层里不做悬停切换菜单
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        const target = global.stage.get_event_actor(event);
        if (actor.contains(target))
            return Clutter.EVENT_PROPAGATE;                // 点在菜单里：交给菜单项

        // 抓取期间这次按下不会再送达目标，所以在这里分流
        const other = this._findMenuForSource(target);
        const button = type === Clutter.EventType.BUTTON_PRESS
            ? event.get_button() : Clutter.BUTTON_PRIMARY;
        if (other && other !== menu && button !== Clutter.BUTTON_MIDDLE) {
            other.open(BoxPointer.PopupAnimation.FADE);   // 点另一个托盘图标：直接切过去
            if (!other.isOpen)                             // 它的菜单是空的，打不开
                menu.close(BoxPointer.PopupAnimation.FULL);
            return Clutter.EVENT_STOP;
        }

        menu.close(BoxPointer.PopupAnimation.FULL);
        if (!other)
            this._host?._onPressOutsideMenu(target);
        return Clutter.EVENT_STOP;
    }
};

// 面板上的胶囊按钮：只负责显示，点击交给 TrayCollapse
const CapsuleButton = GObject.registerClass(
class CapsuleButton extends PanelMenu.Button {
    _init(tray) {
        // dontCreateMenu：胶囊本身没有菜单，左键开关浮层，右键打开设置
        super._init(0.0, 'TrayCollapse', true);
        this._tray = tray;
        this.add_style_class_name('tray-collapse-button');
        this._icon = new St.Icon({
            gicon: tray.iconCollapsed,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);
        this.connect('button-press-event', (actor, event) => {
            this._tray.onCapsulePressed(this, event.get_button());
            return Clutter.EVENT_STOP;
        });
    }

    setExpanded(expanded) {
        this._icon.gicon = expanded ? this._tray.iconExpanded : this._tray.iconCollapsed;
        if (expanded)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
    }
});

var TrayCollapse = class {
    constructor(settings) {
        this._settings = settings;

        // 自带的胶囊 symbolic 图标（-symbolic.svg 会按主题前景色重新着色）
        this.iconCollapsed = Gio.icon_new_for_string(
            `${Me.path}/icons/tray-collapse-symbolic.svg`);
        this.iconExpanded = Gio.icon_new_for_string(
            `${Me.path}/icons/tray-expand-symbolic.svg`);

        // 浮层。reactive：点在图标之间的空白处不算「点到外面」
        this._drawer = new St.BoxLayout({ style_class: 'tray-collapse-drawer' });
        this._overlay = new St.BoxLayout({
            style_class: 'tray-collapse-popup',
            reactive: true,
            visible: false,
        });
        this._overlay.add_child(this._drawer);
        Main.layoutManager.addChrome(this._overlay, {
            affectsInputRegion: true,
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._state = 'hidden';       // hidden | shown | hiding
        this._anchorCapsule = null;   // 打开浮层的那个胶囊
        this._anchor = null;          // 打开时该胶囊的位置，浮层据此定位
        this._pointerWatchId = 0;
        this._outsideSince = 0;
        this._stagePressId = 0;
        this._syncLaterId = 0;
        this._capsuleLaterId = 0;
        this._destroyed = false;
        this._entries = new Map();    // 浮层里的图标 container -> { indicator, menu, eventId, destroyId }
        this._padded = new Map();     // 改过内边距的图标按钮 -> destroy 信号 id（禁用时还原）
        this._capsules = new Set();
        this._dashToPanel = null;     // 当前连接着的 global.dashToPanel
        this._dashToPanelId = 0;
        this._menuManager = new TrayMenuManager(this);

        this._applyPopupStyle();
        this._applyDrawerSpacing();

        this._settings.connectObject(
            'changed::collapsed-ids', () => this._queueSync(),
            'changed::pinned-ids', () => this._queueSync(),
            'changed::default-collapse', () => this._queueSync(),
            'changed::panel-hpadding', () => this._queueSync(),
            'changed::drawer-spacing', () => this._applyDrawerSpacing(),
            'changed::popup-opacity', () => this._applyPopupStyle(),
            'changed::popup-bg-color', () => this._applyPopupStyle(),
            'changed::popup-radius', () => this._applyPopupStyle(),
            'changed::popup-padding', () => this._applyPopupStyle(),
            this);

        // 新托盘图标出现，或 appindicator 把图标拽回面板时，都会触发校正
        Main.panel._rightBox.connectObject('actor-added', () => this._queueSync(), this);
        Main.overview.connectObject('showing', () => this._hideOverlay(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._hideOverlay({ animate: false }), this);
        Main.extensionManager.connectObject('extension-state-changed', (manager, extension) => {
            if (extension.uuid === DASH_TO_PANEL_UUID)
                this._watchDashToPanel();
        }, this);

        // 主面板上的胶囊：右侧盒子最靠左，紧挨托盘图标
        this._primaryCapsule = this._addCapsule(Main.panel);
        this._watchDashToPanel();
        this._queueSync();
    }

    // ── 胶囊（每个面板一个）────────────────────────────────────────

    _addCapsule(panel) {
        const capsule = new CapsuleButton(this);
        panel.addToStatusArea(ROLE, capsule, 0, 'right');
        this._capsules.add(capsule);
        capsule.connect('destroy', () => {
            this._capsules.delete(capsule);
            if (this._anchorCapsule === capsule) {
                this._anchorCapsule = null;
                if (!this._destroyed)
                    this._hideOverlay({ animate: false });
            }
        });
        return capsule;
    }

    // Dash to Panel 可能比本扩展晚启用，或被关掉再打开：跟着它的状态重新连接
    _watchDashToPanel() {
        const dashToPanel = global.dashToPanel || null;
        if (dashToPanel !== this._dashToPanel) {
            if (this._dashToPanel && this._dashToPanelId)
                this._dashToPanel.disconnect(this._dashToPanelId);
            this._dashToPanel = dashToPanel;
            this._dashToPanelId = dashToPanel
                ? dashToPanel.connect('panels-created', () => this._queueSecondaryCapsules())
                : 0;
        }
        this._queueSecondaryCapsules();
    }

    // 'panels-created' 发出时 Dash to Panel 还在初始化面板，等它这一轮做完再放
    _queueSecondaryCapsules() {
        if (this._destroyed || this._capsuleLaterId)
            return;
        this._capsuleLaterId = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._capsuleLaterId = 0;
            if (!this._destroyed)
                this._addSecondaryCapsules();
            return GLib.SOURCE_REMOVE;
        });
    }

    // 其他显示器上的面板（standalone），各放一个胶囊；旧面板销毁时胶囊随之销毁
    _addSecondaryCapsules() {
        for (const dtpPanel of this._dashToPanel?.panels || []) {
            const panel = dtpPanel.isStandalone ? dtpPanel.panel : null;
            if (!panel || typeof panel.addToStatusArea !== 'function' ||
                !panel.statusArea || panel.statusArea[ROLE])
                continue;
            try {
                this._addCapsule(panel);
            } catch (e) {
                logError(e, '[tray-collapse] add capsule to secondary panel');
            }
        }
    }

    onCapsulePressed(capsule, button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this._hideOverlay();
            ExtensionUtils.openPrefs();
        } else if (this._state === 'shown' && this._anchorCapsule === capsule) {
            this._hideOverlay();
        } else {
            this._showOverlay(capsule);   // 浮层开着时点另一块屏的胶囊：挪过去
        }
    }

    // ── 浮层显示 / 收起 ───────────────────────────────────────────────

    _showOverlay(capsule) {
        const moving = this._anchorCapsule !== capsule;
        if (this._state === 'shown' && !moving)
            return;
        const wasHidden = this._state === 'hidden';
        // 先改状态再打断淡出：淡出动画的 onStopped 看到 shown 就不会把浮层藏掉
        this._state = 'shown';
        this._overlay.remove_all_transitions();
        if (moving) {
            this._anchorCapsule?.setExpanded(false);
            this._anchorCapsule = capsule;
            this._anchor = this._captureAnchor(capsule);
        }
        if (wasHidden) {
            this._overlay.opacity = 0;
            this._overlay.show();
        }
        if (wasHidden || moving)
            this._positionOverlay();
        this._overlay.ease({
            opacity: 255,
            duration: FADE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        capsule.setExpanded(true);
        this._startPointerWatch();
        this._connectStagePress();
    }

    _hideOverlay({ animate = true } = {}) {
        this._stopPointerWatch();
        this._disconnectStagePress();
        if (this._state === 'hidden')
            return;

        // 浮层里的菜单不能比它的图标活得久，先体面地关掉
        this._menuManager.activeMenu?.close(BoxPointer.PopupAnimation.FADE);
        this._anchorCapsule?.setExpanded(false);
        this._anchorCapsule = null;

        this._state = 'hiding';
        this._overlay.remove_all_transitions();
        if (!animate) {
            this._finishHide();
            return;
        }
        this._overlay.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._finishHide(),
        });
    }

    _finishHide() {
        if (this._state !== 'hiding')
            return;                   // 淡出途中又被打开了
        this._overlay.hide();
        this._overlay.opacity = 255;
        this._state = 'hidden';
    }

    _captureAnchor(capsule) {
        const [x, y] = capsule.get_transformed_position();
        const [width, height] = capsule.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(capsule) ||
            Main.layoutManager.primaryMonitor;
        return { x, y, width, height, monitor };
    }

    // 以打开时记下的胶囊位置定位：面板后来被智能隐藏也不会跟着跳
    _positionOverlay() {
        const anchor = this._anchor;
        if (!anchor || !anchor.monitor)
            return;
        const { monitor } = anchor;
        const [, , width, height] = this._overlay.get_preferred_size();

        let x = Math.round(anchor.x + anchor.width / 2 - width / 2);
        x = Math.max(monitor.x + SCREEN_MARGIN,
            Math.min(x, monitor.x + monitor.width - width - SCREEN_MARGIN));

        // 胶囊在屏幕下半部（底部面板）时浮层放上方，否则放下方
        const above = anchor.y + anchor.height / 2 > monitor.y + monitor.height / 2;
        let y = above
            ? Math.round(anchor.y - height - OVERLAY_GAP)
            : Math.round(anchor.y + anchor.height + OVERLAY_GAP);
        y = Math.max(monitor.y, Math.min(y, monitor.y + monitor.height - height));

        this._overlay.set_position(x, y);
    }

    // 浮层打开期间才轮询鼠标；菜单开着时不收，菜单关上后若鼠标在外面就收起
    _startPointerWatch() {
        this._outsideSince = 0;
        if (this._pointerWatchId)
            return;
        this._pointerWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_POLL_MS, () => {
            if (this._state !== 'shown') {
                this._pointerWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._menuManager.activeMenu || this._pointerNear()) {
                this._outsideSince = 0;
                return GLib.SOURCE_CONTINUE;
            }
            const now = GLib.get_monotonic_time() / 1000;
            if (!this._outsideSince) {
                this._outsideSince = now;
            } else if (now - this._outsideSince >= AUTO_HIDE_DELAY_MS) {
                this._pointerWatchId = 0;
                this._hideOverlay();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPointerWatch() {
        if (this._pointerWatchId) {
            GLib.source_remove(this._pointerWatchId);
            this._pointerWatchId = 0;
        }
        this._outsideSince = 0;
    }

    _pointerNear() {
        const [px, py] = global.get_pointer();
        const near = actor => {
            if (!actor || !actor.mapped)
                return false;
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            return px >= x - POINTER_MARGIN && px <= x + w + POINTER_MARGIN &&
                   py >= y - POINTER_MARGIN && py <= y + h + POINTER_MARGIN;
        };
        return near(this._overlay) || near(this._anchorCapsule);
    }

    _isInside(actor) {
        if (!actor)
            return false;
        if (this._overlay.contains(actor))
            return true;
        for (const capsule of this._capsules) {
            if (capsule.contains(actor))
                return true;
        }
        return false;
    }

    // 没有菜单开着时，点到浮层和胶囊以外的地方就收起。
    // （菜单开着时 GNOME 42 的抓取让 stage 收不到这些事件，改由 TrayMenuManager 处理）
    _connectStagePress() {
        if (this._stagePressId)
            return;
        this._stagePressId = global.stage.connect('captured-event', (stage, event) => {
            const type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            if (!this._isInside(global.stage.get_event_actor(event)))
                this._hideOverlay();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _disconnectStagePress() {
        if (this._stagePressId) {
            global.stage.disconnect(this._stagePressId);
            this._stagePressId = 0;
        }
    }

    // TrayMenuManager 回调：菜单开着时点到了菜单以外、又不是别的托盘图标的地方
    _onPressOutsideMenu(target) {
        if (target && this._overlay.contains(target))
            return;                   // 浮层空白处：只关菜单
        this._hideOverlay();          // 胶囊或屏幕其他地方：菜单和浮层一起收
    }

    // TrayMenuManager 回调：菜单开关后重新开始离开计时
    _onTrayMenuStateChanged() {
        this._outsideSince = 0;
    }

    // ── 外观 ─────────────────────────────────────────────────────────

    _applyPopupStyle() {
        const s = this._settings;
        const opacity = Math.max(0, Math.min(1, s.get_double('popup-opacity')));
        let [ok, color] = Clutter.Color.from_string(s.get_string('popup-bg-color'));
        if (!ok)
            [, color] = Clutter.Color.from_string('#2e2e32');
        this._overlay.set_style(
            `background-color: rgba(${color.red}, ${color.green}, ${color.blue}, ${opacity});` +
            `border-radius: ${s.get_int('popup-radius')}px;` +
            `padding: ${s.get_int('popup-padding')}px 12px;`);
    }

    _applyDrawerSpacing() {
        this._drawer.set_style(`spacing: ${this._settings.get_int('drawer-spacing')}px;`);
    }

    // 面板图标的「宽间距」来自主题：每个 panel-button 左右各有内边距
    // （-natural-hpadding）。这里用内联样式覆盖托盘图标按钮，禁用时 set_style(null) 还原。
    _applyPanelPadding(items) {
        const px = this._settings.get_int('panel-hpadding');
        const style = `-natural-hpadding: ${px}px; -minimum-hpadding: ${px}px;`;
        for (const { indicator } of items) {
            if (indicator.get_style() !== style)
                indicator.set_style(style);
            if (!this._padded.has(indicator)) {
                const id = indicator.connect('destroy', () => this._padded.delete(indicator));
                this._padded.set(indicator, id);
            }
        }
    }

    // ── 图标收纳 ─────────────────────────────────────────────────────

    _queueSync() {
        if (this._destroyed || this._syncLaterId)
            return;
        this._syncLaterId = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._syncLaterId = 0;
            if (!this._destroyed)
                this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const items = [];
        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            if (!role.startsWith(APPINDICATOR_PREFIX) || !indicator || !indicator.container)
                continue;
            const info = indicatorInfo(indicator);
            if (!info)
                continue;             // 还没就绪或正在销毁：不动它
            items.push({ indicator, container: indicator.container, ...info });
        }

        this._recordKnown(items);

        for (const item of items) {
            try {
                if (this._shouldCollapse(item.id))
                    this._collapse(item);
                else
                    this._release(item.container);
            } catch (e) {
                logError(e, `[tray-collapse] ${item.id}`);
            }
        }

        this._applyPanelPadding(items);
        if (this._state === 'shown')
            this._positionOverlay();
    }

    // 是否收纳：老式图标固定留在面板；collapsed 优先 > pinned > 默认值
    _shouldCollapse(id) {
        if (isLegacyId(id))
            return false;
        if (this._settings.get_strv('collapsed-ids').includes(id))
            return true;
        if (this._settings.get_strv('pinned-ids').includes(id))
            return false;
        return this._settings.get_boolean('default-collapse');
    }

    _collapse({ indicator, container }) {
        let entry = this._entries.get(container);
        if (!entry) {
            entry = { indicator, menu: null, eventId: 0, destroyId: 0 };
            entry.destroyId = container.connect('destroy', () => this._entries.delete(container));
            // 中键 = SecondaryActivate。appindicator 自己的中键处理依赖面板的菜单管理器，
            // 菜单换了管理器以后要在这里接住（'event' 早于 PanelMenu.Button 的开关菜单逻辑）
            entry.eventId = indicator.connect('event',
                (actor, event) => this._onIndicatorEvent(indicator, event));
            this._entries.set(container, entry);
        }

        if (container.get_parent() !== this._drawer) {
            container.get_parent()?.remove_child(container);
            this._drawer.add_child(container);
        }

        // 菜单交给托盘语义的管理器（appindicator 重新上架图标时会把它塞回面板管理器）
        const menu = indicator.menu;
        if (entry.menu && entry.menu !== menu) {
            this._menuManager.removeMenu(entry.menu);
            entry.menu = null;
        }
        if (menu instanceof PopupMenu.PopupMenu) {   // 不碰 PopupDummyMenu（没有可弹出的菜单）
            if (menu.isOpen && this._menuManager.activeMenu !== menu)
                menu.close(BoxPointer.PopupAnimation.NONE);
            Main.panel.menuManager.removeMenu(menu);
            this._menuManager.addMenu(menu);
            entry.menu = menu;
        }
    }

    _release(container) {
        const entry = this._entries.get(container);
        if (!entry)
            return;
        this._entries.delete(container);
        container.disconnect(entry.destroyId);
        entry.indicator.disconnect(entry.eventId);

        if (entry.menu) {
            this._menuManager.removeMenu(entry.menu);
            Main.panel.menuManager.addMenu(entry.menu);
        }

        if (container.get_parent() === this._drawer) {
            this._drawer.remove_child(container);
            const box = Main.panel._rightBox;
            const anchor = this._primaryCapsule?.container;
            if (anchor && anchor.get_parent() === box)
                box.insert_child_above(container, anchor);   // 放回主面板胶囊旁边
            else
                box.insert_child_at_index(container, 0);
        }
    }

    _onIndicatorEvent(indicator, event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS ||
            event.get_button() !== Clutter.BUTTON_MIDDLE)
            return Clutter.EVENT_PROPAGATE;
        const sni = indicator._indicator;
        if (sni && typeof sni.secondaryActivate === 'function') {
            const [x, y] = event.get_coords();
            sni.secondaryActivate(event.get_time(), x, y);
        }
        return Clutter.EVENT_STOP;
    }

    // ── known-indicators：供设置界面列出见过的图标（设置界面在独立进程，读不到 statusArea）──
    //   1) 清洗旧数据：legacy id 去掉进程号；丢弃以 D-Bus 临时总线名记下的条目；
    //   2) 同名清扫：个别应用每次启动乱报随机 id 但 title 稳定——同 title 且不在线的
    //      旧条目视为同一应用的旧身份，删掉并把收纳设置迁给当前 id；
    //   3) peers 保护：同 title 的图标若同时在线过（如两个「更新通知」其实是不同应用），
    //      互记为 peers，永不合并。
    _recordKnown(items) {
        const stored = this._settings.get_string('known-indicators');
        let known = [];
        try {
            known = JSON.parse(stored);
        } catch (e) {
            known = [];
        }
        if (!Array.isArray(known))
            known = [];

        const map = new Map();   // id -> { title, peers: Set }
        for (const k of known) {
            if (!k || !k.id)
                continue;
            const id = canonicalId(k.id);
            if (isBusNameId(id) || map.has(id))
                continue;
            let title = k.title ? String(k.title) : id;
            if (isLegacyId(id) && (isLegacyId(title) || isBusNameId(title)))
                title = id.slice('legacy:'.length);
            else if (isBusNameId(title))
                title = id;
            const peers = (Array.isArray(k.peers) ? k.peers : [])
                .map(canonicalId).filter(p => !isBusNameId(p) && p !== id);
            map.set(id, { title, peers: new Set(peers) });
        }
        this._cleanList('collapsed-ids');
        this._cleanList('pinned-ids');

        const liveIds = new Set(items.map(it => it.id));
        const byTitle = new Map();
        for (const it of items) {
            if (!byTitle.has(it.title))
                byTitle.set(it.title, []);
            byTitle.get(it.title).push(it.id);
        }

        for (const it of items) {
            if (!map.has(it.id))
                map.set(it.id, { title: it.title, peers: new Set() });
            const entry = map.get(it.id);
            entry.title = it.title;
            for (const peer of byTitle.get(it.title)) {
                if (peer !== it.id)
                    entry.peers.add(peer);
            }

            // 当前 id 已有明确设置时只清不迁，免得旧设置覆盖用户现在的选择
            const hasExplicit =
                this._settings.get_strv('collapsed-ids').includes(it.id) ||
                this._settings.get_strv('pinned-ids').includes(it.id);
            for (const [oldId, old] of [...map]) {
                if (oldId === it.id || old.title !== it.title)
                    continue;
                if (liveIds.has(oldId) || entry.peers.has(oldId) || old.peers.has(it.id))
                    continue;
                map.delete(oldId);
                for (const key of ['collapsed-ids', 'pinned-ids']) {
                    if (hasExplicit)
                        this._removeFromList(key, oldId);
                    else
                        this._renameInList(key, oldId, it.id);
                }
            }
        }

        const json = JSON.stringify([...map].map(([id, v]) =>
            ({ id, title: v.title, peers: [...v.peers] })));
        if (json !== stored)
            this._settings.set_string('known-indicators', json);
    }

    // 列表里的 id 规范化、去重，并丢掉以 D-Bus 临时总线名记下的（无变化则不写回）
    _cleanList(key) {
        const arr = this._settings.get_strv(key);
        const out = [...new Set(arr.map(canonicalId))].filter(id => !isBusNameId(id));
        if (out.length !== arr.length || out.some((v, i) => v !== arr[i]))
            this._settings.set_strv(key, out);
    }

    // 应用乱报随机 id 时迁移设置：把列表里的 oldId 换成 newId（不重复添加）
    _renameInList(key, oldId, newId) {
        const arr = this._settings.get_strv(key);
        if (!arr.includes(oldId))
            return;
        const out = arr.filter(x => x !== oldId);
        if (!out.includes(newId))
            out.push(newId);
        this._settings.set_strv(key, out);
    }

    _removeFromList(key, id) {
        const arr = this._settings.get_strv(key);
        if (arr.includes(id))
            this._settings.set_strv(key, arr.filter(x => x !== id));
    }

    // ── 清理 ─────────────────────────────────────────────────────────

    destroy() {
        this._destroyed = true;
        // 先断开会触发校正的信号：下面把图标放回面板时也会触发 actor-added
        this._settings.disconnectObject(this);
        Main.panel._rightBox.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        if (this._dashToPanel && this._dashToPanelId)
            this._dashToPanel.disconnect(this._dashToPanelId);
        this._dashToPanel = null;
        for (const id of [this._syncLaterId, this._capsuleLaterId]) {
            if (id)
                Meta.later_remove(id);
        }
        this._syncLaterId = this._capsuleLaterId = 0;
        this._stopPointerWatch();
        this._disconnectStagePress();

        for (const container of [...this._entries.keys()]) {
            try {
                this._release(container);
            } catch (e) {
                logError(e, '[tray-collapse] restore icon');
            }
        }
        // 兜底：浮层销毁时会连带销毁子节点，任何还留在里面的图标都必须先送回面板
        for (const child of this._drawer.get_children()) {
            this._drawer.remove_child(child);
            Main.panel._rightBox.add_child(child);
        }
        this._menuManager.destroy();

        for (const [indicator, id] of this._padded) {
            indicator.disconnect(id);
            indicator.set_style(null);
        }
        this._padded.clear();

        for (const capsule of [...this._capsules])
            capsule.destroy();
        this._capsules.clear();
        this._primaryCapsule = null;
        this._anchorCapsule = null;

        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = null;
        this._drawer = null;
    }
};

class Extension {
    enable() {
        this._tray = new TrayCollapse(ExtensionUtils.getSettings());
    }

    disable() {
        this._tray?.destroy();
        this._tray = null;
    }
}

function init() {
    return new Extension();
}
