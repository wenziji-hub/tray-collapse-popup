// Tray Collapse 托盘折叠 — GNOME Shell 42
// 把 AppIndicator 托盘图标收进顶栏的可折叠区域，并支持逐个选择「收纳 / 常驻」。
//
// 设计要点（为什么不用弹出菜单）：
//   被收纳的图标本身是面板按钮（PanelMenu.Button），如果塞进弹出菜单里，
//   点击它会先关闭外层菜单，导致图标自己的菜单弹不出来。
//   因此这里把「抽屉」做成一个直接放在顶栏里的盒子(_drawerBox)：
//     - 收起：盒子隐藏(visible=false)，不占顶栏空间；
//     - 展开：盒子显示，图标原地内联出现，仍是面板原生按钮，点击行为完全正常。
//
// 机制：appindicator 把每个图标注册为 Main.panel.statusArea['appindicator-<uniqueId>']，
//   其 ._indicator.id 是应用上报的稳定 ID（跨重启不变），作白名单匹配键；
//   .container 是图标实体，移入 _drawerBox / 移回 _rightBox 即实现收纳 / 放出。
//   设置界面在独立进程读不到 statusArea，故扩展把见过的图标写进
//   gsettings 的 known-indicators(JSON) 供其渲染列表（跨进程桥接）。

const { Clutter, Gdk, Gio, GLib, GObject, St } = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const APPINDICATOR_PREFIX = 'appindicator-';

// legacy 托盘图标的 id 形如 legacy:<窗口类>:<进程号>（appindicator 的
// indicatorStatusIcon.js 生成），进程号每次重启都变，砍掉它才是稳定匹配键
function canonicalId(id) {
    const m = /^legacy:(.+):\d+$/.exec(String(id));
    return m ? `legacy:${m[1]}` : String(id);
}

// 稳定标识：优先 AppIndicator 上报的 id，其次 title，最后 uniqueId 兜底
function indicatorId(indicator) {
    const ind = indicator._indicator;
    if (ind) {
        if (ind.id)
            return canonicalId(ind.id);
        if (ind.title)
            return String(ind.title);
    }
    return canonicalId(indicator.uniqueId || '');
}

function indicatorTitle(indicator) {
    const ind = indicator._indicator;
    if (ind && ind.title)
        return String(ind.title);
    const id = indicatorId(indicator);
    // legacy 图标没有 title，用窗口类当标题（legacy:fcitx → fcitx）
    return id.startsWith('legacy:') ? id.slice('legacy:'.length) : id;
}

