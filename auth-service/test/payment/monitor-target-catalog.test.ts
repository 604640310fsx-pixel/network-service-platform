import assert from "node:assert/strict";
import test from "node:test";

import {
  createMonitorTargetCatalog,
  normalizeMonitorApiOrigin,
  normalizeMonitorTargetKey,
  normalizeMonitorTargetState,
} from "../../src/monitor/target-catalog.js";

test("monitor catalog returns only sanitized target keys and labels", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const catalog = createMonitorTargetCatalog(
    "http://192.0.2.10:3002",
    async (input, init) => {
      requestUrl = input.toString();
      requestInit = init;
      return new Response(JSON.stringify({
        targets: [
          {
            target_name: "DMIT Premium",
            display_name: "DMIT Premium",
            target_host: "sensitive.internal.example",
            tcp_port: 443,
            has_data: true,
            collector_enabled: true,
            customer_state: "active",
          },
          {
            target_name: "Tokyo Transit A",
            display_name: "日本东京 VPS 中转 A",
            target_host: "192.0.2.99",
            tcp_port: 8443,
            collector_enabled: false,
          },
          {
            target_name: "Retired Transit",
            display_name: "已退役线路",
            target_host: "198.51.100.99",
            customer_state: "retired",
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  );

  assert.deepEqual(await catalog.list(), [
    { key: "DMIT Premium", label: "DMIT Premium", state: "active" },
    { key: "Tokyo Transit A", label: "日本东京 VPS 中转 A", state: "disabled" },
    { key: "Retired Transit", label: "已退役线路", state: "retired" },
  ]);
  assert.equal(requestUrl, "http://192.0.2.10:3002/api/vps-targets");
  assert.equal(requestInit?.method, "GET");
  assert.equal(requestInit?.redirect, "error");
  assert.deepEqual(requestInit?.headers, { Accept: "application/json" });
});

test("monitor catalog and configuration fail closed on malformed values", async () => {
  assert.equal(normalizeMonitorApiOrigin("https://monitor.example.test"), "https://monitor.example.test");
  assert.equal(normalizeMonitorApiOrigin("http://192.0.2.10:3002"), "http://192.0.2.10:3002");
  for (const invalid of [
    "",
    " https://monitor.example.test",
    "ftp://monitor.example.test",
    "https://user:pass@monitor.example.test",
    "https://monitor.example.test/path",
    "https://monitor.example.test/?key=value",
  ]) {
    assert.equal(normalizeMonitorApiOrigin(invalid), null);
  }
  for (const invalidKey of ["", " key", "key ", "bad\nkey", "x".repeat(129)]) {
    assert.equal(normalizeMonitorTargetKey(invalidKey), null);
  }
  assert.equal(normalizeMonitorTargetState(undefined, true), "active");
  assert.equal(normalizeMonitorTargetState(undefined, false), "disabled");
  assert.equal(normalizeMonitorTargetState("retired", true), "retired");
  assert.equal(normalizeMonitorTargetState("deleted", true), null);

  const duplicateCatalog = createMonitorTargetCatalog(
    "https://monitor.example.test",
    async () => new Response(JSON.stringify({
      targets: [
        { target_name: "same", display_name: "A" },
        { target_name: "same", display_name: "B" },
      ],
    })),
  );
  await assert.rejects(() => duplicateCatalog.list(), /invalid/);

  const invalidStateCatalog = createMonitorTargetCatalog(
    "https://monitor.example.test",
    async () => new Response(JSON.stringify({
      targets: [
        { target_name: "target", display_name: "Target", customer_state: "deleted" },
      ],
    })),
  );
  await assert.rejects(() => invalidStateCatalog.list(), /invalid/);
});
