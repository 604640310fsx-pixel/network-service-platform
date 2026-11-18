# TP-02B Isolated Fixture Validation

This directory records dynamic validation of the byte-preserved `raw/index.html`, `raw/master.css`, and `raw/app.js` evidence against deterministic synthetic API fixtures.

## Safety boundary

- The fixture binds only to an ephemeral `127.0.0.1` port.
- It serves the three raw files without modification and implements only the eight API paths used by the recovered application.
- It has no proxy or forwarding code. Non-GET, non-loopback, wrong-host, and unmatched requests are rejected and recorded.
- The browser is launched with background networking disabled, a loopback-only host resolver policy, and page-request interception that blocks and records non-local HTTP, HTTPS, WebSocket, and secure WebSocket URLs.
- Fixtures contain synthetic labels, reserved documentation addresses, fixed timestamps, and invented measurements only.
- No production endpoint, candidate deployment, API, database, device, package installation, or application repair is part of this validation.

## Runtime and reproduction

The accepted run used Node.js 23.11.0, Google Chrome 151.0.7922.108, Node standard-library modules, and the Chrome DevTools Protocol. No npm package is required.

From the repository root:

```text
node recovery/prod-monitor-3002/2026-08-10/audit/tp-02b/run-tests.mjs
```

For harness diagnostics, one bounded scenario can be selected without changing application code:

```text
TP02B_ONLY=TP02B-001 node recovery/prod-monitor-3002/2026-08-10/audit/tp-02b/run-tests.mjs
```

The full run writes `results.json` and `results.md`. A nonzero `HARNESS_ERROR` count sets a nonzero process exit code. Application findings are recorded as `CONFIRMED_FINDING` and do not fail the harness process.

## Evidence interpretation

`results.json` is the machine-readable record, including request counts, maximum fixture concurrency, console errors, DOM evidence, network failures, and per-scenario limitations. `results.md` is the review summary. The raw evidence files are the test object and must not be replaced by these harness files or deployed directly.

The connection-refusal scenario stops only its localhost fixture. The visibility collision uses a synthetic `visibilitychange` event and does not claim operating-system tab-occlusion fidelity. Accessibility inspection is programmatic and does not replace assistive-technology testing.
