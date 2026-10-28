# TP-02A Runtime Behavior Inventory

This inventory is derived entirely from static control-flow and data-flow review of the recovered files. No application code or network request was executed.

## Initialization sequence

`app.js:723-731` performs the following sequence:

1. Bind all event listeners once.
2. Run the first group concurrently:
   - overview
   - VPS target catalog
   - current type target catalog
   - route result
   - bandwidth result
3. If the first group resolves, run latency chart, live values, and selected VPS status concurrently.
4. If an uncaught operation in either group rejects, set overall state to stale and replace chart-loading markup with a static failure message.
5. Install the 5-second and 60-second intervals even after the initialization catch path.
6. Install a visibility-change listener.

`loadBandwidth` catches its own errors and returns `false`, so a bandwidth failure alone does not reject the first group. Overview, target catalog, or unhandled shape/format failures can reject it and prevent the second group from starting.

## API request inventory

| Path | Function and lines | Trigger and cadence | Parameters and encoding | Cancellation/stale protection | UI consumption |
|---|---|---|---|---|---|
| `/api/overview` | `loadOverview`, `39-43` | Initial first group; again when live timestamp changes | None | No abort or request ID; live-triggered refreshes share `state.refreshPromise` | Overall class/label and last-update time |
| `/api/vps-targets` | `loadVpsTargets`, `131-141` | Initial first group only | None | No abort or request ID | VPS picker, allowed target list, stored/default target normalization |
| `/api/targets?type=...` | `loadTargets`, `109-122` | Initial first group; every ICMP/TCP type change | `type` uses `encodeURIComponent` | `targetRequest` prevents stale response application; fetch is not aborted | Chooses chart/live target and rerenders VPS picker |
| `/api/routes?...` | `loadRoute`, `454-488` | Initial first group; WAN, direction, protocol, or target change; inconsistent-target fallback | All parameters use `URLSearchParams` | Aborts previous route request, checks request ID, checks echoed query, and may recursively retry with first advertised target | Route status, timestamp, target options, hop table, expanded state |
| `/api/bandwidth?limit=200` | `loadBandwidth`, `711-720` | Initial first group; every 60 seconds while visible | Fixed query string; no client-side range | No abort, timeout, request ID, dedupe, or stale-response check | Eight speed cards and bandwidth status; trend summary is written into hidden content |
| `/api/latency?range=...&type=...&target=...` | `loadChart`, `342-367` | Initial second group; range, type, or VPS change; live timestamp change | Target uses `encodeURIComponent`; range/type come from static controls | Aborts previous chart request, checks request ID and requested state, checks echoed type/target/range | Canvas, legend, sample count, range label, loading overlay |
| `/api/live?type=...&target=...` | `loadLive`, `176-197` | Initial second group; every 5 seconds while visible; visibility restoration; type or VPS change | Target uses `encodeURIComponent`; type comes from static controls | Request ID prevents old response writes; underlying requests are not aborted or deduplicated | Three WAN legend values, hidden live status, and overview/chart refresh on timestamp change |
| `/api/vps-status?target=...` | `loadVpsStatus`, `92-107` | Initial second group; every 5 seconds while visible; visibility restoration; VPS selection | Target uses `encodeURIComponent` | Request ID plus a shared in-flight promise for the same target | System panel status, uptime, CPU, memory, storage, upload/download rate and bars |

No request to `/api/health` or `/api/summary` exists in the recovered client.

## Error handling by request

| Flow | Error behavior |
|---|---|
| Overview | Propagates to caller; initial failure enters global init catch, refresh failure is caught by the surrounding live request |
| VPS targets | Propagates; initial failure enters global init catch |
| Type targets | Propagates; initial failure enters global init catch; interactive failure can become an unhandled event-handler rejection |
| Route | Aborted requests return quietly; other errors clear timestamp and replace the route with an unavailable empty state |
| Bandwidth | Logs to console and changes only the section status text; old card values/states remain |
| Latency | Aborted requests return quietly; other errors propagate after `finally` hides the overlay |
| Live | Logs, adds a stale class, and replaces hidden live-status markup; previous legend values remain |
| VPS status | Renders stale/unavailable values and clears metric bars; logs the error |

`getJSON` throws on non-2xx and JSON parsing failures. It does not expose response bodies, enforce content type, enforce a timeout, or validate the parsed shape.

## Timers and lifecycle events

| Mechanism | Line | Period/trigger | Guard | Risk |
|---|---:|---|---|---|
| Resize debounce | `528` | 120 ms after the last resize event | Previous timeout cleared | Redraw only; no fetch |
| Live/VPS interval | `727` | Every 5 seconds | Skips when `document.hidden` | VPS requests dedupe; live requests can overlap indefinitely |
| Bandwidth interval | `728` | Every 60 seconds | Skips when `document.hidden` | Requests can overlap and complete out of order |
| Visibility listener | `729` | When document becomes visible | Checks `document.hidden` | Can coincide with an interval tick; live has no in-flight guard |

Intervals are never cleared. For the expected single-page lifetime this is finite until unload, but repeated script initialization would duplicate timers and listeners. The recovered HTML loads the script once and calls `init()` once, so no repeated binding path is statically reachable in the current document.

## State inventory

### General state

`state` at `app.js:12` holds:

- selected test type and range
- current target and last selected VPS
- VPS catalog
- visible WAN set
- latency samples and chart geometry
- live-response key
- target/chart/live/VPS request counters
- overview/chart refresh promise
- chart abort controller
- VPS status in-flight promise and target

### Route state

`routeState` at `app.js:13` holds:

- WAN, direction, protocol, and target
- current target catalog
- hop rows and expansion state
- request counter and abort controller

### Bandwidth state

Bandwidth has no central state object. Each response is reduced directly into DOM card state. No last request ID, last successful timestamp, pending flag, stale flag, or controller is retained.

## Local storage

| Key | Read | Write | Default | Validation | Failure handling |
|---|---:|---:|---|---|---|
| `network-monitor-selected-vps` | `11` | `145` | `DMIT Premium` | Normalized against `/api/vps-targets` at `138-140` | Read/write exceptions are silently ignored |

No sample, route, bandwidth, authentication, or API response data is stored.

## DOM output categories

- Text nodes: overall label, timestamps, metrics, legends, chart captions, route summary, bandwidth values and status.
- HTML fragments: VPS buttons, tooltip, route controls/table/empty state, bandwidth summary, static status fragments.
- Attributes/properties: classes, `dataset.status`, `dataset.state`, title, disabled, selected value, and `aria-expanded`.
- Styles: clamped metric-bar width and pointer-derived tooltip position.
- Canvas: latency grid, series, failure marks, hover line, and points.

API data never becomes a dynamic URL attribute. All route and VPS HTML text/attributes use `escapeHtml`; measurement fields use numeric conversion or `textContent`.

## Interaction inventory

- Type buttons: update type, reload target catalog, chart, and live data.
- Range buttons: update range and reload chart.
- VPS picker: persists target and reloads chart, live data, and VPS status.
- WAN legend buttons: toggle local chart series without a request.
- Canvas pointer down/move/leave: draw or hide hover state and tooltip.
- Document pointer down: hides chart tooltip when outside chart.
- Route expand buttons: toggle preview/full rows.
- Route WAN, direction, protocol buttons and target select: abort and reload route data.
- Window resize: debounced chart redraw.
- Visibility restoration: immediately reloads live and VPS status data.

Most selected-state styling uses an `active` class. Only VPS options use `aria-pressed`; route expansion uses `aria-expanded`.
