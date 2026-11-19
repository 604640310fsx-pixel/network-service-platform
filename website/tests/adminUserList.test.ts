import assert from "node:assert/strict";
import test from "node:test";

import { getAdminUsersPage } from "../app/lib/admin-services-api.ts";
import { PaymentApiError } from "../app/lib/payment-api.ts";

const user = {
  id: 42,
  email: "buyer@synthetic.invalid",
  role: "user",
  status: "active",
  createdAt: "2026-11-10T00:00:00.000Z",
  lastSuccessfulWebLoginAt: null,
};

test("admin user pages use bounded cursor requests and parse login history without sensitive extras", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.credentials, "same-origin");
    const items = String(url).includes("cursor=") ? [{ ...user, id: 22 }] :
      Array.from({ length: 20 }, (_, index) => ({ ...user, id: 42 - index, sessionToken: "must-not-surface" }));
    return new Response(JSON.stringify({ items, nextCursor: items.length === 20 ? 23 : null }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await getAdminUsersPage("", null);
    const filtered = await getAdminUsersPage("buyer", 23);
    assert.deepEqual(requests, ["/api/admin/users/list", "/api/admin/users/list?q=buyer&cursor=23"]);
    assert.equal(first.items.length, 20);
    assert.deepEqual(first.items[0], user);
    assert.equal(first.nextCursor, 23);
    assert.deepEqual(filtered.items[0], { ...user, id: 22 });
  } finally {
    globalThis.fetch = original;
  }
});

test("admin user pages fail closed on malformed list or cursor", async () => {
  const original = globalThis.fetch;
  try {
    for (const body of [{ items: [user], nextCursor: 0 }, { items: [user], nextCursor: 42 },
      { items: Array.from({ length: 21 }, () => user), nextCursor: null }, { items: [user] }, { items: [{}], nextCursor: null }]) {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
      await assert.rejects(() => getAdminUsersPage("", null),
        (error) => error instanceof PaymentApiError && error.code === "invalid_response");
    }
  } finally {
    globalThis.fetch = original;
  }
});
