import assert from "node:assert/strict";
import test from "node:test";

import {
  MONITOR_TARGET_KEY_MAX_LENGTH,
  MONITOR_TARGET_LABEL_MAX_LENGTH,
  normalizeMonitorTargetKey,
  normalizeMonitorTargetLabel,
  normalizeMonitorTargetState,
} from "../../src/monitor/target-catalog.js";

test("monitor target catalog accepts only bounded exact projection fields", () => {
  assert.equal(normalizeMonitorTargetKey("DMIT Premium"), "DMIT Premium");
  assert.equal(normalizeMonitorTargetKey("香港线路"), "香港线路");
  assert.equal(normalizeMonitorTargetLabel("日本东京 VPS 中转 A"), "日本东京 VPS 中转 A");
  assert.equal(normalizeMonitorTargetState("active"), "active");
  assert.equal(normalizeMonitorTargetState("disabled"), "disabled");
  assert.equal(normalizeMonitorTargetState("retired"), "retired");
});

test("monitor target catalog fails closed on normalization or enum drift", () => {
  for (const value of [
    null,
    "",
    " DMIT Premium",
    "DMIT Premium ",
    "bad\nkey",
    "x".repeat(MONITOR_TARGET_KEY_MAX_LENGTH + 1),
  ]) {
    assert.equal(normalizeMonitorTargetKey(value), null);
  }
  for (const value of [
    null,
    "",
    " label",
    "label ",
    "bad\u0000label",
    "x".repeat(MONITOR_TARGET_LABEL_MAX_LENGTH + 1),
  ]) {
    assert.equal(normalizeMonitorTargetLabel(value), null);
  }
  for (const value of [null, "ACTIVE", "paused", " active"] as const) {
    assert.equal(normalizeMonitorTargetState(value), null);
  }
});
