#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

readonly CONFIRMATION_VALUE="MONITOR-GATEWAY-PRIVATE-STAGING-ROLLBACK"
readonly SERVICE_USER="monitor-gateway"
readonly SERVICE_GROUP="monitor-gateway"
readonly PLATFORM_ROOT="/opt/network-service-platform"
readonly GATEWAY_ROOT="/opt/network-service-platform/monitor-gateway"
readonly RELEASE_ROOT="/opt/network-service-platform/monitor-gateway/releases"
readonly CURRENT_LINK="/opt/network-service-platform/monitor-gateway/current"
readonly ENV_ROOT="/etc/monitor-gateway"
readonly RUNTIME_PKI_ROOT="/etc/monitor-gateway/pki"
readonly WIREGUARD_ROOT="/etc/wireguard"
readonly PRIVATE_UNIT="/etc/systemd/system/monitor-gateway-private.service"
readonly PUBLIC_UNIT="/etc/systemd/system/monitor-gateway-public.service"

script_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
preflight="$script_root/preflight.py"

fail() {
  printf '%s\n' "ROLLBACK_BLOCKED: $1" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    "usage: rollback-root.sh PHASE --confirm TOKEN --manifest FILE --expected-release-sha SHA --backup-dir DIR" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
phase="$1"
shift
confirm=""
manifest=""
release_sha=""
backup_dir=""

while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --confirm) confirm="$2" ;;
    --manifest) manifest="$2" ;;
    --expected-release-sha) release_sha="$2" ;;
    --backup-dir) backup_dir="$2" ;;
    *) usage ;;
  esac
  shift 2
done

case "$phase" in
  precheck|rollback|postcheck) ;;
  *) usage ;;
