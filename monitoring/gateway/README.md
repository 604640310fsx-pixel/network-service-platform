# Public/private monitor gateway

This directory is the repository-only implementation for
`MONITOR-PUBLIC-PRIVATE-GATEWAY-01`. It does not connect to FNOS on import, does
not install a connector, and contains no deployment address, certificate, key,
DNS name, or production value.

The governing frozen record is
[`docs/architecture/MONITOR-PUBLIC-PRIVATE-GATEWAY-01.md`](../../docs/architecture/MONITOR-PUBLIC-PRIVATE-GATEWAY-01.md).

The operator-only 3002 service remains unchanged. The gateway is two separate
TLS processes:

```text
anonymous browser
  -> public TLS listener
  -> GET /api/summary
  -> public-BFF mTLS client identity
  -> private TLS listener
  -> GET /api/public-summary
  -> fixed private raw reads
  -> new allowlisted response
```

The public listener cannot request a raw 3002 route. The private listener has no
static files, no CORS, and no write method. It enforces a path-scoped identity
matrix: public-BFF can read only `/api/public-summary`; Auth Service can read
only `/api/auth-service/targets` and `/api/auth-service/status`; operator and
unknown identities can read none of those routes. Raw operator access stays on
a separate private-only boundary.

The Auth routes implement the separately frozen
[`MONITOR-AUTH-PROJECTION-01`](../../docs/architecture/MONITOR-AUTH-PROJECTION-01.md).
They construct fresh exact projections and never return raw host, target,
metrics, topology, provider, traffic, subscription, database, certificate, or
error details.

## Public contract

The public origin preserves the existing root path semantics:

- `/` — sanitized page (`?view=mini|embed` and `?theme=light|dark` are display-only);
- `/master.css` and `/app.js` — identity-free static assets;
- `/api/summary` — the sanitized GET API.

`/api/summary` returns one envelope with exactly three entries:

```json
{
  "wans": [
    {
      "wanId": "telecom",
      "displayName": "电信",
      "status": "healthy",
      "latestLatencyMs": 12.3,
      "packetLossSummary": 0.0,
      "updatedAt": "2030-01-01T00:00:00Z",
      "stale": false,
      "trend": [12.0, 12.3]
    }
  ]
}
```

`latestLatencyMs` is omitted unless the latest probe succeeded. A trend point
may be `null` for a failed probe. `packetLossSummary` is the sanitized percentage
for the existing current window. Stale data keeps only its timestamp and state;
current latency, loss, and trend are cleared. An upstream failure never returns
an earlier successful response or fixture.

The public API is limited to 30 requests per minute for each direct client IP,
with a burst of ten. The server is TLS-only, so this per-client key is the actual
socket peer rather than an untrusted forwarding header.

## Runtime configuration boundaries

No runtime value has a default. Public mode requires:

- `PUBLIC_MONITOR_BIND_HOST`, `PUBLIC_MONITOR_PORT`;
- `PUBLIC_MONITOR_TLS_CERT_FILE`, `PUBLIC_MONITOR_TLS_KEY_FILE`;
- `FINAL_CANONICAL_WEBSITE_ORIGIN`;
- `MONITOR_API_ORIGIN` (private HTTPS authority only);
- `MONITOR_PRIVATE_CA_FILE`;
- `MONITOR_PUBLIC_BFF_CLIENT_CERT_FILE` and
  `MONITOR_PUBLIC_BFF_CLIENT_KEY_FILE`.

Private mode requires:

- `PRIVATE_MONITOR_BIND_HOST`, `PRIVATE_MONITOR_PORT`;
- `PRIVATE_MONITOR_TLS_CERT_FILE`, `PRIVATE_MONITOR_TLS_KEY_FILE`;
- `PRIVATE_MONITOR_CLIENT_CA_FILE`;
- `PUBLIC_BFF_IDENTITY_CERT_FILE`;
- `RAW_MONITOR_API_ORIGIN` (loopback/private authority only);
- `RAW_MONITOR_CA_FILE` only when that raw origin uses HTTPS.

`AUTH_SERVICE_IDENTITY_CERT_FILE` enables the dedicated, independently
revocable Auth Service route identity; `OPERATOR_IDENTITY_CERT_FILE` can model
the separately denied operator identity. If provided, each fingerprint must
differ from every other identity. The private listener rejects wildcard/public bind
addresses. `MONITOR_API_ORIGIN` accepts only a private HTTPS authority; neither
private origin can contain credentials, a path, query, or fragment.

The public CSP `frame-ancestors` value is generated from the required exact
`FINAL_CANONICAL_WEBSITE_ORIGIN`. No `X-Frame-Options` is emitted on the public
iframe response. The same exact origin is injected into a fixed HTML meta field;
the client accepts the versioned theme message only from that origin and the
immediate parent frame. It accepts no wildcard, customer value, target value, or
message reply channel. All public content and API responses are `no-store`; private
responses are exactly `no-store`. Neither listener emits CORS or cookies.

