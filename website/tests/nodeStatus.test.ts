import test from "node:test";
import assert from "node:assert/strict";
import { nodeStatusCounts, parseNodeStatus } from "../app/lib/node-status-api.ts";
import { PaymentApiError } from "../app/lib/payment-api.ts";
import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";

const CJK = /[㐀-鿿]/;
const ITEMS = [
  { kind: "service", ref: "DL0000000001", position: 1, label: "HK A", status: "online" },
  { kind: "service", ref: "DL0000000001", position: 2, label: "HK B", status: "stale" },
  { kind: "service", ref: "DL0000000002", position: 1, label: "US C", status: "offline" },
  { kind: "service", ref: "DL0000000002", position: 2, label: "US D", status: "unknown" },
  { kind: "grant", ref: 7, position: 1, label: "Gift line", status: "unbound" },
];

function invalid(body: unknown) {
  assert.throws(() => parseNodeStatus(body), (error) => error instanceof PaymentApiError && error.code === "invalid_response", JSON.stringify(body));
}

test("node status parses every line state for services and gifts", () => {
  const result = parseNodeStatus({ monitor: "available", items: ITEMS });
  assert.equal(result.monitor, "available");
  assert.deepEqual(result.items.map((item) => [item.kind, item.ref, item.status]), [
    ["service", "DL0000000001", "online"],
    ["service", "DL0000000001", "stale"],
    ["service", "DL0000000002", "offline"],
    ["service", "DL0000000002", "unknown"],
    ["grant", 7, "unbound"],
  ]);
  assert.deepEqual(parseNodeStatus({ monitor: "unavailable", items: [] }), { monitor: "unavailable", items: [] });
});

test("node status rejects unexpected shapes, including any extra (e.g. target) field", () => {
  invalid({ items: ITEMS });
  invalid({ monitor: "maybe", items: [] });
  invalid({ monitor: "unavailable", items: ITEMS });
  invalid({ monitor: "available", items: [{ ...ITEMS[0], monitorTargetKey: "hk-node" }] });
  invalid({ monitor: "available", items: [{ ...ITEMS[0], status: "degraded" }] });
  invalid({ monitor: "available", items: [{ ...ITEMS[0], ref: 5 }] });
  invalid({ monitor: "available", items: [{ ...ITEMS[4], ref: "7" }] });
  invalid({ monitor: "available", items: [{ ...ITEMS[0], position: 0 }] });
  invalid({ monitor: "available", items: [{ ...ITEMS[0], label: " " }] });
});

test("card counts: all lines, three live states, and the pending group", () => {
  assert.deepEqual(nodeStatusCounts(parseNodeStatus({ monitor: "available", items: ITEMS }).items), {
    all: 5, online: 1, stale: 1, offline: 1, unbound: 1, unknown: 1,
  });
  assert.deepEqual(nodeStatusCounts([]), { all: 0, online: 0, stale: 0, offline: 0, unbound: 0, unknown: 0 });
});

test("node status copy is bilingual", () => {
  for (const status of ["online", "offline", "stale", "unbound", "unknown"] as const) {
    assert.ok(zh.network.nodeStatus[status]);
    assert.doesNotMatch(en.network.nodeStatus[status], CJK, status);
  }
  assert.equal(zh.network.nodeStatus.stale, "超时");
  assert.equal(en.network.nodeStatus.online, "Online");
  assert.equal(en.network.metricHints.all(1, 2), "Pending: 1 not linked · 2 unknown");
  assert.equal(zh.network.metricHints.all(1, 2), "待接入：未绑定 1 · 未知 2");
  for (const key of ["statusUnavailable", "statusUnavailableHint", "retryStatus", "giftLinesTitle", "nodesFoot", "pageLead"] as const) {
    assert.doesNotMatch(en.network[key], CJK, key);
  }
});
