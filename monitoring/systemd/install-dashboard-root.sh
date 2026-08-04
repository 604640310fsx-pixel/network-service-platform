#!/bin/sh
set -eu
SOURCE=/vol1/1000/network-monitor/systemd/network-monitor-dashboard.service
TARGET=/etc/systemd/system/network-monitor-dashboard.service
# 飞牛 systemd 无法解析此 NAS 账号作为 User=/Group=，服务按系统级 root 运行。
# Dashboard 仅开放只读 GET API，且 unit 使用 NoNewPrivileges/ProtectSystem 限权。
install -o root -g root -m 0644 "$SOURCE" "$TARGET"
systemctl daemon-reload
systemctl enable --now network-monitor-dashboard.service
systemctl --no-pager --full status network-monitor-dashboard.service
