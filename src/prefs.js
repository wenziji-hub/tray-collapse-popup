// Tray Collapse Popup 设置界面 — GTK4 / libadwaita (GNOME 42)
// 设置界面跑在独立进程里，读不到 Shell 的 statusArea，
// 所以图标列表来自扩展写入的 gsettings: known-indicators（JSON）。

const { Adw, Gdk, Gtk } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

function init() {}

// 「标题 + 数字微调框」行，绑定到 settings 的一个 int 键
function makeSpinRow(settings, key, title, subtitle, lower, upper) {
    const row = new Adw.ActionRow({ title, subtitle });
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
            lower, upper, step_increment: 1, page_increment: 4,
        }),
        valign: Gtk.Align.CENTER,
    });
    spin.set_value(settings.get_int(key));
    spin.connect('value-changed',
        () => settings.set_int(key, spin.get_value_as_int()));
    settings.connect(`changed::${key}`, () => {
        if (spin.get_value_as_int() !== settings.get_int(key))
            spin.set_value(settings.get_int(key));
    });
    row.add_suffix(spin);
    row.activatable_widget = spin;
    return row;
}

// 某个 id 当前是否收进浮层：collapsed 优先 > pinned > 默认值
function isCollapsed(settings, id) {
    if (settings.get_strv('collapsed-ids').includes(id))
        return true;
    if (settings.get_strv('pinned-ids').includes(id))
        return false;
    return settings.get_boolean('default-collapse');
}

// 写入用户的明确选择：收纳 → collapsed-ids，常驻 → pinned-ids（互斥）
function setCollapsed(settings, id, collapse) {
    const collapsed = settings.get_strv('collapsed-ids').filter(x => x !== id);
    const pinned = settings.get_strv('pinned-ids').filter(x => x !== id);
    if (collapse)
        collapsed.push(id);
    else
        pinned.push(id);
    settings.set_strv('collapsed-ids', collapsed);
    settings.set_strv('pinned-ids', pinned);
}

function readKnown(settings) {
    let known;
    try {
        known = JSON.parse(settings.get_string('known-indicators'));
    } catch (e) {
        known = [];
    }
    // 以 D-Bus 临时总线名（:1.NNN）记下的旧条目没有意义，扩展下次运行时也会清掉
    return (Array.isArray(known) ? known : [])
        .filter(k => k && k.id && !String(k.id).startsWith(':'));
}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();
    const page = new Adw.PreferencesPage();
    window.add(page);

    // —— 通用 ——
    const general = new Adw.PreferencesGroup({ title: '通用' });
    page.add(general);

    const defaultRow = new Adw.ActionRow({
        title: '新图标默认收进弹窗',
        subtitle: '关闭：新出现的图标先留在面板上，需要时再到下面逐个收纳',
    });
    const defaultSwitch = new Gtk.Switch({
        active: settings.get_boolean('default-collapse'),
        valign: Gtk.Align.CENTER,
    });
    defaultSwitch.connect('notify::active', () => {
        if (settings.get_boolean('default-collapse') !== defaultSwitch.active)
            settings.set_boolean('default-collapse', defaultSwitch.active);
    });
    defaultRow.add_suffix(defaultSwitch);
    defaultRow.activatable_widget = defaultSwitch;
    general.add(defaultRow);

    // —— 间距 ——
    const spacing = new Adw.PreferencesGroup({
        title: '间距',
        description: '托盘图标之间的水平距离（单位像素）',
    });
    page.add(spacing);
    spacing.add(makeSpinRow(settings, 'drawer-spacing',
        '弹窗内图标间距', '弹窗里各图标之间的额外距离', 0, 40));
    spacing.add(makeSpinRow(settings, 'panel-hpadding',
        '图标内边距', '每个托盘图标左右的留白，调小即收紧间距（主题默认 12）', 0, 24));

    // —— 弹窗外观 ——
    const look = new Adw.PreferencesGroup({
        title: '弹窗外观',
        description: '点开胶囊按钮后那个浮动小窗的底色与形状（改完立即生效）',
    });
    page.add(look);

    const opRow = new Adw.ActionRow({ title: '不透明度', subtitle: '调低会把后面的窗口透出来' });
    const opScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        digits: 0,
        draw_value: true,
        value_pos: Gtk.PositionType.RIGHT,
        hexpand: true,
        width_request: 180,
        valign: Gtk.Align.CENTER,
        adjustment: new Gtk.Adjustment({
            lower: 0, upper: 100, step_increment: 5, page_increment: 10,
        }),
    });
    opScale.set_value(Math.round(settings.get_double('popup-opacity') * 100));
    opScale.connect('value-changed', () =>
        settings.set_double('popup-opacity', opScale.get_value() / 100));
    settings.connect('changed::popup-opacity', () => {
        const v = Math.round(settings.get_double('popup-opacity') * 100);
        if (Math.round(opScale.get_value()) !== v)
            opScale.set_value(v);
    });
    opRow.add_suffix(opScale);
    look.add(opRow);

    const colRow = new Adw.ActionRow({ title: '背景色', subtitle: '默认 #2e2e32（深灰）' });
    const colBtn = new Gtk.ColorButton({ valign: Gtk.Align.CENTER });
    const rgba = new Gdk.RGBA();
    if (rgba.parse(settings.get_string('popup-bg-color')))
        colBtn.set_rgba(rgba);
    colBtn.connect('color-set', () => {
        const c = colBtn.get_rgba();
        settings.set_string('popup-bg-color', `#${[c.red, c.green, c.blue]
            .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`);
    });
    colRow.add_suffix(colBtn);
    colRow.activatable_widget = colBtn;
    look.add(colRow);

    look.add(makeSpinRow(settings, 'popup-radius', '圆角', '单位像素，0 = 直角', 0, 30));
    look.add(makeSpinRow(settings, 'popup-padding', '上下留白', '单位像素，调大即更宽松', 0, 30));

    // —— 图标列表 ——
    const group = new Adw.PreferencesGroup({
        title: '托盘图标',
        description: '开 = 收进弹窗，关 = 留在面板上',
    });
    page.add(group);

    const known = readKnown(settings);
    if (known.length === 0) {
        group.add(new Adw.ActionRow({
            title: '还没发现任何托盘图标',
            subtitle: '启用扩展后，让各程序的托盘图标出现一次即会自动记录，再回来设置',
        }));
        return;
    }

    known.sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
    const switches = [];
    let refreshing = false;
    for (const k of known) {
        const legacy = String(k.id).startsWith('legacy:');
        const row = new Adw.ActionRow({
            title: String(k.title || k.id),
            subtitle: legacy ? `${k.id} · 老式图标，固定留在面板上` : String(k.id),
        });
        const sw = new Gtk.Switch({
            active: !legacy && isCollapsed(settings, k.id),
            sensitive: !legacy,
            valign: Gtk.Align.CENTER,
        });
        if (!legacy) {
            sw.connect('notify::active', () => {
                if (!refreshing)
                    setCollapsed(settings, k.id, sw.active);
            });
            switches.push({ id: k.id, sw });
        }
        row.add_suffix(sw);
        row.activatable_widget = sw;
        group.add(row);
    }

    // 改了「默认」或在别处改了收纳名单时，开关跟着刷新
    const refresh = () => {
        refreshing = true;
        defaultSwitch.active = settings.get_boolean('default-collapse');
        for (const { id, sw } of switches)
            sw.active = isCollapsed(settings, id);
        refreshing = false;
    };
    for (const key of ['default-collapse', 'collapsed-ids', 'pinned-ids'])
        settings.connect(`changed::${key}`, refresh);
}
