#!/bin/sh
set -u
BASE=/root/network-monitor
EVENTS="$BASE/collector-events.jsonl"
RUNNING=/tmp/network-monitor.running
RESULT="/tmp/network-monitor-result.$$"

start_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
start_epoch="$(date +%s)"
printf '%s\n' "$$" >"$RUNNING"

cleanup() {
    rm -f "$RUNNING" "$RESULT"
}
trap cleanup EXIT INT TERM

/usr/bin/timeout -k 2s 48s "$BASE/collect_once.sh" >"$RESULT" 2>&1
rc=$?
end_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
end_epoch="$(date +%s)"
duration="$((end_epoch-start_epoch))"
samples="$(sed -n 's/.*"accepted":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RESULT" | tail -n 1)"
rejected="$(sed -n 's/.*"rejected":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RESULT" | tail -n 1)"
[ -n "$samples" ] || samples=0
[ -n "$rejected" ] || rejected=0

case "$rc" in
    0)
        if [ "$samples" -eq 54 ] && [ "$rejected" -eq 0 ]; then
            status=ok
        else
            status=response_count_error
            rc=65
        fi
        ;;
    124|137) status=timeout ;;
    *) status=collector_error ;;
esac

printf '{"start":"%s","end":"%s","duration_seconds":%s,"samples":%s,"rejected":%s,"overlap":false,"status":"%s","exit_code":%s}\n' \
    "$start_time" "$end_time" "$duration" "$samples" "$rejected" "$status" "$rc" >>"$EVENTS"
cat "$RESULT"
exit "$rc"
