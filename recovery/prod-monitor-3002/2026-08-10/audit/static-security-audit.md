# TP-02A Static Security Audit

## Scope and baseline

- Audit type: offline static review only
- Baseline commit: `8b5d7fc0286d7d780819c4468660836e21d79861`
- Audited evidence: `raw/index.html`, `raw/master.css`, and `raw/app.js`
- Read-only comparison source: `monitoring/dashboard-next/static/`
- Application execution, HTTP requests, API reads, database access, and fixture execution: not performed

`node --check raw/app.js` completed successfully. This checks JavaScript syntax without loading the document or executing application logic.

## Overall risk conclusion

The recovered static client has **medium operational and data-freshness risk**. No critical or high-severity static finding was identified, and no confirmed DOM XSS path was found. The main risks are unbounded overlapping polling without request timeouts, stale values remaining visible after refresh failures, a chart error state that can remain hidden, unvalidated API shapes that can interrupt initialization, and pointer-only access to chart detail.

The production-only bandwidth logic adds the largest new risk surface. It introduces a new API request and timer without cancellation or stale-response protection, assumes response ordering, writes status tokens that do not match the recovered CSS, and updates a trend message inside a permanently hidden container.

## DOM sink inventory and data flow

The recovered JavaScript contains 12 `innerHTML` assignments. It contains no `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or dynamic script/style element creation.

| Sink | Lines | Source | Protection and reachability | Result |
|---|---:|---|---|---|
| VPS picker | `app.js:125-128` | `/api/vps-targets` names and labels | Both values pass through `escapeHtml`; active and availability flags become fixed class fragments | Reachable during initialization and VPS changes; no confirmed injection |
| Live status | `app.js:185`, `195` | Static literals | No response value is interpolated | Safe static markup |
| Chart tooltip | `app.js:336` | Latency samples selected from known WAN groups | WAN is constrained by `WAN_META`; timestamps are formatted by `Intl`; measurements pass through numeric formatting | Reachable by pointer interaction; no confirmed injection, but malformed values can throw |
| Route expand buttons | `app.js:389-392` | Boolean state and numeric hop count | Only fixed strings and array length are interpolated | Safe static/numeric markup |
| Route target options | `app.js:400` | `/api/routes` target names and labels | Attribute and text values pass through `escapeHtml` | Reachable on every route response; no confirmed injection |
| Route empty row | `app.js:409` | Summary label and locally built description | Both pass through `escapeHtml` | Reachable for empty/error routes; no confirmed injection |
| Route hop rows | `app.js:437-450` | `/api/routes` hop fields | Text and quoted attributes use `escapeHtml`; latency is converted to a number; class/data tokens are fixed booleans | Reachable when hops exist; no confirmed injection |
| Bandwidth summary | `app.js:698-700`, `705-707` | Locally counted integers | Only numeric counters and fixed text are interpolated | Safe, but the destination is hidden by HTML |
| Initial chart error | `app.js:726` | Static literal | No response value is interpolated | Safe static markup; visibility defect described below |

Other DOM writes use `textContent`, DOM properties, `dataset`, `classList`, or numeric styles. No dynamic URL, `src`, `href`, script, or stylesheet insertion was found.

The principal hardening exception is `setOverall` at `app.js:35`, where the API-provided status is concatenated into `className` without an allowlist. This does not create an HTML execution sink, but an unexpected status can change presentation classes.

## URL and request safety

- User/API-provided target names are encoded with `encodeURIComponent` for VPS, live, and latency requests.
- Route parameters are encoded by `URLSearchParams`.
- Type and range parameters are inserted directly only after selection from static button values.
- All request paths are same-origin absolute paths.
- `getJSON` checks `response.ok` and then parses JSON, but it has no timeout, content-type check, or schema validation.
- No credentials, Authorization header, cookie manipulation, WebSocket, EventSource, XHR, or beacon use was found.

## Storage review

The only storage key is `network-monitor-selected-vps` at `app.js:11` and `145`.

- Reads and writes are wrapped in `try/catch`, so disabled storage does not stop initialization.
- The default is `DMIT Premium`.
- A stored value is initially accepted as a string, then normalized against the `/api/vps-targets` response before the first VPS status request.
- No credentials, API responses, route data, or monitoring samples are persisted.
- Storage failures are silently ignored; this is acceptable for optional preference state but reduces diagnostics.

## HTML and resource security

- The document loads one same-origin stylesheet and one same-origin script.
- The favicon is an empty `data:` URL.
- No external origin, inline script, inline event attribute, dynamic import, or external font was found.
- The document contains no CSP meta policy and the static tags do not use Subresource Integrity.

The absence of document-level CSP or SRI is a defense-in-depth observation, not a confirmed exploitable vulnerability. HTTP response headers and the final deployment/proxy context are outside this offline evidence set and must be evaluated separately.

## State, concurrency, and failure behavior

- Latency and route requests use `AbortController`, request identifiers, and response-state checks.
- Target and VPS status flows use request identifiers; VPS status also deduplicates an in-flight request for the same target.
- Live polling uses a request identifier but does not abort or deduplicate the underlying fetch.
- Bandwidth polling has no controller, request identifier, or in-flight promise guard.
- Every timer is installed after `init` finishes or enters its catch block, so polling continues after partial initialization failure.
- Event listeners are registered once by the single bottom-of-document `init()` call. No repeated binding path was found.

Confirmed state defects are detailed in `findings.json`. In particular, live and bandwidth failures retain previous values, and the live failure indicator is hidden by `master.css:49`. A latency failure hides the loading overlay in `finally`; the outer error handler changes its markup without making it visible again.

## Accessibility observations

- Buttons and the route select are native controls.
- Route expansion updates `aria-expanded`.
- Dynamically generated VPS buttons include `aria-pressed`.
- The latency chart has an `aria-label`, but its detailed tooltip is pointer-only and has no keyboard or textual equivalent.
- Segmented controls generally express selection only with the `active` class, not `aria-pressed` or a tab role/state model.
- Overall status, live state, route result, chart loading, and bandwidth status have no live-region semantics.
- Dynamic table headers do not declare `scope`.

## Production-only delta risk

Compared with the repository candidate, the recovered client adds:

- Six bandwidth parsing/rendering functions.
- `/api/bandwidth?limit=200` on initial load.
- A 60-second visible-page bandwidth timer.
- Route target fallback and expanded-state preservation.
- A latency loading-overlay cleanup in `finally`.

The latency cleanup prevents a residual spinner but combines with the outer error handler to hide its error message. The route fallback is protected by abort and request IDs but can recursively retry if the server repeatedly returns an inconsistent target list. The bandwidth additions account for the overlapping poll, stale-card, response-ordering, state-token, and hidden-summary findings.

## TP-02B synthetic fixture scenarios

TP-02B should remain fully offline and cover at least:

1. Successful, empty, partial, and failed responses for every endpoint.
2. A successful live response followed by timeout, non-2xx, invalid JSON, and rejected fetch; verify stale values are visibly marked or cleared.
3. A successful bandwidth response followed by failure; verify every card and timestamp cannot be mistaken for current data.
4. Live responses delayed beyond 5 seconds and bandwidth responses delayed beyond 60 seconds; count concurrent requests and test out-of-order completion.
5. Initial and interactive latency failures; verify the overlay exposes an error instead of becoming hidden.
6. Missing arrays, missing nested objects, unknown WANs, invalid timestamps, `NaN`, infinities, negative values, and extremely large numeric values.
7. HTML-special payloads in every name, label, route field, error field, and target field; assert no executable nodes or attributes are created.
8. Unexpected `overall.status` and route status strings; verify they cannot apply unintended presentation classes.
9. Duplicate and unsorted bandwidth rows; confirm selection is by explicit timestamp rather than array order.
10. Upload-only, download-only, mixed success/failure, disabled server, unknown server, zero throughput, null throughput, and missing timestamp cases.
11. A route response whose advertised target list repeatedly excludes the echoed query target; prove the fallback terminates.
12. Empty VPS target lists and an invalid stored VPS preference.
13. Rapid type, range, VPS, WAN, direction, protocol, and route-target changes; assert old responses cannot overwrite new state.
14. Hidden-to-visible transitions coinciding with timer ticks; assert duplicate live/status requests are bounded.
15. Keyboard-only chart and control navigation plus screen-reader observation of all dynamic states.
16. CSS assertions that success, partial, failed, disabled, and empty bandwidth states map to visible tokens.

No fixture or application execution was performed in TP-02A.
