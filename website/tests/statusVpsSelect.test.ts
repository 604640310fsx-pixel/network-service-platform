import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
import { buildMonitorEmbedUrl, normalizeMonitorVps } from "../app/lib/monitorEmbed.ts";
// @ts-ignore TS5097
import { getLineMonitorTarget } from "../app/lib/line-monitor-target-api.ts";

const BASE = "https://monitor.example.invalid/";
const ORIGIN = "https://www.example.invalid";

test("the embed URL carries an optional, bounded vps preselection", () => {
  assert.equal(
    buildMonitorEmbedUrl(BASE, { theme: "light", lang: "zh", embedded: true, vps: "DMIT Eyeball" }, ORIGIN),
    "https://monitor.example.invalid/?view=embed&theme=light&lang=zh&vps=DMIT+Eyeball",
  );
  assert.equal(
    buildMonitorEmbedUrl(BASE, { theme: "dark", embedded: true, vps: null }, ORIGIN),
    "https://monitor.example.invalid/?view=embed&theme=dark",
  );
  for (const bad of ["", " lead", "trail ", "x".repeat(129), "line\nbreak", 5, undefined]) {
    assert.equal(normalizeMonitorVps(bad), null, JSON.stringify(bad));
  }
  // An incoming ?vps= on the configured base is never kept; only the resolved one is written.
  assert.equal(
    buildMonitorEmbedUrl(`${BASE}?vps=Other`, { theme: "dark", embedded: true }, ORIGIN),
    "https://monitor.example.invalid/?view=embed&theme=dark",
  );
});

test("line target lookup returns the server name or null on any failure", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const reply = (status: number, body: unknown) => async (input: string) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  try {
    globalThis.fetch = reply(200, { target: "DMIT Eyeball" }) as typeof fetch;
    assert.equal(await getLineMonitorTarget("grant:2:1"), "DMIT Eyeball");
    assert.equal(calls[0], "/api/me/monitor-target?line=grant%3A2%3A1");
    for (const [status, body] of [[404, { error: { code: "line_not_found" } }], [409, { error: { code: "line_unbound" } }], [401, {}], [200, { target: 5 }], [200, { target: "x", extra: 1 }]] as const) {
      globalThis.fetch = reply(status, body) as typeof fetch;
      assert.equal(await getLineMonitorTarget("grant:2:1"), null, `${status} ${JSON.stringify(body)}`);
    }
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    assert.equal(await getLineMonitorTarget("grant:2:1"), null);
  } finally {
    globalThis.fetch = original;
  }
});
