#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

readonly CONFIRMATION_VALUE="MONITOR-GATEWAY-PRIVATE-STAGING"
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
readonly PRIVATE_READINESS_TIMEOUT_SECONDS=30
readonly PRIVATE_READINESS_RETRY_INTERVAL_SECONDS=1
readonly PRIVATE_POSTCHECK_REFUSED_EXIT=10
readonly PRIVATE_POSTCHECK_TIMEOUT_EXIT=11
readonly PRIVATE_POSTCHECK_NOT_READY_EXIT=12

script_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
preflight="$script_root/preflight.py"

fail() {
  printf '%s\n' "INSTALL_BLOCKED: $1" >&2
  exit 1
}

fail_code() {
  local code="$1"
  local check="$2"
  printf '%s\n' "INSTALL_BLOCKED code=$code check=$check" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    "usage: install-root.sh PHASE --confirm TOKEN --manifest FILE --expected-release-sha SHA --artifact-dir DIR --rendered-dir DIR --pki-dir DIR --wireguard-config FILE --backup-dir DIR" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
phase="$1"
shift

confirm=""
manifest=""
release_sha=""
artifact_dir=""
rendered_dir=""
pki_dir=""
wireguard_config=""
backup_dir=""

while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --confirm) confirm="$2" ;;
    --manifest) manifest="$2" ;;
    --expected-release-sha) release_sha="$2" ;;
    --artifact-dir) artifact_dir="$2" ;;
    --rendered-dir) rendered_dir="$2" ;;
    --pki-dir) pki_dir="$2" ;;
    --wireguard-config) wireguard_config="$2" ;;
    --backup-dir) backup_dir="$2" ;;
    *) usage ;;
  esac
  shift 2
done

case "$phase" in
  precheck|install|network-up|activate-private|activate-public|postcheck) ;;
  *) usage ;;
esac

