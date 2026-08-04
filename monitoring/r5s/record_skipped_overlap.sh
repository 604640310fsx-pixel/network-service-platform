#!/bin/sh
set -u
BASE=/root/network-monitor
RUNNING=/tmp/network-monitor.running
EVENTS="$BASE/collector-events.jsonl"

if [ -r "$RUNNING" ]; then
    pid="$(sed -n '1p' "$RUNNING")"
    case "$pid" in
        ''|*[!0-9]*) exit 0 ;;
    esac
    if kill -0 "$pid" 2>/dev/null; then
        now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf '{"start":"%s","end":"%s","duration_seconds":0,"samples":0,"rejected":0,"overlap":true,"status":"skipped_overlap","exit_code":1}\n' \
            "$now" "$now" >>"$EVENTS"
    fi
fi
exit 0
