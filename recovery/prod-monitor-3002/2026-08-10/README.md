# prod-monitor-3002 static recovery evidence

This directory preserves a byte-for-byte capture of the public static resources served by the logical source alias `prod-monitor-3002`.

- Capture time (UTC): `2026-08-09T19:29:25Z`
- Evidence scope: the root HTML document and the CSS and JavaScript resources referenced by that document
- Purpose: support three-way comparison, security review, and later review of production-only logic

The files under `raw/` are evidence, not deployment artifacts. Do not format, refactor, minify, or deploy them directly. Integrity and response metadata are recorded in `manifest.json`.

Before any production logic is returned to the canonical implementation, a separate follow-up audit must review the recovered HTML and JavaScript, explain every difference, verify data handling and escaping, and add tests using sanitized fixtures. This directory does not authorize TP-02 or any deployment action.
