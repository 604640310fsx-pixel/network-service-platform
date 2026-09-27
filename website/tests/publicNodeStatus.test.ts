import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatPercent,
  formatRate,
  formatUptime,
  NODE_STATUS_MAX_TARGETS,
  NodeStatusResponseError,
  nodeStatusApiOrigin,
  nodeStatusUrl,
  nodeTargetsUrl,
  parseNodeStatus,
  parseNodeTargets,
} from "../app/lib/public-node-status.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("api origin keeps only protocol and host of VITE_MONITOR_URL", () => {
  const site = "https://www.example.net";
  assert.equal(nodeStatusApiOrigin("https://monitor.example.net/?view=embed", site), "https://monitor.example.net");
  assert.equal(nodeStatusApiOrigin(undefined, site), null);
  assert.equal(nodeStatusApiOrigin("   ", site), null);
  assert.equal(nodeStatusApiOrigin("javascript:alert(1)", site), null);
  assert.equal(nodeStatusApiOrigin("https://user:pass@monitor.example.net", site), null);
  assert.equal(nodeTargetsUrl("https://m.example.net"), "https://m.example.net/api/vps-targets");
  assert.equal(
    nodeStatusUrl("https://m.example.net", "DMIT Premium&x=1"),
    "https://m.example.net/api/vps-status?target=DMIT%20Premium%26x%3D1",
  );
});

test("targets parser rejects bad shapes, skips bad rows, dedupes and caps", () => {
  assert.throws(() => parseNodeTargets(null), NodeStatusResponseError);
  assert.throws(() => parseNodeTargets({ targets: "x" }), NodeStatusResponseError);
  const parsed = parseNodeTargets({
    targets: [
      { target_name: "A", display_name: "香港 A" },
      { target_name: "A", display_name: "dup" },
      { target_name: "B" },
      { target_name: "" },
      { target_name: "bad\u0000name" },
      "junk",
    ],
  });
  assert.deepEqual(parsed, [
    { name: "A", displayName: "香港 A" },
    { name: "B", displayName: "B" },
  ]);
  const many = { targets: Array.from({ length: 100 }, (_, i) => ({ target_name: `n${i}` })) };
  assert.equal(parseNodeTargets(many).length, NODE_STATUS_MAX_TARGETS);
});

test("status parser maps online, offline, stale and unavailable without inventing values", () => {
  const item = {
    online: true,
    cpu_percent: 3.65,
    memory_percent: 26.12,
    storage_percent: 13.42,
    upload_bytes_per_second: 605263,
    download_bytes_per_second: 424331,
    uptime_seconds: 6304309,
  };
  const ok = parseNodeStatus({ source_status: "ok", fresh: true, updated_at: "2026-09-27T10:55:53Z", item });
  assert.equal(ok.kind, "online");
  assert.equal(ok.cpuPercent, 3.65);
  assert.equal(ok.updatedAt, "2026-09-27T10:55:53Z");
  assert.equal(parseNodeStatus({ source_status: "ok", fresh: true, item: { ...item, online: false } }).kind, "offline");
  assert.equal(parseNodeStatus({ source_status: "ok", fresh: false, item }).kind, "stale");
  assert.equal(parseNodeStatus({ source_status: "unavailable", item }).kind, "unavailable");
  assert.equal(parseNodeStatus({ source_status: "ok", fresh: true }).kind, "unavailable");
  assert.equal(parseNodeStatus(null).kind, "unavailable");
  const bad = parseNodeStatus({ source_status: "ok", fresh: true, item: { online: true, cpu_percent: 150, memory_percent: "9" } });
  assert.equal(bad.cpuPercent, null);
  assert.equal(bad.memoryPercent, null);
  assert.equal(bad.uptimeSeconds, null);
});

test("formatters render real values or an em dash", () => {
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(26.12), "26.1%");
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(512), "512 B/s");
  assert.equal(formatRate(605263), "591 KB/s");
  assert.equal(formatRate(5 * 1024 * 1024), "5.0 MB/s");
  assert.equal(formatUptime(null), "—");
  assert.equal(formatUptime(6304309), "72 天 23 小时");
  assert.equal(formatUptime(3 * 3600 + 5 * 60), "3 小时 5 分");
  assert.equal(formatUptime(59), "0 分钟");
});

test("/status is public and renders the node status page for everyone", () => {
  const app = source("../src/App.tsx");
  assert.match(app, /section === "monitor" \|\| section === "status"\) return <DashboardShell \/>/);
  const shell = source("../app/components/DashboardShell.tsx");
  assert.match(shell, /section === "status"\) \{\s*return <PublicNodeStatusPage \/>/);
  const page = source("../app/components/status/PublicNodeStatusPage.tsx");
  assert.match(page, /credentials: "omit"/);
  assert.match(page, /document\.hidden/);
  assert.doesNotMatch(page, /fixture|isMonitorFixturePreview/i);
});