The Auth catalog response is exactly `{items:[{key,label,state}]}` with at most
100 unique source-ordered entries. The Auth status response is exactly
`{status,updatedAt,stale}`. Raw catalog and status reads are limited to 256 KiB
and 64 KiB respectively with the existing five-second raw timeout. All Auth
errors are nested `{error:{code}}`; redirects, flat errors, unknown fields,
oversized bodies, malformed JSON, and lifecycle inconsistencies fail closed.

`view=mini` renders the identity-free sidebar summary. `view=embed` hides the
gateway's duplicate banner so the website `/monitor` WorkbenchBanner remains the
single page header. Neither view changes the data contract.

## Public operator server status

`GET /api/server-status` on the public listener returns exactly
`{label,status,updatedAt,stale}` for the single operator server named by the
private listener's `PUBLIC_SERVER_STATUS_TARGET`. It reads the private
`/api/public-server-status` route, which only the public-BFF identity may call.
The target key is configured server-side, never accepted from a request and
never returned; `label` is the fixed neutral presentation label `节点01`, never
the catalog display label (which can carry provider identity). Missing,
inactive, invalid or unreachable targets collapse to `monitor_unavailable`
(`503`, or `504` on timeout) with no fallback. Queries are `404`; the route is
rate limited and leak-scanned like `/api/summary`. The website's public `/status`
page reads it and `/api/summary` through same-origin
`/api/public-monitor/server-status` and `/api/public-monitor/summary`.
Customer data stays on the authenticated Auth `/api/me/monitor-status`.

## Private listener deployment for the protected customer monitor flow

The authenticated customer flow is separate from the public `/status` page: the
customer's session-guarded Auth `GET /api/me/monitor-status` calls this private
listener's `/api/auth-service/targets` and `/api/auth-service/status` over mTLS.
The private ACL allows those two routes only for the Auth Service identity, so
`AUTH_SERVICE_IDENTITY_CERT_FILE` is optional for gateway startup but required
for this flow; without it every Auth call is `403` and the customer projection
reports unavailable.

Repository assets (no values, no deployment authority):

- `deploy/systemd/monitor-gateway-private.service`: unprivileged, hardened unit
  running `python3 -m monitoring.gateway.server private` from
  `/opt/network-service-platform/monitor-gateway/current` with
  `EnvironmentFile=/etc/monitor-gateway/private.env`.
- `deploy/private.env.example`: exactly the private-mode settings for this path.
  Certificate paths live under `/etc/monitor-gateway/pki/`. The raw source is
  the loopback-only `dashboard-next` backend that provides `customer_state`.
  The private bind host and port are empty so the listener fails closed until
  the approved private-link binding is filled in.

Remaining administrator preconditions, each outside this repository:

1. A `monitor-gateway` system user and the release/`current` layout on the
   monitor host.
2. A private CA, the private listener server certificate and key, and the
   public-BFF and Auth Service client identity certificates, each with a
   distinct fingerprint, in `/etc/monitor-gateway/pki/`.
3. The approved private-link address and port that the Auth host reaches; no
   public listener or public raw HTTP is exposed for this path.
4. Auth host configuration per `docs/ops/consolidated-release-bindings.md`
   (`MONITOR_AUTH_PROJECTION_ENABLED`, `MONITOR_AUTH_PRIVATE_ORIGIN`, and the three
   monitor credential logical names), after manager acceptance.
5. A customer account with a paid, opened service bound to an active target.

## Offline checks

These checks do not contact any remote service:

```sh
python3 -m unittest discover -s monitoring/gateway/tests -v
python3 -m py_compile monitoring/gateway/*.py
node --test monitoring/gateway/tests/static-app.test.cjs
node --check monitoring/gateway/static/app.js
```

## Loopback-only visual acceptance

The optional preview below uses the same public handler and frozen JSON
allowlist, but supplies identity-free fixture values without contacting any
origin. It binds only to `127.0.0.1`, displays `演示数据 · 非报价`, and is never
used as a production fallback:

```sh
python3 -m monitoring.gateway.offline_preview
```

Open the printed `http://127.0.0.1:<port>/?preview=fixture` URL. Stop the process
with `Ctrl+C`. This proves only the local rendering and public contract; it does
not prove FNOS, connector, mTLS deployment, website iframe, or production data.

For a local cross-origin iframe check only, the preview can allow one exact
loopback website origin:

```sh
python3 -m monitoring.gateway.offline_preview --parent-origin http://127.0.0.1:4173
```

Non-loopback parent origins are rejected by this preview helper. Production still
requires the separately supplied exact HTTPS `FINAL_CANONICAL_WEBSITE_ORIGIN`.

Starting either listener requires separately supplied certificates and runtime
values. This task does not authorize starting it against a real source or
deploying either mode.
