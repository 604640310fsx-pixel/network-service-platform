#!/bin/sh
set -eu
set -f

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
    printf '%s\n' "route runner rejected: $1" >&2
    exit 64
}

valid_ipv4() {
    candidate=$1
    old_ifs=$IFS
    IFS=.
    set -- $candidate
    IFS=$old_ifs
    [ "$#" -eq 4 ] || return 1
    for octet in "$@"; do
        case "$octet" in
            ''|*[!0-9]*) return 1 ;;
        esac
        [ "$octet" -ge 0 ] 2>/dev/null || return 1
        [ "$octet" -le 255 ] 2>/dev/null || return 1
    done
}

set -- ${SSH_ORIGINAL_COMMAND:-}
[ "$#" -ge 3 ] || fail "missing arguments"
[ "$1" = "route-return" ] || fail "unsupported command"

protocol=$2
target=$3
valid_ipv4 "$target" || fail "invalid IPv4 target"

NEXTTRACE=$(command -v nexttrace || true)
[ -n "$NEXTTRACE" ] || fail "nexttrace unavailable"
TIMEOUT=$(command -v timeout || true)
[ -n "$TIMEOUT" ] || fail "timeout unavailable"

case "$protocol" in
    icmp)
        [ "$#" -eq 3 ] || fail "unexpected ICMP arguments"
        exec "$TIMEOUT" 90 "$NEXTTRACE" --always-rdns --json --no-color "$target"
        ;;
    tcp)
        [ "$#" -eq 4 ] || fail "TCP port required"
        port=$4
        case "$port" in
            ''|*[!0-9]*) fail "invalid TCP port" ;;
        esac
        [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || fail "invalid TCP port"
        exec "$TIMEOUT" 90 "$NEXTTRACE" --tcp --port "$port" --always-rdns --json --no-color "$target"
        ;;
    *)
        fail "unsupported protocol"
        ;;
esac
