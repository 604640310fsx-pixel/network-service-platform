#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "must be run as root" >&2
    exit 77
fi

TIMERS="
evoxt-speedtest.timer
dmit-premium-speedtest.timer
dmit-eyeball-speedtest.timer
netlab-us1-speedtest.timer
netlab-hk1-speedtest.timer
zillion-network-speedtest.timer
yecaoyun-hk1-speedtest.timer
yecaoyun-hk2-speedtest.timer
alibaba-sg-speedtest.timer
"

BACKUP_ROOT=/vol1/1000/network-monitor/backups
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/legacy-speedtest-timers-$STAMP"
UNIT_BACKUP="$BACKUP_DIR/units"

umask 077
mkdir -p "$UNIT_BACKUP"

for timer in $TIMERS; do
    service=${timer%.timer}.service
    timer_path=$(systemctl show -p FragmentPath --value "$timer")
    service_path=$(systemctl show -p FragmentPath --value "$service")

    [ -f "$timer_path" ] || {
        echo "missing timer unit: $timer" >&2
        exit 78
    }
    [ -f "$service_path" ] || {
        echo "missing service unit: $service" >&2
        exit 78
    }
    systemctl is-enabled --quiet "$timer" || {
        echo "timer is not enabled as expected: $timer" >&2
        exit 78
    }
    if systemctl is-active --quiet "$service"; then
        echo "speedtest service is running; no changes made: $service" >&2
        exit 75
    fi

    cp -a "$timer_path" "$UNIT_BACKUP/$timer"
    cp -a "$service_path" "$UNIT_BACKUP/$service"
done

systemctl list-timers --all > "$BACKUP_DIR/timers-before.txt"
systemctl list-unit-files > "$BACKUP_DIR/unit-files-before.txt"

if ! systemctl disable --now $TIMERS; then
    echo "disable failed; restoring all nine timers" >&2
    systemctl enable --now $TIMERS >/dev/null 2>&1 || true
    exit 70
fi

failed=0
for timer in $TIMERS; do
    if systemctl is-enabled --quiet "$timer"; then
        echo "timer remains enabled: $timer" >&2
        failed=1
    fi
    if systemctl is-active --quiet "$timer"; then
        echo "timer remains active: $timer" >&2
        failed=1
    fi
done

if [ "$failed" -ne 0 ]; then
    echo "verification failed; restoring all nine timers" >&2
    systemctl enable --now $TIMERS >/dev/null 2>&1 || true
    exit 70
fi

systemctl list-timers --all > "$BACKUP_DIR/timers-after.txt"
systemctl list-unit-files > "$BACKUP_DIR/unit-files-after.txt"

{
    printf '%s\n' '# Run as root to restore the legacy timers.'
    printf '%s' 'systemctl enable --now'
    for timer in $TIMERS; do
        printf ' %s' "$timer"
    done
    printf '\n'
} > "$BACKUP_DIR/rollback-command.sh"
chmod 700 "$BACKUP_DIR/rollback-command.sh"

printf 'disabled_timers=9\n'
printf 'backup_dir=%s\n' "$BACKUP_DIR"
printf 'rollback=sudo %s/rollback-command.sh\n' "$BACKUP_DIR"

