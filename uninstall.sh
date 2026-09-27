#!/usr/bin/env bash
# 卸载：禁用并移除扩展目录（图标会被原样还原回面板）
set -euo pipefail
UUID="tray-collapse@fnidore.top"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$DEST"
echo "已卸载 $UUID（若面板仍有残留，重启一次 Shell 或注销重登）"
