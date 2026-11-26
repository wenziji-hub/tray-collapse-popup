#!/usr/bin/env bash
# 安装 Tray Collapse Popup 到当前用户的 GNOME Shell 扩展目录
set -euo pipefail

UUID="tray-collapse@fnidore.top"
SRC="$(cd "$(dirname "$0")/src" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

command -v glib-compile-schemas >/dev/null || { echo "缺少 glib-compile-schemas"; exit 1; }

echo "==> 编译 gsettings schema"
glib-compile-schemas "$SRC/schemas"

UPDATING=0
[ -f "$DEST/extension.js" ] && UPDATING=1

echo "==> 安装到 $DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"

echo "==> 加入启用列表"
CUR="$(gsettings get org.gnome.Shell enabled-extensions)"
if [[ "$CUR" != *"$UUID"* ]]; then
    NEW="$(python3 - "$CUR" "$UUID" <<'PY'
import ast, sys
cur, uuid = sys.argv[1], sys.argv[2]
try:
    items = ast.literal_eval(cur)
except Exception:
    items = []
if uuid not in items:
    items.append(uuid)
print("[" + ", ".join("'%s'" % i for i in items) + "]")
PY
)"
    gsettings set org.gnome.Shell enabled-extensions "$NEW"
    echo "    已追加"
else
    echo "    已在列表中"
fi

echo
if [ "$UPDATING" = "1" ]; then
    echo "==> 这是覆盖更新：GJS 会缓存扩展代码，disable/enable 不会重新加载 .js，"
    echo "    必须重启 Shell 才会生效。"
fi
echo "==> 接下来（X11）：重启 GNOME Shell —— 按 Alt+F2，输入 r，回车"
echo "    （Wayland 会话需要注销重登）"
echo
echo "    打开设置：gnome-extensions prefs $UUID   （或右键面板上的小胶囊）"
