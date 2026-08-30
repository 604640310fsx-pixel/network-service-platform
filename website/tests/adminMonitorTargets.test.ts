import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminMonitorTargets } from "../app/lib/payment-api.ts";


test("admin monitor targets preserve lifecycle and default legacy items to active", () => {
  assert.deepEqual(
    parseAdminMonitorTargets({
      items: [
        { key: "Active A", label: "美国线路 A", state: "active" },
        { key: "Paused B", label: "维护线路 B", state: "disabled" },
        { key: "Retired C", label: "旧线路 C", state: "retired" },
        { key: "Legacy D", label: "兼容线路 D" },
      ],
    }),
    [
      { key: "Active A", label: "美国线路 A", state: "active" },
      { key: "Paused B", label: "维护线路 B", state: "disabled" },
      { key: "Retired C", label: "旧线路 C", state: "retired" },
      { key: "Legacy D", label: "兼容线路 D", state: "active" },
    ],
  );
});

test("admin monitor targets reject unknown lifecycle and duplicate keys", () => {
  assert.throws(
    () => parseAdminMonitorTargets({
      items: [{ key: "Bad", label: "Bad", state: "deleted" }],
    }),
    /invalid_response/,
  );
  assert.throws(
    () => parseAdminMonitorTargets({
      items: [
        { key: "Same", label: "A", state: "active" },
        { key: "Same", label: "B", state: "active" },
      ],
    }),
    /invalid_response/,
  );
});