[[ "$confirm" == "$CONFIRMATION_VALUE" ]] || fail "confirmation token mismatch"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid release SHA"
for required_path in "$manifest" "$artifact_dir" "$rendered_dir" "$pki_dir" "$wireguard_config" "$backup_dir"; do
  [[ "$required_path" == /* ]] || fail "all paths must be absolute"
  [[ "$required_path" != "/" ]] || fail "broad path forbidden"
done

preflight_args=(
  --manifest "$manifest"
  --expected-release-sha "$release_sha"
  --artifact-dir "$artifact_dir"
  --rendered-dir "$rendered_dir"
  --pki-dir "$pki_dir"
  --wireguard-config "$wireguard_config"
  --backup-dir "$backup_dir"
)

if [[ "$phase" == "precheck" ]]; then
  exec /usr/bin/python3 "$preflight" "${preflight_args[@]}" --phase precheck
fi

[[ "$(id -u)" -eq 0 ]] || fail "root is required for mutating phases"

if [[ "$phase" != "install" ]]; then
  /usr/bin/python3 "$preflight" \
    --manifest "$manifest" \
    --expected-release-sha "$release_sha" \
    --backup-dir "$backup_dir" \
    --phase rollback
  manifest="$backup_dir/execution-manifest.json"
fi

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
fnos_address="$(manifest_value network.wireguard.fnosAddress)"
release_target="$RELEASE_ROOT/$release_sha"
wireguard_target="/etc/wireguard/$interface_name.conf"

run_installed_preflight() {
  local gate_phase="$1"
  /usr/bin/python3 "$preflight" \
    --manifest "$manifest" \
    --expected-release-sha "$release_sha" \
    --artifact-dir "$artifact_dir" \
    --rendered-dir "$rendered_dir" \
    --pki-dir "$RUNTIME_PKI_ROOT" \
    --wireguard-config "$wireguard_target" \
    --backup-dir "$backup_dir" \
    --require-runtime-ownership \
    --phase "$gate_phase"
}

private_service_state=""
classify_private_service_state() {
  local status
  if systemctl is-active --quiet monitor-gateway-private.service >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  case "$status" in
    0) private_service_state="active" ;;
    3|4) private_service_state="inactive" ;;
    *) fail_code private_service_active_check_failed activate_private ;;
  esac
}

start_private_service() {
  if ! systemctl start monitor-gateway-private.service >/dev/null 2>&1; then
    fail_code private_service_start_failed activate_private
  fi
}

require_private_service_active() {
  local inactive_code="$1"
  classify_private_service_state
  [[ "$private_service_state" == "active" ]] || fail_code "$inactive_code" activate_private
}

readiness_clock=""
read_readiness_clock() {
  readiness_clock="$SECONDS"
}

readiness_sleep() {
  local seconds="$1"
  sleep "$seconds" || fail_code private_readiness_wait_failed private_readiness
}

wait_for_private_readiness() {
  local deadline
  local last_failure="private_readiness_timeout"
  local remaining
  local status

  read_readiness_clock
  deadline=$((readiness_clock + PRIVATE_READINESS_TIMEOUT_SECONDS))
  while :; do
    require_private_service_active private_service_exited_during_readiness
    if run_installed_preflight private-postcheck >/dev/null 2>&1; then
      return 0
    else
      status=$?
    fi
    case "$status" in
      "$PRIVATE_POSTCHECK_REFUSED_EXIT") last_failure="private_readiness_refused" ;;
      "$PRIVATE_POSTCHECK_TIMEOUT_EXIT") last_failure="private_readiness_probe_timeout" ;;
      "$PRIVATE_POSTCHECK_NOT_READY_EXIT") last_failure="private_readiness_timeout" ;;
      *) fail_code private_readiness_check_failed private_postcheck ;;
    esac

    read_readiness_clock
    ((readiness_clock < deadline)) || break
    remaining=$((deadline - readiness_clock))
    if ((remaining < PRIVATE_READINESS_RETRY_INTERVAL_SECONDS)); then
      readiness_sleep "$remaining"
    else
      readiness_sleep "$PRIVATE_READINESS_RETRY_INTERVAL_SECONDS"
    fi
  done

  require_private_service_active private_service_exited_during_readiness
  fail_code "$last_failure" private_readiness
}

if [[ "$phase" == "install" ]]; then
  /usr/bin/python3 "$preflight" "${preflight_args[@]}" --phase precheck

  release_temporary=""
  cleanup_release_temporary() {
    if [[ -n "$release_temporary" && -d "$release_temporary" && ! -L "$release_temporary" ]]; then
      find "$release_temporary" -depth -delete
    fi
  }
  trap cleanup_release_temporary EXIT

  release_preexisted=false
  service_user_preexisted=false
  service_group_preexisted=false
  private_service_was_active=false
  public_service_was_active=false
  wireguard_was_active=false
  platform_root_existed=false
  gateway_root_existed=false
  release_root_existed=false
  env_root_existed=false
  pki_root_existed=false
  wireguard_root_existed=false
  [[ -e "$release_target" ]] && release_preexisted=true
  getent passwd "$SERVICE_USER" >/dev/null && service_user_preexisted=true
  getent group "$SERVICE_GROUP" >/dev/null && service_group_preexisted=true
  systemctl is-active --quiet monitor-gateway-private.service && private_service_was_active=true
  systemctl is-active --quiet monitor-gateway-public.service && public_service_was_active=true
  wg show "$interface_name" >/dev/null 2>&1 && wireguard_was_active=true
  [[ -d "$PLATFORM_ROOT" ]] && platform_root_existed=true
  [[ -d "$GATEWAY_ROOT" ]] && gateway_root_existed=true
  [[ -d "$RELEASE_ROOT" ]] && release_root_existed=true
  [[ -d "$ENV_ROOT" ]] && env_root_existed=true
  [[ -d "$RUNTIME_PKI_ROOT" ]] && pki_root_existed=true
  [[ -d "$WIREGUARD_ROOT" ]] && wireguard_root_existed=true

  for existing_directory in \
    "$PLATFORM_ROOT" "$GATEWAY_ROOT" "$RELEASE_ROOT" \
    "$ENV_ROOT" "$RUNTIME_PKI_ROOT" "$WIREGUARD_ROOT"; do
    if [[ -e "$existing_directory" || -L "$existing_directory" ]]; then
      [[ -d "$existing_directory" && ! -L "$existing_directory" ]] || fail "runtime directory target unsafe"
    fi
  done
  if [[ -L "$CURRENT_LINK" ]]; then
    previous_current="$(readlink -- "$CURRENT_LINK")"
    [[ "$previous_current" == "$RELEASE_ROOT/"* ]] || fail "current release pointer outside release root"
    [[ -d "$previous_current" && ! -L "$previous_current" ]] || fail "current release target missing"
  elif [[ -e "$CURRENT_LINK" ]]; then
    fail "current release pointer is not a symlink"
  fi

  validate_managed_file_target() {
    local target_path="$1"
    [[ ! -L "$target_path" ]] || fail "managed file target is a symlink"
    if [[ -e "$target_path" ]]; then
      [[ -f "$target_path" ]] || fail "managed file target is not a regular file"
    fi
  }

  for managed_target in \
    "$ENV_ROOT/private.env" "$ENV_ROOT/public.env" \
    "$RUNTIME_PKI_ROOT/public-ca.pem" "$RUNTIME_PKI_ROOT/public-server.crt" \
    "$RUNTIME_PKI_ROOT/public-server.key" "$RUNTIME_PKI_ROOT/private-ca.pem" \
    "$RUNTIME_PKI_ROOT/private-server.crt" "$RUNTIME_PKI_ROOT/private-server.key" \
    "$RUNTIME_PKI_ROOT/public-bff-client.crt" "$RUNTIME_PKI_ROOT/public-bff-client.key" \
    "$RUNTIME_PKI_ROOT/public-bff-client-next.crt" "$RUNTIME_PKI_ROOT/public-bff-client-next.key" \
    "$RUNTIME_PKI_ROOT/raw-monitor-ca.pem" "$wireguard_target" \
    "$PRIVATE_UNIT" "$PUBLIC_UNIT"; do
    validate_managed_file_target "$managed_target"
  done

  install -d -m 0700 -- "$backup_dir"
  install -m 0600 -- "$manifest" "$backup_dir/execution-manifest.json"
  record_tsv="$backup_dir/backup-record.tsv"
  : >"$record_tsv"
  chmod 0600 "$record_tsv"

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

  backup_one() {
    local target_id="$1"
    local target_path="$2"
    local backup_name="$3"
    if [[ "$target_id" == "current-link" ]]; then
      if [[ -L "$target_path" ]]; then
        readlink -- "$target_path" >"$backup_dir/$backup_name"
        chmod 0600 "$backup_dir/$backup_name"
        printf '%s\t%s\t%s\t%s\n' "$target_id" symlink "$backup_name" "$(file_sha256 "$backup_dir/$backup_name")" >>"$record_tsv"
      elif [[ ! -e "$target_path" ]]; then
        printf '%s\t%s\t%s\t%s\n' "$target_id" absent - - >>"$record_tsv"
      else
        fail "current release pointer is not a symlink"
      fi
      return
    fi
    [[ ! -L "$target_path" ]] || fail "managed file target is a symlink"
    if [[ -f "$target_path" ]]; then
      install -m 0600 -- "$target_path" "$backup_dir/$backup_name"
      printf '%s\t%s\t%s\t%s\n' "$target_id" file "$backup_name" "$(file_sha256 "$backup_dir/$backup_name")" >>"$record_tsv"
    elif [[ ! -e "$target_path" ]]; then
      printf '%s\t%s\t%s\t%s\n' "$target_id" absent - - >>"$record_tsv"
    else
      fail "unsupported existing target type"
    fi
  }

  backup_one current-link "$CURRENT_LINK" current-link.backup
  backup_one private-env "$ENV_ROOT/private.env" private-env.backup
  backup_one public-env "$ENV_ROOT/public.env" public-env.backup
  backup_one public-ca "$RUNTIME_PKI_ROOT/public-ca.pem" public-ca.backup
  backup_one public-server-cert "$RUNTIME_PKI_ROOT/public-server.crt" public-server-cert.backup
  backup_one public-server-key "$RUNTIME_PKI_ROOT/public-server.key" public-server-key.backup
  backup_one private-ca "$RUNTIME_PKI_ROOT/private-ca.pem" private-ca.backup
  backup_one private-server-cert "$RUNTIME_PKI_ROOT/private-server.crt" private-server-cert.backup
  backup_one private-server-key "$RUNTIME_PKI_ROOT/private-server.key" private-server-key.backup
  backup_one public-bff-cert "$RUNTIME_PKI_ROOT/public-bff-client.crt" public-bff-cert.backup
  backup_one public-bff-key "$RUNTIME_PKI_ROOT/public-bff-client.key" public-bff-key.backup
  backup_one public-bff-next-cert "$RUNTIME_PKI_ROOT/public-bff-client-next.crt" public-bff-next-cert.backup
  backup_one public-bff-next-key "$RUNTIME_PKI_ROOT/public-bff-client-next.key" public-bff-next-key.backup
  backup_one raw-monitor-ca "$RUNTIME_PKI_ROOT/raw-monitor-ca.pem" raw-monitor-ca.backup
  backup_one wireguard-config "$wireguard_target" wireguard-config.backup
  backup_one private-unit "$PRIVATE_UNIT" private-unit.backup
  backup_one public-unit "$PUBLIC_UNIT" public-unit.backup

  /usr/bin/python3 - "$record_tsv" "$backup_dir/backup-record.json" "$release_sha" \
    "$release_preexisted" "$service_user_preexisted" "$service_group_preexisted" \
    "$private_service_was_active" "$public_service_was_active" "$wireguard_was_active" \
    "$platform_root_existed" "$gateway_root_existed" "$release_root_existed" \
    "$env_root_existed" "$pki_root_existed" "$wireguard_root_existed" \
    "$backup_dir/execution-manifest.json" <<'PY'
import hashlib
import json
import os
import sys

targets = []
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        target_id, state, backup_file, digest = line.rstrip("\n").split("\t")
        targets.append({
            "targetId": target_id,
            "state": state,
            "backupFile": None if backup_file == "-" else backup_file,
            "sha256": None if digest == "-" else digest,
        })
with open(sys.argv[16], encoding="utf-8") as handle:
    manifest_document = json.load(handle)
document = {
    "schemaVersion": "MGW-BACKUP-RECORD-V1",
    "releaseSha": sys.argv[3],
    "manifestSha256": hashlib.sha256(json.dumps(
        manifest_document,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")).hexdigest(),
    "releaseTargetExisted": sys.argv[4] == "true",
    "serviceUserExisted": sys.argv[5] == "true",
    "serviceGroupExisted": sys.argv[6] == "true",
    "privateServiceWasActive": sys.argv[7] == "true",
    "publicServiceWasActive": sys.argv[8] == "true",
    "wireguardWasActive": sys.argv[9] == "true",
    "platformRootExisted": sys.argv[10] == "true",
    "gatewayRootExisted": sys.argv[11] == "true",
    "releaseRootExisted": sys.argv[12] == "true",
    "envRootExisted": sys.argv[13] == "true",
    "pkiRootExisted": sys.argv[14] == "true",
    "wireguardRootExisted": sys.argv[15] == "true",
    "targets": targets,
}
descriptor = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump(document, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
PY
  rm -f -- "$record_tsv"

  if ! getent group "$SERVICE_GROUP" >/dev/null; then
    groupadd --system "$SERVICE_GROUP"
  fi
  if ! getent passwd "$SERVICE_USER" >/dev/null; then
    useradd --system --gid "$SERVICE_GROUP" --home-dir /nonexistent \
      --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  passwd_record="$(getent passwd "$SERVICE_USER")"
  group_record="$(getent group "$SERVICE_GROUP")"
  [[ "$(cut -d: -f4 <<<"$passwd_record")" == "$(cut -d: -f3 <<<"$group_record")" ]] || fail "service user group mismatch"
  [[ "$(cut -d: -f6 <<<"$passwd_record")" == "/nonexistent" ]] || fail "service user home mismatch"
  [[ ! -e /nonexistent ]] || fail "service user home must not exist"
  case "$(cut -d: -f7 <<<"$passwd_record")" in
    /usr/sbin/nologin|/sbin/nologin) ;;
    *) fail "service user login shell mismatch" ;;
  esac

  ensure_directory() {
    local target_path="$1"
    local expected_mode="$2"
    local expected_owner="$3"
    local expected_group="$4"
    if [[ -e "$target_path" || -L "$target_path" ]]; then
      [[ -d "$target_path" && ! -L "$target_path" ]] || fail "runtime directory target unsafe"
      [[ "$(stat -c %a -- "$target_path")" == "$expected_mode" ]] || fail "runtime directory mode mismatch"
      [[ "$(stat -c %U -- "$target_path")" == "$expected_owner" ]] || fail "runtime directory owner mismatch"
      [[ "$(stat -c %G -- "$target_path")" == "$expected_group" ]] || fail "runtime directory group mismatch"
    else
      install -d -o "$expected_owner" -g "$expected_group" -m "0$expected_mode" -- "$target_path"
    fi
  }

  ensure_directory "$PLATFORM_ROOT" 755 root root
  ensure_directory "$GATEWAY_ROOT" 755 root root
  ensure_directory "$RELEASE_ROOT" 755 root root
  ensure_directory "$ENV_ROOT" 750 root "$SERVICE_GROUP"
  ensure_directory "$RUNTIME_PKI_ROOT" 750 root "$SERVICE_GROUP"
  ensure_directory "$WIREGUARD_ROOT" 700 root root

  if [[ ! -e "$release_target" ]]; then
    release_temporary="$RELEASE_ROOT/.install-$release_sha-$$"
    [[ ! -e "$release_temporary" ]] || fail "temporary release target exists"
    cp -a -- "$artifact_dir" "$release_temporary"
    find "$release_temporary" -exec chown root:root {} +
    find "$release_temporary" -type d -exec chmod 0555 {} +
    find "$release_temporary" -type f -exec chmod 0444 {} +
    mv -- "$release_temporary" "$release_target"
    release_temporary=""
  else
    [[ -d "$release_target" && ! -L "$release_target" ]] || fail "release target unsafe"
    [[ -f "$release_target/.monitor-gateway-release-sha" && ! -L "$release_target/.monitor-gateway-release-sha" ]] || fail "existing release marker missing"
    [[ "$(<"$release_target/.monitor-gateway-release-sha")" == "$release_sha" ]] || fail "existing release SHA mismatch"
  fi

  install -o root -g "$SERVICE_GROUP" -m 0640 -- "$rendered_dir/private.env" "$ENV_ROOT/private.env"
  install -o root -g "$SERVICE_GROUP" -m 0640 -- "$rendered_dir/public.env" "$ENV_ROOT/public.env"
  for pki_name in \
    public-ca.pem public-server.crt public-server.key private-ca.pem \
    private-server.crt private-server.key public-bff-client.crt public-bff-client.key \
    public-bff-client-next.crt public-bff-client-next.key raw-monitor-ca.pem; do
    if [[ -f "$pki_dir/$pki_name" ]]; then
      install -o root -g "$SERVICE_GROUP" -m 0640 -- "$pki_dir/$pki_name" "$RUNTIME_PKI_ROOT/$pki_name"
    else
      case "$pki_name" in
        public-bff-client-next.crt|public-bff-client-next.key|raw-monitor-ca.pem)
          rm -f -- "$RUNTIME_PKI_ROOT/$pki_name"
          ;;
        *) fail "required PKI input missing" ;;
      esac
    fi
  done
  install -o root -g root -m 0600 -- "$wireguard_config" "$wireguard_target"
  install -o root -g root -m 0644 -- "$script_root/systemd/monitor-gateway-private.service" "$PRIVATE_UNIT"
  install -o root -g root -m 0644 -- "$script_root/systemd/monitor-gateway-public.service" "$PUBLIC_UNIT"
  systemctl daemon-reload
  run_installed_preflight rollback
  printf '%s\n' "INSTALL_STAGE: PASS"
  printf '%s\n' "CURRENT_LINK_SWITCHED: NO"
  printf '%s\n' "SERVICES_STARTED: NO"
  printf '%s\n' "NGINX_ROUTE_ACTIVATED: NO"
  exit 0
fi

run_installed_preflight rollback

if [[ "$phase" == "network-up" ]]; then
  if ! wg show "$interface_name" >/dev/null 2>&1; then
    wg-quick up "$wireguard_target" >/dev/null 2>&1 || fail "WireGuard activation failed"
  fi
  ip -4 route get "$fnos_address" oif "$interface_name" >/dev/null 2>&1 || fail "WireGuard route gate failed"
  printf '%s\n' "WIREGUARD_GATE: PASS"
  exit 0
fi

if [[ "$phase" == "activate-private" ]]; then
  wg show "$interface_name" >/dev/null 2>&1 || fail "WireGuard is not active"
  [[ ! -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]] || fail "current release pointer is not a symlink"
  [[ -f "$release_target/.monitor-gateway-release-sha" && ! -L "$release_target/.monitor-gateway-release-sha" ]] || fail "release marker missing"
  [[ "$(<"$release_target/.monitor-gateway-release-sha")" == "$release_sha" ]] || fail "release marker mismatch"
  link_temporary="$CURRENT_LINK.next.$$"
  [[ ! -e "$link_temporary" && ! -L "$link_temporary" ]] || fail "temporary link exists"
  ln -s -- "$release_target" "$link_temporary"
  mv -Tf -- "$link_temporary" "$CURRENT_LINK"
  start_private_service
  require_private_service_active private_service_not_active_after_start
  wait_for_private_readiness
  printf '%s\n' "PRIVATE_GATE: PASS"
  exit 0
fi

if [[ "$phase" == "activate-public" ]]; then
  systemctl is-active --quiet monitor-gateway-private.service || fail "private service is not active"
  systemctl start monitor-gateway-public.service
  systemctl is-active --quiet monitor-gateway-public.service
  run_installed_preflight postcheck
  nginx -t -c "$rendered_dir/nginx-candidate-root.conf" >/dev/null 2>&1
  printf '%s\n' "PUBLIC_LOOPBACK_GATE: PASS"
  printf '%s\n' "NGINX_CANDIDATE: PASS"
  printf '%s\n' "NGINX_ROUTE_ACTIVATED: NO"
  exit 0
fi

if [[ "$phase" == "postcheck" ]]; then
  systemctl is-active --quiet monitor-gateway-private.service
  systemctl is-active --quiet monitor-gateway-public.service
  run_installed_preflight postcheck
  nginx -t -c "$rendered_dir/nginx-candidate-root.conf" >/dev/null 2>&1
  printf '%s\n' "POSTCHECK: PASS"
  printf '%s\n' "PUBLIC_CUTOVER: NOT_PERFORMED"
  exit 0
fi

fail "unreachable phase"