esac
[[ "$confirm" == "$CONFIRMATION_VALUE" ]] || fail "confirmation token mismatch"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid release SHA"
for required_path in "$manifest" "$backup_dir"; do
  [[ "$required_path" == /* ]] || fail "all paths must be absolute"
  [[ "$required_path" != "/" ]] || fail "broad path forbidden"
done

preflight_args=(
  --manifest "$manifest"
  --expected-release-sha "$release_sha"
  --backup-dir "$backup_dir"
  --phase rollback
)
/usr/bin/python3 "$preflight" "${preflight_args[@]}"

if [[ "$phase" == "precheck" ]]; then
  printf '%s\n' "ROLLBACK_PRECHECK: PASS"
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || fail "root is required for rollback"
record="$backup_dir/backup-record.json"
manifest="$backup_dir/execution-manifest.json"

record_boolean() {
  /usr/bin/python3 - "$record" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)[sys.argv[2]]
if not isinstance(value, bool):
    raise SystemExit(1)
sys.stdout.write("true" if value else "false")
PY
}

target_record() {
  /usr/bin/python3 - "$record" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    targets = json.load(handle)["targets"]
matches = [target for target in targets if target["targetId"] == sys.argv[2]]
if len(matches) != 1:
    raise SystemExit(1)
target = matches[0]
sys.stdout.write(target["state"] + "\t" + (target["backupFile"] or "-"))
PY
}

file_sha256() {
  /usr/bin/python3 - "$1" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
sys.stdout.write(digest.hexdigest())
PY
}

restore_file() {
  local target_id="$1"
  local target_path="$2"
  local mode="$3"
  local owner="$4"
  local group="$5"
  local state backup_name
  IFS=$'\t' read -r state backup_name <<<"$(target_record "$target_id")"
  case "$state" in
    absent)
      if [[ -e "$target_path" || -L "$target_path" ]]; then
        [[ -f "$target_path" || -L "$target_path" ]] || fail "rollback target type mismatch"
        rm -f -- "$target_path"
      fi
      ;;
    file)
      install -o "$owner" -g "$group" -m "$mode" -- "$backup_dir/$backup_name" "$target_path"
      ;;
    *) fail "rollback record state mismatch" ;;
  esac
}

restore_current_link() {
  local state backup_name previous_target link_temporary
  IFS=$'\t' read -r state backup_name <<<"$(target_record current-link)"
  case "$state" in
    absent)
      [[ ! -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]] || fail "current link is not a symlink"
      rm -f -- "$CURRENT_LINK"
      ;;
    symlink)
      previous_target="$(<"$backup_dir/$backup_name")"
      [[ "$previous_target" == "$RELEASE_ROOT/"* ]] || fail "previous release target outside release root"
      [[ -d "$previous_target" && ! -L "$previous_target" ]] || fail "previous release missing"
      link_temporary="$CURRENT_LINK.rollback.$$"
      [[ ! -e "$link_temporary" && ! -L "$link_temporary" ]] || fail "temporary rollback link exists"
      ln -s -- "$previous_target" "$link_temporary"
      mv -Tf -- "$link_temporary" "$CURRENT_LINK"
      ;;
    *) fail "current link backup state mismatch" ;;
  esac
}

manifest_value() {
  /usr/bin/python3 - "$manifest" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for component in sys.argv[2].split("."):
    value = value[component]
if not isinstance(value, (str, int)) or "\n" in str(value) or "\r" in str(value):
    raise SystemExit(1)
sys.stdout.write(str(value))
PY
}

interface_name="$(manifest_value network.wireguard.interfaceName)"
wireguard_target="/etc/wireguard/$interface_name.conf"
release_target="$RELEASE_ROOT/$release_sha"

if [[ "$phase" == "rollback" ]]; then
  systemctl stop monitor-gateway-public.service || fail "public service did not stop"
  systemctl is-active --quiet monitor-gateway-public.service && fail "public service remains active"
  systemctl stop monitor-gateway-private.service || fail "private service did not stop"
  systemctl is-active --quiet monitor-gateway-private.service && fail "private service remains active"

  restore_current_link

  if wg show "$interface_name" >/dev/null 2>&1; then
    wg-quick down "$wireguard_target" >/dev/null 2>&1 || fail "WireGuard shutdown failed"
  fi

  restore_file public-unit "$PUBLIC_UNIT" 0644 root root
  restore_file private-unit "$PRIVATE_UNIT" 0644 root root
  restore_file wireguard-config "$wireguard_target" 0600 root root
  restore_file raw-monitor-ca "$RUNTIME_PKI_ROOT/raw-monitor-ca.pem" 0640 root "$SERVICE_GROUP"
  restore_file public-bff-next-key "$RUNTIME_PKI_ROOT/public-bff-client-next.key" 0640 root "$SERVICE_GROUP"
  restore_file public-bff-next-cert "$RUNTIME_PKI_ROOT/public-bff-client-next.crt" 0640 root "$SERVICE_GROUP"
  restore_file public-bff-key "$RUNTIME_PKI_ROOT/public-bff-client.key" 0640 root "$SERVICE_GROUP"
  restore_file public-bff-cert "$RUNTIME_PKI_ROOT/public-bff-client.crt" 0640 root "$SERVICE_GROUP"
  restore_file private-server-key "$RUNTIME_PKI_ROOT/private-server.key" 0640 root "$SERVICE_GROUP"
  restore_file private-server-cert "$RUNTIME_PKI_ROOT/private-server.crt" 0640 root "$SERVICE_GROUP"
  restore_file private-ca "$RUNTIME_PKI_ROOT/private-ca.pem" 0640 root "$SERVICE_GROUP"
  restore_file public-server-key "$RUNTIME_PKI_ROOT/public-server.key" 0640 root "$SERVICE_GROUP"
  restore_file public-server-cert "$RUNTIME_PKI_ROOT/public-server.crt" 0640 root "$SERVICE_GROUP"
  restore_file public-ca "$RUNTIME_PKI_ROOT/public-ca.pem" 0640 root "$SERVICE_GROUP"
  restore_file public-env "$ENV_ROOT/public.env" 0640 root "$SERVICE_GROUP"
  restore_file private-env "$ENV_ROOT/private.env" 0640 root "$SERVICE_GROUP"
  systemctl daemon-reload

  if [[ "$(record_boolean releaseTargetExisted)" == "false" && -e "$release_target" ]]; then
    [[ -d "$release_target" && ! -L "$release_target" ]] || fail "release rollback target unsafe"
    [[ -f "$release_target/.monitor-gateway-release-sha" && ! -L "$release_target/.monitor-gateway-release-sha" ]] || fail "release rollback marker missing"
    [[ "$(<"$release_target/.monitor-gateway-release-sha")" == "$release_sha" ]] || fail "release rollback SHA mismatch"
    find "$release_target" -depth -delete
  fi

  if [[ "$(record_boolean wireguardWasActive)" == "true" ]]; then
    wg-quick up "$wireguard_target" >/dev/null 2>&1 || fail "previous WireGuard state restore failed"
  fi
  if [[ "$(record_boolean privateServiceWasActive)" == "true" ]]; then
    systemctl start monitor-gateway-private.service
  fi
  if [[ "$(record_boolean publicServiceWasActive)" == "true" ]]; then
    systemctl start monitor-gateway-public.service
  fi

  if [[ "$(record_boolean pkiRootExisted)" == "false" ]]; then
    rmdir -- "$RUNTIME_PKI_ROOT" || fail "new PKI directory is not empty"
  fi
  if [[ "$(record_boolean envRootExisted)" == "false" ]]; then
    rmdir -- "$ENV_ROOT" || fail "new environment directory is not empty"
  fi
  if [[ "$(record_boolean wireguardRootExisted)" == "false" ]]; then
    rmdir -- "$WIREGUARD_ROOT" || fail "new WireGuard directory is not empty"
  fi
  if [[ "$(record_boolean releaseRootExisted)" == "false" ]]; then
    rmdir -- "$RELEASE_ROOT" || fail "new release root is not empty"
  fi
  if [[ "$(record_boolean gatewayRootExisted)" == "false" ]]; then
    rmdir -- "$GATEWAY_ROOT" || fail "new gateway root is not empty"
  fi
  if [[ "$(record_boolean platformRootExisted)" == "false" ]]; then
    rmdir -- "$PLATFORM_ROOT" || fail "new platform root is not empty"
  fi
  if [[ "$(record_boolean serviceUserExisted)" == "false" ]]; then
    pgrep -u "$SERVICE_USER" >/dev/null 2>&1 && fail "service user still owns a process"
    userdel "$SERVICE_USER"
  fi
  if [[ "$(record_boolean serviceGroupExisted)" == "false" ]]; then
    groupdel "$SERVICE_GROUP"
  fi
  printf '%s\n' "ROLLBACK: PASS"
  printf '%s\n' "BACKUP_EVIDENCE_PRESERVED: YES"
  printf '%s\n' "PUBLIC_CUTOVER: NOT_PERFORMED"
  exit 0
fi

if [[ "$phase" == "postcheck" ]]; then
  release_existed="$(record_boolean releaseTargetExisted)"
  if [[ "$release_existed" == "false" && -e "$release_target" ]]; then
    fail "new release residue remains"
  fi
  printf '%s\n' "ROLLBACK_POSTCHECK: PASS"
  printf '%s\n' "BACKUP_EVIDENCE_PRESERVED: YES"
  exit 0
fi

fail "unreachable phase"
