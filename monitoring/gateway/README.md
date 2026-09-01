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
static files, no CORS, no write method, and only accepts the public-BFF identity
on `/api/public-summary`. Auth Service and operator certificates are modeled as
separate, independently revocable identities. Their routes are intentionally not
implemented here: customer/admin projection belongs to
`MONITOR-AUTH-PROJECTION-01`, while raw operator access stays on a separate
private-only boundary.

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

`AUTH_SERVICE_IDENTITY_CERT_FILE` and `OPERATOR_IDENTITY_CERT_FILE` are optional
in this task, but if provided their certificate fingerprints must differ from
every other identity. The private listener rejects wildcard/public bind
addresses. `MONITOR_API_ORIGIN` accepts only a private HTTPS authority; neither
private origin can contain credentials, a path, query, or fragment.

The public CSP `frame-ancestors` value is generated from the required exact
`FINAL_CANONICAL_WEBSITE_ORIGIN`. No `X-Frame-Options` is emitted on the public
iframe response. The same exact origin is injected into a fixed HTML meta field;
the client accepts the versioned theme message only from that origin and the
immediate parent frame. It accepts no wildcard, customer value, target value, or
message reply channel. All public content and API responses are `no-store`; private
responses are `private, no-store`. Neither listener emits CORS or cookies.

`view=mini` renders the identity-free sidebar summary. `view=embed` hides the
gateway's duplicate banner so the website `/monitor` WorkbenchBanner remains the
single page header. Neither view changes the data contract.

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