const TrayCollapseButton = GObject.registerClass(
class TrayCollapseButton extends PanelMenu.Button {
    _init(settings) {
        // dontCreateMenu=true：不用弹出菜单，点击只切换抽屉显隐
        super._init(0.0, 'TrayCollapse', true);
        this._settings = settings;
        this._expanded = false;

        // 自带的胶囊 symbolic 图标（收起=闭合胶囊，展开=向左开口）；
        // 文件名以 -symbolic.svg 结尾，Shell 会按主题前景色重新着色
        this._iconCollapsed = Gio.icon_new_for_string(
            `${Me.path}/icons/tray-collapse-symbolic.svg`);
        this._iconExpanded = Gio.icon_new_for_string(
            `${Me.path}/icons/tray-expand-symbolic.svg`);

        this._icon = new St.Icon({
            gicon: this._iconCollapsed,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // 悬停柔光 / 打开时下划线常亮的样式钩子（保留 panel-button 的面板度量）
        this.add_style_class_name('tray-collapse-button');

        // 抽屉盒子：放进顶栏（由 Extension.enable 插入 _rightBox），靠显隐折叠
        this._drawerBox = new St.BoxLayout({
            style_class: 'tray-collapse-drawer',
            visible: true,
        });

        // /* POPUP-PATCH */ 自绘浮层：普通 actor，不进 GNOME 菜单系统 → 不抢模态抓取
        this._overlay = new St.BoxLayout({
            style_class: 'tray-collapse-popup',
            visible: false,
        });
        this._overlay.add_child(this._drawerBox);
        this._pointerId = 0;          // 鼠标离开自动关闭的轮询
        this._outsideSince = 0;
        this._menuOpenCount = 0;      // 有图标菜单开着时不自动关
        this._menuHooks = new Map();
        // /* POPUP-PATCH */ 内联样式：不依赖主题/样式表，保证一定画出不透明背景
        this._applyPopupStyle();
        ['popup-opacity', 'popup-bg-color', 'popup-radius', 'popup-padding']
            .forEach(k => this._settings.connect('changed::' + k,
                () => this._applyPopupStyle()));
        this._stageClickId = 0;
        try {
            Main.layoutManager.addChrome(this._overlay, {
                affectsInputRegion: true,
                affectsStruts: false,
                trackFullscreen: false,
            });
        } catch (e) {
            Main.uiGroup.add_child(this._overlay);
        }
        this.connect('destroy', () => {
            this._hideOverlay();
            try { Main.layoutManager.removeChrome(this._overlay); } catch (e) { /* 忽略 */ }
        });

        this._moved = new Map();       // container -> destroy 信号 id
        this._spacers = new Map();     // container -> spacer actor
        this._padded = new Set();      // 被覆盖过内边距的 indicator（禁用时还原）
        this._timeouts = new Set();
        this._suppressAdded = false;   // 搬图标回顶栏时抑制自身 actor-added 回环

        this._settingsIds = [
            this._settings.connect('changed::collapsed-ids', () => this._apply()),
            this._settings.connect('changed::pinned-ids', () => this._apply()),
            this._settings.connect('changed::default-collapse', () => this._apply()),
            this._settings.connect('changed::drawer-spacing',
                () => this._applyDrawerSpacing()),
            this._settings.connect('changed::panel-hpadding',
                () => this._applyPanelPadding()),
        ];

        this._applyDrawerSpacing();

        // 顶栏右盒新增子节点（新程序弹托盘图标）时整体重扫
        this._addedId = Main.panel._rightBox.connect('actor-added', () => {
            if (!this._suppressAdded)
                this._scheduleRescan(80);
        });

        // /* POPUP-PATCH */ 点按钮开关自绘浮层
        // /* POPUP-PATCH */ 左键开关浮层；右键打开本扩展的设置
        this.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 3) {
                try {
                    imports.misc.util.spawn(['gnome-extensions', 'prefs', Me.metadata.uuid]);
                } catch (e) { /* 忽略 */ }
                return Clutter.EVENT_STOP;
            }
            this._toggle();
            return Clutter.EVENT_STOP;
        });

        // 启动竞态：appindicator 图标开机后陆续注册，分多次延迟补扫兜住
        [0, 800, 2000, 4000, 8000].forEach(ms => this._scheduleRescan(ms));
    }

    get drawerBox() {
        return this._drawerBox;
    }

    _applyDrawerSpacing() {
        const px = this._settings.get_int('drawer-spacing');
        for (const spacer of this._spacers.values())
            spacer.set_width(px);
    }

    // 顶栏图标的「宽间距」来自主题：每个 panel-button 左右各 12px 内边距
    // （Yaru 的 -natural-hpadding），与 appindicator 的 icon-spacing 无关
    // （Ubuntu 22.04 打包的旧版 appindicator 没实现该键）。
    // 这里用内联样式逐个覆盖托盘图标按钮的内边距；禁用时 set_style(null) 还原。
    _applyPanelPadding() {
        const px = this._settings.get_int('panel-hpadding');
        for (const it of this._appindicators()) {
            it.indicator.set_style(
                `-natural-hpadding: ${px}px; -minimum-hpadding: ${px}px;`);
            this._padded.add(it.indicator);
        }
    }

    // /* POPUP-PATCH */ 打开浮层：贴着按钮上方（面板在下半屏时），并挂上"点外关闭"
    _showOverlay() {
        try {
            const [bx, by] = this.get_transformed_position();
            const mon = Main.layoutManager.findMonitorForActor(this);
            const bw = this.width || 40;
            const bh = this.height || 40;
            const pw = this._overlay.get_preferred_width(-1)[1];
            const ph = this._overlay.get_preferred_height(-1)[1];

            let ox = Math.round(bx + bw / 2 - pw / 2);
            ox = Math.max(mon.x + 8, Math.min(ox, mon.x + mon.width - pw - 8));

            let oy = Math.round(by - ph - 6);                 // 面板在下方 → 浮层在上
            if (oy < mon.y + 8)
                oy = Math.round(by + bh + 6);                 // 面板在上方 → 浮层在下

            this._overlay.set_position(ox, oy);
        } catch (e) { /* 定位失败就用原位置 */ }

        // /* POPUP-PATCH */ 淡入
        this._overlay.remove_all_transitions();
        this._overlay.opacity = 0;
        this._overlay.show();
        this._overlay.ease({
            opacity: 255,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._startPointerWatch();
        this._expanded = true;
        this._icon.gicon = this._iconExpanded;
        this.add_style_pseudo_class('checked');

        if (!this._stageClickId) {
            this._stageClickId = global.stage.connect('captured-event', (a, event) => {
                if (event.type() !== Clutter.EventType.BUTTON_PRESS &&
                    event.type() !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;
                let target = null;
                try { target = global.stage.get_event_actor(event); } catch (e) { /* 忽略 */ }
                if (target && (this._overlay.contains(target) || this.contains(target)))
                    return Clutter.EVENT_PROPAGATE;
                this._hideOverlay();          // 点到别处 → 收起
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    // /* POPUP-PATCH */ 鼠标离开浮层（和胶囊）附近 → 自动收起
    _startPointerWatch() {
        this._outsideSince = 0;
        if (this._pointerId)
            return;
        this._pointerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            try {
                if (!this._overlay || !this._overlay.visible) {
                    this._pointerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                // /* POPUP-PATCH */ 只要有菜单开着就别自动关：
                //   ① 自己挂钩的计数（收纳中的图标）
                //   ② 直接问 GNOME 的菜单管理器（覆盖右键菜单等所有 GNOME 菜单）
                let menuOpen = this._menuOpenCount > 0;
                if (!menuOpen) {
                    try {
                        menuOpen = !!(Main.panel.menuManager &&
                                      Main.panel.menuManager.activeMenu);
                    } catch (e) { /* 忽略 */ }
                }
                if (menuOpen) {
                    this._outsideSince = 0;
                    return GLib.SOURCE_CONTINUE;
                }
                const [px, py] = global.get_pointer();
                if (this._pointNear(px, py)) {
                    this._outsideSince = 0;
                    return GLib.SOURCE_CONTINUE;
                }
                const now = GLib.get_monotonic_time() / 1000;
                if (!this._outsideSince)
                    this._outsideSince = now;
                else if (now - this._outsideSince > 450) {
                    this._hideOverlay();
                    this._pointerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
            } catch (e) { /* 忽略 */ }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _pointNear(px, py) {
        const M = 14;    // 容差：胶囊与浮层之间有空隙，移动途中不该被关
        const hit = actor => {
            if (!actor || !actor.visible)
                return false;
            try {
                const pos = actor.get_transformed_position();
                return px >= pos[0] - M && px <= pos[0] + actor.width + M &&
                       py >= pos[1] - M && py <= pos[1] + actor.height + M;
            } catch (e) {
                return false;
            }
        };
        return hit(this._overlay) || hit(this);
    }

    _hideOverlay() {        if (this._pointerId) {
            GLib.source_remove(this._pointerId);
            this._pointerId = 0;
            this._outsideSince = 0;
        }

        if (this._stageClickId) {
            global.stage.disconnect(this._stageClickId);
            this._stageClickId = 0;
        }
        if (!this._overlay) {
            this._expanded = false;
            this._icon.gicon = this._iconCollapsed;
            this.remove_style_pseudo_class('checked');
            return;
        }

        // /* POPUP-PATCH */ 淡出后再隐藏（带兜底：动画被打断也能收起来）
        let finished = false;
        const finish = () => {
            if (finished)
                return;
            finished = true;
            this._overlay.hide();
            this._overlay.opacity = 255;
            this._expanded = false;
            this._icon.gicon = this._iconCollapsed;
            this.remove_style_pseudo_class('checked');
        };

        this._overlay.remove_all_transitions();
        this._overlay.ease({
            opacity: 0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: finish,
        });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 280, () => {
            finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    // /* POPUP-PATCH */ 按设置里的值刷新浮层外观（实时生效，不用重启）
    _applyPopupStyle() {
        try {
            const s = this._settings;
            let col = s.get_string('popup-bg-color') || '#2e2e32';
            const op = Math.max(0, Math.min(1, s.get_double('popup-opacity')));
            try {
                const rgba = new Gdk.RGBA();
                if (rgba.parse(col)) {
                    rgba.alpha = op;
                    col = rgba.to_string();
                }
            } catch (e) { /* 解析不了就原样用 */ }

            this._overlay.set_style(
                'background-color: ' + col + ';' +
                'border: 1px solid rgba(255, 255, 255, 0.14);' +
                'border-radius: ' + s.get_int('popup-radius') + 'px;' +
                'padding: ' + s.get_int('popup-padding') + 'px 12px;' +
                'box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);');
        } catch (e) { /* 忽略 */ }
    }

    _toggle() {
        if (this._overlay && this._overlay.visible)
            this._hideOverlay();
        else
            this._showOverlay();
    }

    // 当前所有 appindicator：[{indicator, id, title, container}]
    _appindicators() {
        const out = [];
        const statusArea = Main.panel.statusArea;
        for (const key in statusArea) {
            if (!key.startsWith(APPINDICATOR_PREFIX))
                continue;
            const indicator = statusArea[key];
            if (!indicator || !indicator.container)
                continue;
            out.push({
                indicator,
                id: indicatorId(indicator),
                title: indicatorTitle(indicator),
                container: indicator.container,
            });
        }
        return out;
    }

    // 是否收纳：collapsed 优先 > pinned > 默认值
    _shouldCollapse(id) {
        // /* POPUP-PATCH */ 老式 XEmbed 图标不进浮层：它的菜单是应用自己的 X11 窗口，
        // 而 X11 窗口只能画在 GNOME 界面下面，收进浮层就会被挡住（点了没反应）
        if (String(id).indexOf('legacy:') === 0)
            return false;
        if (this._settings.get_strv('collapsed-ids').includes(id))
            return true;
        if (this._settings.get_strv('pinned-ids').includes(id))
            return false;
        return this._settings.get_boolean('default-collapse');
    }

    _apply() {
        const items = this._appindicators();
        this._recordKnown(items);
        for (const it of items) {
            if (this._shouldCollapse(it.id))
                this._moveIn(it.container);
            else
                this._moveOut(it.container);
        }
        this._applyPanelPadding();
    }

    // 把见过的图标写进 known-indicators(JSON)，供设置界面读取。
    // 顺带做去重：
    //   1) 存量清洗：旧版本记录过带 PID 的 legacy id（legacy:fcitx:4315），
    //      规范化后合并重复项、重算标题；
    //   2) 同名清扫：个别应用（如 com.follow.clash）违反 SNI 规范，每次启动
    //      乱报随机 id 但 title 稳定——同 title 且「不在线」的旧条目视为
    //      同一应用留下的旧身份，删除并把收纳设置迁给当前 id；
    //   3) peers 保护：同 title 的图标若「同时在线」过（如两个「更新通知」
    //      其实是不同应用），互记为 peers 并持久化，永不合并。
    _recordKnown(items) {
        let known = [];
        try {
            known = JSON.parse(this._settings.get_string('known-indicators')) || [];
        } catch (e) {
            known = [];
        }
        let changed = false;

        // 存量清洗：id 规范化合并 legacy 重复项，丑标题按新 id 重算
        const map = new Map();   // id -> { title, peers: Set }
        for (const k of known) {
            const id = canonicalId(k.id);
            let title = k.title;
            if (id.startsWith('legacy:') && String(title).startsWith('legacy:'))
                title = id.slice('legacy:'.length);
            if (id !== k.id || title !== k.title)
                changed = true;
            if (!map.has(id))
                map.set(id, { title, peers: new Set(k.peers || []) });
        }
        this._canonicalizeList('collapsed-ids');
        this._canonicalizeList('pinned-ids');

        const liveIds = new Set(items.map(it => it.id).filter(Boolean));

        // 同时在线的同名图标 → 真·不同应用，互记 peers
        const byTitle = new Map();
        for (const it of items) {
            if (!it.id)
                continue;
            if (!byTitle.has(it.title))
                byTitle.set(it.title, []);
            byTitle.get(it.title).push(it.id);
        }

        for (const it of items) {
            if (!it.id)
                continue;
            if (!map.has(it.id)) {
                map.set(it.id, { title: it.title, peers: new Set() });
                changed = true;
            }
            const entry = map.get(it.id);
            if (entry.title !== it.title) {
                entry.title = it.title;
                changed = true;
            }
            for (const peer of byTitle.get(it.title)) {
                if (peer !== it.id && !entry.peers.has(peer)) {
                    entry.peers.add(peer);
                    changed = true;
                }
            }

            // 同名清扫：不在线、又不是 peers 的同 title 旧条目 → 旧身份，合并掉。
            // 当前 id 已有明确设置则只清不迁，避免旧设置覆盖用户现在的选择。
            const hasExplicit =
                this._settings.get_strv('collapsed-ids').includes(it.id) ||
                this._settings.get_strv('pinned-ids').includes(it.id);
            for (const [oldId, old] of [...map]) {
                if (oldId === it.id || old.title !== it.title)
                    continue;
                if (liveIds.has(oldId) || entry.peers.has(oldId) ||
                    old.peers.has(it.id))
                    continue;
                map.delete(oldId);
                if (hasExplicit) {
                    this._removeFromList('collapsed-ids', oldId);
                    this._removeFromList('pinned-ids', oldId);
                } else {
                    this._renameInList('collapsed-ids', oldId, it.id);
                    this._renameInList('pinned-ids', oldId, it.id);
                }
                changed = true;
            }
        }

        if (changed) {
            const arr = [...map].map(([id, v]) =>
                ({ id, title: v.title, peers: [...v.peers] }));
            this._settings.set_string('known-indicators', JSON.stringify(arr));
        }
    }

    // 列表里的 id 全部规范化并去重（存量数据清洗，无变化则不写回）
    _canonicalizeList(key) {
        const arr = this._settings.get_strv(key);
        const out = [...new Set(arr.map(canonicalId))];
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

    // 清掉列表里某个失效 id（不迁移）
    _removeFromList(key, id) {
        const arr = this._settings.get_strv(key);
        if (arr.includes(id))
            this._settings.set_strv(key, arr.filter(x => x !== id));
    }

    _scheduleRescan(ms) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            this._apply();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _moveIn(container, indicator) {
        if (this._moved.has(container))
            return;
        // /* POPUP-PATCH */ 记录图标菜单开关：菜单开着时不自动收浮层
        try {
            if (indicator && indicator.menu) {
                const sid = indicator.menu.connect('open-state-changed', (m, open) => {
                    this._menuOpenCount = Math.max(0, this._menuOpenCount + (open ? 1 : -1));
                });
                this._menuHooks.set(container, [indicator, sid]);
            }
        } catch (e) { /* 忽略 */ }
        const parent = container.get_parent();
        if (parent)
            parent.remove_child(container);
        this._drawerBox.add_child(container);
        const px = this._settings.get_int('drawer-spacing');
        const spacer = new St.Bin({ width: px });
        this._drawerBox.add_child(spacer);
        this._spacers.set(container, spacer);
        const destroyId = container.connect('destroy',
            () => this._moved.delete(container));
        this._moved.set(container, destroyId);
    }

    _moveOut(container) {
        if (!this._moved.has(container))
            return;
        this._detach(container);
        if (!container.get_parent()) {
            this._suppressAdded = true;
            Main.panel._rightBox.insert_child_at_index(container, 0);
            this._suppressAdded = false;
        }
    }

    // 从抽屉摘出 container 并断开 destroy 信号（不负责放回顶栏）
    _detach(container) {
        // /* POPUP-PATCH */ 断开图标菜单监听
        try {
            const hooked = this._hooked && this._hooked.get(container);
            if (hooked) {
                hooked[0].menu.disconnect(hooked[1]);
                this._hooked.delete(container);
            }
        } catch (e) { /* 忽略 */ }
        // /* POPUP-PATCH */ 摘掉菜单开关监听
        try {
            const hooked = this._menuHooks && this._menuHooks.get(container);
            if (hooked) {
                hooked[0].menu.disconnect(hooked[1]);
                this._menuHooks.delete(container);
            }
        } catch (e) { /* 忽略 */ }
        const destroyId = this._moved.get(container);
        if (destroyId)
            container.disconnect(destroyId);
        this._moved.delete(container);
        const spacer = this._spacers.get(container);
        if (spacer) {
            spacer.destroy();
            this._spacers.delete(container);
        }
        if (this._drawerBox.contains(container))
            this._drawerBox.remove_child(container);
    }

    _restoreAll() {
        for (const container of [...this._moved.keys()]) {
            try {
                this._detach(container);
                if (!container.get_parent()) {
                    this._suppressAdded = true;
                    Main.panel._rightBox.insert_child_at_index(container, 0);
                    this._suppressAdded = false;
                }
            } catch (e) {
                // container 可能已被销毁，忽略
            }
        }
        this._moved.clear();
    }

    destroy() {
        if (this._addedId) {
            Main.panel._rightBox.disconnect(this._addedId);
            this._addedId = 0;
        }
        for (const sid of this._settingsIds || [])
            this._settings.disconnect(sid);
        this._settingsIds = [];
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();

        this._restoreAll();

        // 还原被覆盖的顶栏图标内边距，交还给主题
        for (const indicator of this._padded) {
            try {
                indicator.set_style(null);
            } catch (e) {
                // indicator 可能已被销毁，忽略
            }
        }
        this._padded.clear();

        // 移除抽屉盒子
        if (this._drawerBox) {
            const parent = this._drawerBox.get_parent();
            if (parent)
                parent.remove_child(this._drawerBox);
            this._drawerBox.destroy();
            this._drawerBox = null;
        }

        super.destroy();
    }
});

class Extension {
    enable() {
        this._settings = ExtensionUtils.getSettings();
        this._indicator = new TrayCollapseButton(this._settings);
        // ⋯ 按钮放右盒最靠左（紧挨时钟）
        Main.panel.addToStatusArea('tray-collapse', this._indicator, 0, 'right');
        // /* POPUP-PATCH */ 抽屉住在自绘浮层里，不用插进面板
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}

function init() {
    return new Extension();
}
