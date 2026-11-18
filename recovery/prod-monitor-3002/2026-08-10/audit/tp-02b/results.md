# TP-02B Isolated Fixture Dynamic Validation

- Generated at: 2026-08-09T21:28:05.085Z
- Baseline: `9236e665063ae35e6afb50d71e81312f8c71bde3`
- Runtime: v23.11.0; Google Chrome 151.0.7922.108
- Scenarios: 23
- Status counts: PASS 5, CONFIRMED_FINDING 18, INCONCLUSIVE 0, HARNESS_ERROR 0
- Non-localhost requests: 0

## Dynamic conclusions

Confirmed TP-02A findings: `TP02A-001`, `TP02A-002`, `TP02A-003`, `TP02A-004`, `TP02A-005`, `TP02A-006`, `TP02A-007`, `TP02A-008`, `TP02A-009`, `TP02A-010`, `TP02A-011`, `TP02A-012`.

The no-DOM-injection conclusion in `TP02A-014` was also supported: HTML-special and inert script/img/onerror marker strings remained literal text or escaped attributes, with no executable nodes or event attributes created.

New observed behavior: a late older bandwidth request can overwrite a newer completed render because bandwidth has no request identity or stale-response guard (`TP02B-010`). Partial/one-direction bandwidth success is also classified as `ready`, not a distinct partial state.

No TP-02A fixture-targeted finding failed to reproduce. `TP02A-013`, `TP02A-015`, and `TP02A-016` are static/deployment/storage observations and were not dynamic fixture targets. The visibility test is marked with an explicit lifecycle-emulation limitation, and programmatic accessibility inspection is not a screen-reader certification.

## Scenario results

| ID | Status | Scenario | Related findings |
|---|---|---|---|
| TP02B-001 | PASS | Baseline successful initialization | — |
| TP02B-002 | CONFIRMED_FINDING | live non-2xx and invalid JSON after a successful render | TP02A-003 |
| TP02B-003 | CONFIRMED_FINDING | latency non-2xx and invalid JSON after a successful render | TP02A-004 |
| TP02B-004 | PASS | route non-2xx and invalid JSON after a successful render | — |
| TP02B-005 | CONFIRMED_FINDING | bandwidth non-2xx and invalid JSON after a successful render | TP02A-002 |
| TP02B-006 | PASS | Connection refused after successful initialization | TP02A-002, TP02A-003, TP02A-004 |
| TP02B-007 | CONFIRMED_FINDING | Live response exceeds five-second polling period | TP02A-001 |
| TP02B-008 | CONFIRMED_FINDING | Bandwidth response exceeds sixty-second polling period | TP02A-001 |
| TP02B-009 | PASS | Rapid VPS, range, WAN, and protocol switching with out-of-order responses | — |
| TP02B-010 | CONFIRMED_FINDING | Out-of-order bandwidth completion | — |
| TP02B-011 | CONFIRMED_FINDING | Initial latency failure visibility | TP02A-004 |
| TP02B-012 | CONFIRMED_FINDING | Latency range-switch failure visibility | TP02A-004 |
| TP02B-013 | CONFIRMED_FINDING | Latency VPS-switch failure visibility | TP02A-004 |
| TP02B-014 | CONFIRMED_FINDING | Missing target array during initialization | TP02A-007 |
| TP02B-015 | CONFIRMED_FINDING | Null nested overview object | TP02A-007 |
| TP02B-016 | CONFIRMED_FINDING | Non-object live response | TP02A-003, TP02A-007 |
| TP02B-017 | CONFIRMED_FINDING | Null latency samples array | TP02A-004, TP02A-007 |
| TP02B-018 | CONFIRMED_FINDING | Invalid timestamps, unknown WAN, NaN, negative, and extreme numbers | TP02A-007, TP02A-011 |
| TP02B-019 | PASS | HTML-special and script/img/onerror marker strings | TP02A-014 |
| TP02B-020 | CONFIRMED_FINDING | Bandwidth duplicate, unordered, one-way, partial, disabled, and unknown rows | TP02A-005, TP02A-008, TP02A-009 |
| TP02B-021 | CONFIRMED_FINDING | Route target fallback recursion ceiling | TP02A-010 |
| TP02B-022 | CONFIRMED_FINDING | Visibility restoration collides with five-second timer | TP02A-001 |
| TP02B-023 | CONFIRMED_FINDING | Keyboard, live-region, and bandwidth status mapping | TP02A-006, TP02A-008, TP02A-012 |

## Priority recommendation (not implemented)

1. First: bound and deduplicate live/bandwidth polling; add bandwidth request identity to prevent stale overwrite.
2. Next: make stale/error states visible and prevent old live/bandwidth values from appearing current.
3. Then: validate endpoint schemas, cap route fallback, and select bandwidth rows by timestamp.
4. Finally: align bandwidth state tokens with CSS and add keyboard/text alternatives and live-region semantics.

## Fixture limits

- Deterministic synthetic values only; no production API, database, device, or protected address was used.
- Connection refusal is produced by stopping the localhost fixture after baseline, so all same-origin APIs become unavailable together.
- Visibility collision uses a synthetic `visibilitychange` event with `document.hidden === false`; operating-system tab occlusion was not emulated.
- Accessibility checks cover DOM focusability, ARIA/live-region presence, and computed CSS, not assistive-technology speech output.
- Chrome background networking was disabled and non-local page requests were intercepted; this validates page traffic, not host-wide packet capture.
