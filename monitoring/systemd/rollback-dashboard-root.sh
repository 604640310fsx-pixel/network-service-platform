#!/bin/sh
set -eu
systemctl disable --now network-monitor-dashboard.service || true
rm -f /etc/systemd/system/network-monitor-dashboard.service
systemctl daemon-reload
