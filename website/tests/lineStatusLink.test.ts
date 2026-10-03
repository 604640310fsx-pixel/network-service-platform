import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
import { buyerLineStatusHref, lineSelector, readStatusLineParam } from "../app/lib/buyerStatusLink.ts";
// @ts-ignore TS5097
import { getMonitorStatus, MonitorStatusApiError } from "../app/lib/monitor-status-api.ts";
// @ts-ignore TS5097
import { en } from "../app/i18n/en.ts";
// @ts-ignore TS5097
import { zh } from "../app/i18n/zh.ts";

const CJK = /[㐀-鿿]/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

test("line links name the buyer's line only, never a monitor target", () => {
  assert.equal(lineSelector({ kind: "service", ref: "DL0000000001", position: 2 }), "service:DL0000000001:2");
  assert.equal(buyerLineStatusHref({ kind: "service", ref: "DL0000000001", position: 2 }), "/status?line=service%3ADL0000000001%3A2");
  assert.equal(buyerLineStatusHref({ kind: "grant", ref: 7, position: 1 }), "/status?line=grant%3A7%3A1");
});

test("status page reads only a well-formed line selector", () => {
  assert.equal(readStatusLineParam(""), null);
  assert.equal(readStatusLineParam("?line=service%3ADL0000000001%3A2"), "service:DL0000000001:2");
  assert.equal(readStatusLineParam("?line=grant:7:1"), "grant:7:1");
  for (const search of ["?line=grant:07:1", "?line=service:DL1:1", "?line=vps:1:1", "?line=", "?line=grant:7:1:2"]) {
    assert.equal(readStatusLineParam(search), "invalid", search);
  }
});

test("monitor status forwards the line and maps line errors", async () => {
  const calls: string[] = [];
  const projection = await getMonitorStatus(undefined, async (input) => {
    calls.push(String(input));
    return json({ label: "Server B", status: "online", updatedAt: "2030-01-01T00:00:00Z", stale: false });
  }, "grant:7:1");
  assert.equal(calls[0], "/api/me/monitor-status?line=grant%3A7%3A1");
  assert.equal(projection.label, "Server B");
  await getMonitorStatus(undefined, async (input) => {
    calls.push(String(input));
    return json({ label: "Server A", status: "online", updatedAt: "2030-01-01T00:00:00Z", stale: false });
  });
  assert.equal(calls[1], "/api/me/monitor-status");
  for (const [status, code] of [[404, "line_not_found"], [409, "line_unbound"]] as const) {
    await assert.rejects(
      () => getMonitorStatus(undefined, async () => json({ error: { code } }, status), "grant:7:1"),
      (error) => error instanceof MonitorStatusApiError && error.code === code && error.status === status,
    );
  }
});

test("line status copy is bilingual", () => {
  assert.deepEqual(Object.keys(en.serverStatus).sort(), Object.keys(zh.serverStatus).sort());
  for (const [key, value] of Object.entries(en.serverStatus)) {
    assert.doesNotMatch(typeof value === "function" ? value("Line") : value, CJK, key);
  }
  assert.doesNotMatch(en.network.lineUnmonitored, CJK);
  assert.doesNotMatch(en.network.giftLineAria(1, "Line"), CJK);
  assert.equal(zh.serverStatus.allServers, "查看我的全部服务器");
});
