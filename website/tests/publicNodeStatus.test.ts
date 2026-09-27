import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getPublicServerStatus,
  getPublicSummary,
  parsePublicServerStatus,
  parsePublicSummary,
  PUBLIC_SERVER_STATUS_URL,
  PUBLIC_SUMMARY_URL,
  PublicStatusError,
} from "../app/lib/public-node-status-api.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const wan = (wanId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  wanId,
  displayName,
  status: "healthy",
  latestLatencyMs: 12.3,
  packetLossSummary: 0,
  updatedAt: "2030-01-01T00:00:00Z",
  stale: false,
  trend: [12, 12.3],
  ...extra,
});
const summary = () => ({ wans: [wan("telecom", "电信"), wan("mobile", "移动"), wan("unicom", "联通")] });
const server = { label: "节点 A", status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: false };

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

test("summary parser accepts the exact three-network allowlist in fixed order", () => {
  const parsed = parsePublicSummary({ wans: [...summary().wans].reverse() });
  assert.deepEqual(parsed.map((item) => item.wanId), ["telecom", "mobile", "unicom"]);
  const stale = summary();
  stale.wans[1] = wan("mobile", "移动", { status: "stale", stale: true, packetLossSummary: null, trend: [] });
  delete (stale.wans[1] as Record<string, unknown>).latestLatencyMs;
  assert.equal(parsePublicSummary(stale)[1].latestLatencyMs, null);
});

test("summary parser rejects extra fields, wrong names, missing WANs and non-current metrics", () => {
  const cases: unknown[] = [
    { ...summary(), extra: 1 },
    { wans: summary().wans.slice(0, 2) },
    { wans: [wan("telecom", "电信", { target_host: "x" }), wan("mobile", "移动"), wan("unicom", "联通")] },
    { wans: [wan("telecom", "Telecom"), wan("mobile", "移动"), wan("unicom", "联通")] },
    { wans: [wan("telecom", "电信", { status: "stale", stale: true }), wan("mobile", "移动"), wan("unicom", "联通")] },
    { wans: [wan("telecom", "电信", { status: "no_data" }), wan("mobile", "移动"), wan("unicom", "联通")] },
  ];
  for (const value of cases) assert.throws(() => parsePublicSummary(value), PublicStatusError);
});

test("server parser accepts only label/status/updatedAt/stale", () => {
  assert.deepEqual(parsePublicServerStatus(server), server);
  for (const value of [
    { ...server, target: "Target A" },
    { ...server, label: "" },
    { ...server, label: "a\nb" },
    { ...server, status: "stale" },
    { ...server, updatedAt: "2030-01-01T00:01:00.000Z" },
    [],
  ]) {
    assert.throws(() => parsePublicServerStatus(value), PublicStatusError);
  }
});

test("fetches are same-origin, credential-free, no-store and never follow redirects", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return String(input) === PUBLIC_SUMMARY_URL ? json(summary()) : json(server);
  };
  await getPublicSummary(undefined, fetchImpl);
  await getPublicServerStatus(undefined, fetchImpl);
  assert.deepEqual(calls.map((call) => call.url), [PUBLIC_SUMMARY_URL, PUBLIC_SERVER_STATUS_URL]);
  for (const { url, init } of calls) {
    assert.match(url, /^\/api\/public-monitor\/(summary|server-status)$/);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "manual");
  }
});

test("failures map to explicit classes without fallback", async () => {
  const cases: Array<[() => Promise<Response>, string]> = [
    [async () => json({ error: { code: "monitor_unavailable" } }, 503), "unavailable"],
    [async () => json({ error: { code: "monitor_unavailable" } }, 504), "timeout"],
    [async () => json({ error: { code: "rate_limited" } }, 429), "rate_limited"],
    [async () => json({ error: { code: "not_found" } }, 404), "invalid"],
    [async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }), "invalid"],
    [async () => new Response(null, { status: 302, headers: { Location: "/login" } }), "invalid"],
    [async () => { throw new TypeError("network"); }, "unavailable"],
  ];
  for (const [respond, kind] of cases) {
    await assert.rejects(
      getPublicServerStatus(undefined, respond),
      (error: unknown) => error instanceof PublicStatusError && error.kind === kind,
    );
  }
});

test("bodies without Content-Length are read with a hard cap and cancelled on overflow", async () => {
  const chunk = new TextEncoder().encode(" ".repeat(1024));
  let pulls = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 1000) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(endless, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  assert.equal(response.headers.get("Content-Length"), null);
  await assert.rejects(
    getPublicServerStatus(undefined, async () => response),
    (error: unknown) => error instanceof PublicStatusError && error.kind === "invalid",
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 20, `read ${pulls} KiB before cancelling`);

  const oversizedDeclared = json(server, 200, { "Content-Length": "999999" });
  await assert.rejects(
    getPublicServerStatus(undefined, async () => oversizedDeclared),
    (error: unknown) => error instanceof PublicStatusError && error.kind === "invalid",
  );
  const malformedUtf8 = new Response(new Uint8Array([0xff, 0xfe]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(
    getPublicServerStatus(undefined, async () => malformedUtf8),
    (error: unknown) => error instanceof PublicStatusError && error.kind === "invalid",
  );
});

test("public /status stays separate from authenticated customer data", () => {
  const app = source("../src/App.tsx");
  assert.match(app, /section === "status"\) return <DashboardShell \/>/);
  const page = source("../app/components/status/PublicNodeStatusPage.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(page, /\/api\/me\/|monitor-status-api|useAuth|import\.meta\.env|<iframe|localStorage|setInterval/);
  assert.doesNotMatch(page, /from "[^"]*(mock|fixture|demo)[^"]*"/i);
  const shell = source("../app/components/DashboardShell.tsx");
  assert.match(shell, /<PublicNodeStatusPage \/>/);
  const api = source("../app/lib/public-node-status-api.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(api, /\/api\/me\/|credentials: "same-origin"|target=|vps=/);
  const customer = source("../app/lib/monitor-status-api.ts");
  assert.match(customer, /"\/api\/me\/monitor-status"/);
  assert.match(customer, /credentials: "same-origin"/);
});
