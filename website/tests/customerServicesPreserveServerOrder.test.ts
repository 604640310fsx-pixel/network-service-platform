import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL("../app/components/customer/CustomerServicesPage.tsx", import.meta.url),
  "utf8",
);

test("CustomerServicesPage preserves API order within primary purchases, other purchases and gifts", () => {
  const responseItems = [
    { orderRef: "ORDER-OLDER-FIRST", createdAt: "2026-01-01T00:00:00.000Z" },
    { orderRef: "ORDER-NEWER-SECOND", createdAt: "2026-02-01T00:00:00.000Z" },
  ];

  assert.ok(responseItems[0].createdAt < responseItems[1].createdAt);
  assert.deepEqual(
    responseItems.map((item) => item.orderRef),
    ["ORDER-OLDER-FIRST", "ORDER-NEWER-SECOND"],
  );
  // Primary editable purchases are presented first; each group keeps server order.
  assert.match(componentSource, /setState\(\{ kind: "ready", items: services, grants \}\);/);
  assert.match(componentSource, /\{grants\.map\(\(grant\) => \(/);
  assert.match(componentSource, /\{items\.map\(\(item\) => \{/);
  assert.doesNotMatch(componentSource, /\.sort\(/);
  assert.doesNotMatch(componentSource, /\.reverse\(/);
});
