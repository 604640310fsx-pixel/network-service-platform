# Private gateway deployment (account monitor projection)

Operator runbook for the private-mode gateway that lets Auth read the monitor
target catalog and per-target status over mTLS (admin VPS picker, buyer node
status, `/status`). Public mode is not deployed by this runbook.

```text
Auth host (Auth Service, client identity "auth_service")
  -> private link (overlay address of the monitor host, e.g. Tailscale)
  -> monitor-gateway private listener (mTLS, this directory)
  -> RAW_MONITOR_API_ORIGIN (loopback dashboard-next, provides customer_state)
```

The repository holds no addresses, certificates or keys. Placeholders below:

- `<LINK_IP>` — the monitor host's private-link address (Tailscale `100.64.0.0/10`
  is accepted by both the gateway bind check and Auth's private-origin check);
- `<PORT>` — a free port for the private listener (for example `3443`);
- `<SHA>` — the repository commit being installed.

Each numbered step is a separate production action; stop after each one and
record the evidence listed with it.

## 0. Preconditions (read-only)

- The raw source answers on loopback on the monitor host:
  `curl -s http://127.0.0.1:3013/api/vps-targets` returns `{"targets":[...]}`.
- `python3 --version` is 3.11+ and `openssl version` is 3.x on the monitor host.
- The Auth host reaches `<LINK_IP>:<PORT>`. With Tailscale, the tailnet ACL must
  allow the Auth host to that port (ACLs are per port; an existing rule for
  another port does not cover it). Check from the Auth host after step 3:
  `timeout 5 bash -c '</dev/tcp/<LINK_IP>/<PORT>' && echo open`.

## 1. Private CA and identities (monitor host, root)

Keys are generated where they are used and never copied: the CA, server and
public-BFF keys stay on the monitor host; the Auth client key is generated on
the Auth host and only its CSR (public) travels.

```bash
groupadd --system monitor-gateway
useradd --system --gid monitor-gateway --no-create-home --shell /usr/sbin/nologin monitor-gateway
install -d -m 0750 -o root -g monitor-gateway /etc/monitor-gateway /etc/monitor-gateway/pki
install -d -m 0700 -o root -g root /etc/monitor-gateway/ca
cd /etc/monitor-gateway
EC=(-newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes)
sign() { openssl x509 -req -in "$1" -CA pki/private-ca.pem -CAkey ca/private-ca.key \
  -CAserial ca/private-ca.srl -CAcreateserial -days 825 -out "$2" -extfile <(printf "$3"); }
CLIENT='basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n'

openssl req -x509 -new "${EC[@]}" -keyout ca/private-ca.key -out pki/private-ca.pem -days 3650 \
  -subj "/CN=nsp-monitor-private-ca" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl req -new "${EC[@]}" -keyout pki/private-server.key -out ca/private-server.csr \
  -subj "/CN=nsp-monitor-gateway-private"
sign ca/private-server.csr pki/private-server.crt \
  "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:<LINK_IP>\n"

# Required at gateway startup even though public mode is not deployed.
openssl req -new "${EC[@]}" -keyout pki/public-bff-client.key -out ca/public-bff-client.csr \
  -subj "/CN=nsp-monitor-public-bff"
sign ca/public-bff-client.csr pki/public-bff-client.crt "$CLIENT"
```

Auth host (root): generate the Auth client key and CSR, then copy only the CSR
to the monitor host (`/etc/monitor-gateway/ca/auth-service-client.csr`):

```bash
install -d -m 0700 -o root -g root /etc/network-service-platform/monitor-pki
cd /etc/network-service-platform/monitor-pki
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout auth-service-client.key -out auth-service-client.csr -subj "/CN=nsp-auth-service"
chmod 0600 auth-service-client.key
```

Monitor host: sign it, then fix ownership:

```bash
cd /etc/monitor-gateway
sign ca/auth-service-client.csr pki/auth-service-client.crt "$CLIENT"
chown root:monitor-gateway pki/*; chmod 0640 pki/*
openssl verify -CAfile pki/private-ca.pem pki/private-server.crt pki/public-bff-client.crt pki/auth-service-client.crt
for c in pki/*.pem pki/*.crt; do echo "$c $(openssl x509 -in "$c" -noout -fingerprint -sha256)"; done
```

Copy `pki/private-ca.pem` and `pki/auth-service-client.crt` (certificates only)
to the Auth host's `/etc/network-service-platform/monitor-pki/` as `private-ca.pem`
and `auth-service-client.crt`.

Evidence: the four SHA-256 fingerprints, `openssl verify` OK. Never record key bodies.

## 2. Install and start the gateway (monitor host, root)

```bash
R=/opt/network-service-platform/monitor-gateway
install -d -m 0755 $R/releases/<SHA>/monitoring
# copy monitoring/gateway/ from <SHA> (stdlib only; `monitoring` is a namespace package)
#   e.g. git archive <SHA> monitoring/gateway | tar -x -C $R/releases/<SHA>
ln -sfn $R/releases/<SHA> $R/current
install -m 0640 -o root -g monitor-gateway private.env.example /etc/monitor-gateway/private.env
#   fill PRIVATE_MONITOR_BIND_HOST=<LINK_IP> and PRIVATE_MONITOR_PORT=<PORT>
install -m 0644 deploy/systemd/monitor-gateway-private.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now monitor-gateway-private
```

Checks (evidence):

```bash
systemctl is-active monitor-gateway-private
ss -ltn | grep ':<PORT> '          # exactly <LINK_IP>:<PORT>, never 0.0.0.0 / public
P=/etc/monitor-gateway/pki
# Auth identity is checked from the Auth host in step 3; on the monitor host the
# public-BFF identity must be refused on the Auth routes and no cert must fail TLS:
curl -s -o /dev/null -w '%{http_code}\n' --cacert $P/private-ca.pem \
  --cert $P/public-bff-client.crt --key $P/public-bff-client.key https://<LINK_IP>:<PORT>/api/auth-service/targets   # 403
curl -s -o /dev/null -w '%{http_code}\n' --cacert $P/private-ca.pem https://<LINK_IP>:<PORT>/api/auth-service/targets  # 000 (handshake refused)
journalctl -u monitor-gateway-private --since -5min --no-pager
```

Rollback: `systemctl disable --now monitor-gateway-private`. Nothing else depends
on it until step 3, and Auth falls back to "monitor unavailable" if it stops later.

## 3. Auth host wiring (Auth host, root, inside a release window)

Auth reads three systemd credentials and two settings:

| Name | Kind | Value |
| --- | --- | --- |
| `monitor_private_ca_certificate` | `LoadCredential` | `/etc/network-service-platform/monitor-pki/private-ca.pem` |
| `monitor_auth_service_client_certificate` | `LoadCredential` | `/etc/network-service-platform/monitor-pki/auth-service-client.crt` |
| `monitor_auth_service_client_private_key` | `LoadCredential` | `/etc/network-service-platform/monitor-pki/auth-service-client.key` |
| `MONITOR_AUTH_PROJECTION_ENABLED` | env | `true` |
| `MONITOR_AUTH_PRIVATE_ORIGIN` | env | `https://<LINK_IP>:<PORT>` |

Pre-check from the Auth host with the real client identity (expect `200` and
`{"items":[...]}`):

```bash
M=/etc/network-service-platform/monitor-pki
curl -s --cacert $M/private-ca.pem --cert $M/auth-service-client.crt --key $M/auth-service-client.key \
  https://<LINK_IP>:<PORT>/api/auth-service/targets | head -c 200
```

systemd precedence matters on the current Auth unit:

- `EnvironmentFile=` values override `Environment=`, and the window drop-in
  resets `EnvironmentFile=`. Put the two settings in
  `/etc/network-service-platform/monitor-private.env` (root 0600, see
  `deploy/auth-host/monitor-private.env.example`) and add it as the **last**
  `EnvironmentFile=` line of the normal window drop-in, after any file that sets
  `MONITOR_AUTH_PROJECTION_ENABLED=false`.
- Remove `MONITOR_AUTH_PRIVATE_ORIGIN` from any `UnsetEnvironment=` line in the
  normal drop-in (an unset runs after the files are read and would drop it).
- Add the three `LoadCredential=` lines to the normal drop-in.
- Keep the quiescent drop-in unchanged: quiescent starts with the monitor origin absent.

Then restart Auth in the normal release window. Evidence: Auth `ready`, zero
error lines, and the process environment shows the flag `true` and the origin
present (do not print credential bodies).

Rollback: restore the previous normal drop-in (projection off) and restart Auth.
No data is written by the projection; rollback is code/config only.

## 4. Acceptance

- `GET /api/admin/monitor-targets` (admin session) returns the target list and
  the pending-service VPS picker is populated.
- `GET /api/me/node-status` for a buyer with a bound line returns
  `monitor: "available"` with real `online`/`offline`/`stale` states.
- A service opened without a VPS can be bound afterwards
  (`PATCH /api/admin/services/:id/delivery/:position`).
- From outside the private link, `https://<LINK_IP>:<PORT>` is unreachable and no
  public nginx location proxies `/api/auth-service/*`.
