import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import {
  decryptServiceDeliveryItem,
  DELIVERY_MAX_ITEMS,
  DELIVERY_MAX_URL_UTF8_BYTES,
  encryptServiceDeliveryItem,
  normalizeServiceDeliveryInput,
} from "../../src/payment/delivery-crypto.js";
import {
  createPaymentOrder,
  openService,
} from "../../src/payment/orders.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import { computeSessionTokenHash } from "../../src/session/session-token.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  DELIVERY_KEYRING,
  TOKEN_KEYRING,
  allRows,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

const DELIVERY_URL = "https://subscription.example.test/customer?a=1&b=2";

function flipFirstByte(value: Buffer): Buffer {
  const changed = Buffer.from(value);
  changed[0] = (changed[0] ?? 0) ^ 0xff;
  return changed;
}

function createPaidOrder(
  database: Parameters<typeof paymentDependencies>[0],
  userId: number | null,
  accessToken = ACCESS_TOKEN_A,
) {
  const dependencies = paymentDependencies(database);
  const order = createPaymentOrder(dependencies, {
    idempotencyKey: `delivery-${accessToken.slice(0, 8)}`,
    rawAccessToken: accessToken,
    selection: localIspSelection(),
    contact: "delivery-contact",
    scenarios: [],
    notes: null,
    acknowledgedAmountFen: 7_900,
    userId,
  });
  finalizePaid(dependencies, {
    outTradeNo: order.orderRef,
    tradeNo: `trade-${accessToken.slice(0, 8)}`,
    tradeStatus: "TRADE_SUCCESS",
    totalAmount: "79.00",
    totalAmountFen: 7_900,
    appId: "app-123",
    sellerId: "seller-456",
    notification: {
      notifyId: `notify-${accessToken.slice(0, 8)}`,
      payloadHash: "delivery-hash",
    },
  });
  return { dependencies, order };
}

test("delivery encryption round-trips with unique nonces and rejects tampering or wrong AAD", () => {
  const first = encryptServiceDeliveryItem(
    {
      serviceId: 17,
      position: 1,
      item: {
        label: "订阅线路 1",
        subscriptionUrl: DELIVERY_URL,
        monitorTargetKey: "DMIT Premium",
      },
    },
    DELIVERY_KEYRING,
  );
  const second = encryptServiceDeliveryItem(
    {
      serviceId: 17,
      position: 1,
      item: {
        label: "订阅线路 1",
        subscriptionUrl: DELIVERY_URL,
        monitorTargetKey: "DMIT Premium",
      },
    },
    DELIVERY_KEYRING,
  );
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.equal(first.keyVersion, DELIVERY_KEYRING.version);
  assert.equal(first.ciphertext.includes(Buffer.from(DELIVERY_URL, "utf8")), false);
  assert.equal(
    decryptServiceDeliveryItem({ serviceId: 17, ...first }, DELIVERY_KEYRING),
    DELIVERY_URL,
  );

  for (const changed of [
    { ...first, ciphertext: flipFirstByte(first.ciphertext) },
    { ...first, tag: flipFirstByte(first.tag) },
    { ...first, nonce: flipFirstByte(first.nonce) },
  ]) {
    assert.throws(() =>
      decryptServiceDeliveryItem({ serviceId: 17, ...changed }, DELIVERY_KEYRING),
    );
  }
  assert.throws(() =>
    decryptServiceDeliveryItem({ serviceId: 18, ...first }, DELIVERY_KEYRING),
  );
  assert.throws(() =>
    decryptServiceDeliveryItem(
      { serviceId: 17, ...first, position: 2 },
      DELIVERY_KEYRING,
    ),
  );
  assert.throws(() =>
    decryptServiceDeliveryItem(
      { serviceId: 17, ...first, keyVersion: 99 },
      DELIVERY_KEYRING,
    ),
  );
});

test("delivery input enforces exact HTTPS, label, item-count, and UTF-8 byte boundaries", () => {
  const prefix = "https://example.test/";
  const exact = `${prefix}${"a".repeat(
    DELIVERY_MAX_URL_UTF8_BYTES - Buffer.byteLength(prefix),
  )}`;
  const over = `${exact}a`;
  assert.equal(Buffer.byteLength(exact), DELIVERY_MAX_URL_UTF8_BYTES);
  assert.notEqual(normalizeServiceDeliveryInput({
    label: " 线路 1 ",
    subscriptionUrl: exact,
    monitorTargetKey: "DMIT Premium",
  }), null);
  assert.equal(normalizeServiceDeliveryInput({
    label: "线路 1",
    subscriptionUrl: over,
    monitorTargetKey: "DMIT Premium",
  }), null);
  for (const subscriptionUrl of [
    "",
    " http://example.test/sub",
    "http://example.test/sub",
    "javascript:alert(1)",
    "data:text/plain,test",
    "file:///tmp/sub",
    "clash://install-config?url=x",
  ]) {
    assert.equal(
      normalizeServiceDeliveryInput({
        label: "线路 1",
        subscriptionUrl,
        monitorTargetKey: "DMIT Premium",
      }),
      null,
    );
  }
  assert.equal(normalizeServiceDeliveryInput({
    label: " ",
    subscriptionUrl: DELIVERY_URL,
    monitorTargetKey: "DMIT Premium",
  }), null);
  assert.equal(
    normalizeServiceDeliveryInput({
      label: "x".repeat(201),
      subscriptionUrl: DELIVERY_URL,
      monitorTargetKey: "DMIT Premium",
    }),
    null,
  );
  for (const monitorTargetKey of ["", " DMIT Premium", "DMIT Premium ", "x".repeat(129), "bad\nkey"]) {
    assert.equal(
      normalizeServiceDeliveryInput({
        label: "线路 1",
        subscriptionUrl: DELIVERY_URL,
        monitorTargetKey,
      }),
      null,
    );
  }
  assert.equal(DELIVERY_MAX_ITEMS, 20);
});

test("admin save-and-open is atomic and customer delivery is authorized before decryption", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "delivery-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const otherId = insertAuthenticationUser(database, {
      email: "delivery-other@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "delivery-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const ownerSession = insertWebSession(database, userId);
    const otherSession = insertWebSession(database, otherId);
    const adminSession = insertWebSession(database, adminId);
    const { dependencies, order } = createPaidOrder(database, userId);
    const serviceId = firstValue(database, "SELECT id FROM services");
    if (typeof serviceId !== "number") throw new Error("service id is invalid");
    const csrf = issueCsrfToken(
      dependencies.csrfSigningKey,
      computeSessionTokenHash(adminSession.rawToken, TOKEN_KEYRING).tokenHash,
    );
    const app = buildApp({ payment: dependencies });
    try {
      const pending = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { cookie: ownerSession.cookie },
      });
      assert.equal(pending.statusCode, 200);
      assert.deepEqual(pending.json().service, { status: "pending_open" });
      assert.equal("items" in pending.json().service, false);

      const empty = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: { items: [] },
      });
      assert.equal(empty.statusCode, 400);
      assert.deepEqual(empty.json(), { error: { code: "items_required" } });

      const tooMany = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: Array.from({ length: 21 }, (_, index) => ({
            label: `线路 ${index + 1}`,
            subscriptionUrl: `${DELIVERY_URL}&line=${index + 1}`,
            monitorTargetKey: "DMIT Premium",
          })),
        },
      });
      assert.equal(tooMany.statusCode, 400);
      assert.deepEqual(tooMany.json(), { error: { code: "invalid_item" } });

      const invalidUrl = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [{
            label: "线路",
            subscriptionUrl: "http://example.test",
            monitorTargetKey: "DMIT Premium",
          }],
        },
      });
      assert.equal(invalidUrl.statusCode, 400);

      const unknownTarget = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [{
            label: "线路",
            subscriptionUrl: DELIVERY_URL,
            monitorTargetKey: "Unknown VPS",
          }],
        },
      });
      assert.equal(unknownTarget.statusCode, 400);
      assert.deepEqual(unknownTarget.json(), {
        error: { code: "invalid_monitor_target" },
      });
      assert.equal(firstValue(database, "SELECT status FROM services"), "pending_open");

      const opened = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [
            {
              label: " 订阅线路 1 ",
              subscriptionUrl: DELIVERY_URL,
              monitorTargetKey: "DMIT Premium",
            },
            {
              label: "订阅线路 2",
              subscriptionUrl: "https://subscription.example.test/backup",
              monitorTargetKey: "Tokyo Transit A",
            },
          ],
        },
      });
      assert.equal(opened.statusCode, 200);
      assert.deepEqual(opened.json().items, [
        { position: 1, label: "订阅线路 1", monitorTargetKey: "DMIT Premium" },
        { position: 2, label: "订阅线路 2", monitorTargetKey: "Tokyo Transit A" },
      ]);
      assert.equal(opened.body.includes(DELIVERY_URL), false);
      assert.equal(firstValue(database, "SELECT status FROM services"), "open");
      const stored = allRows(
        database,
        "SELECT position, label, monitor_target_key, key_version, nonce, ciphertext, tag FROM service_delivery_items ORDER BY position",
      );
      assert.equal(stored.length, 2);
      assert.equal(JSON.stringify(stored).includes(DELIVERY_URL), false);
      assert.equal(stored[0]?.key_version, DELIVERY_KEYRING.version);
      assert.equal(stored[0]?.monitor_target_key, "DMIT Premium");
      assert.equal(stored[1]?.monitor_target_key, "Tokyo Transit A");
      for (const invalidTarget of ["", " DMIT Premium", "x".repeat(129)]) {
        assert.throws(
          () => database
            .prepare("UPDATE service_delivery_items SET monitor_target_key = ? WHERE service_id = ?")
            .run(invalidTarget, serviceId),
          /CHECK constraint failed/,
        );
      }

      const ownerRead = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { cookie: ownerSession.cookie },
      });
      assert.equal(ownerRead.statusCode, 200);
      assert.deepEqual(ownerRead.json().service, {
        status: "open",
        items: [
          {
            position: 1,
            label: "订阅线路 1",
            subscriptionUrl: DELIVERY_URL,
          },
          {
            position: 2,
            label: "订阅线路 2",
            subscriptionUrl: "https://subscription.example.test/backup",
          },
        ],
      });
      assert.equal(ownerRead.body.includes("monitorTargetKey"), false);

      const tokenRead = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { "x-order-access-token": ACCESS_TOKEN_A },
      });
      assert.equal(tokenRead.statusCode, 200);
      assert.equal(tokenRead.json().service.items.length, 2);
      assert.equal(tokenRead.body.includes("monitorTargetKey"), false);

      for (const headers of [
        {},
        { cookie: otherSession.cookie },
        { "x-order-access-token": ACCESS_TOKEN_B },
      ]) {
        const unauthorized = await app.inject({
          method: "GET",
          url: `/api/pay/orders/${order.orderRef}`,
          headers,
        });
        assert.equal(unauthorized.statusCode, 404);
        assert.deepEqual(unauthorized.json(), { error: { code: "not_found" } });
      }

      const repeated = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [{
            label: "线路",
            subscriptionUrl: DELIVERY_URL,
            monitorTargetKey: "DMIT Premium",
          }],
        },
      });
      assert.equal(repeated.statusCode, 409);
    } finally {
      await app.close();
    }
  });
});

test("open transaction rolls back service and delivery rows when a later insert fails", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "rollback-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createPaidOrder(database, null);
    const serviceId = firstValue(database, "SELECT id FROM services");
    if (typeof serviceId !== "number") throw new Error("service id is invalid");
    database.exec(
      `CREATE TRIGGER fail_second_delivery_insert
       BEFORE INSERT ON service_delivery_items
       WHEN NEW.position = 2
       BEGIN
         SELECT RAISE(ABORT, 'forced delivery failure');
       END;`,
    );
    const items = [1, 2].map((position) =>
      encryptServiceDeliveryItem(
        {
          serviceId,
          position,
          item: {
            label: `线路 ${position}`,
            subscriptionUrl: `${DELIVERY_URL}&position=${position}`,
            monitorTargetKey: "DMIT Premium",
          },
        },
        DELIVERY_KEYRING,
      ),
    );
    assert.throws(() =>
      openService(database, {
        serviceId,
        adminUserId: adminId,
        adminEmail: "rollback-admin@example.com",
        items,
      }),
    );
    assert.equal(firstValue(database, "SELECT status FROM services"), "pending_open");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM service_delivery_items"), 0);
    assert.equal(
      firstValue(database, "SELECT COUNT(*) FROM audit_log WHERE action = 'service.open'"),
      0,
    );
  });
});

test("historical open service omits items while decrypt failure returns 503 and audits only orderRef", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "history-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "history-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const ownerSession = insertWebSession(database, userId);
    const { dependencies, order } = createPaidOrder(database, userId);
    database
      .prepare(
        `UPDATE services SET status = 'open', opened_by_admin_id = ?,
         opened_at = ?, updated_at = ? WHERE status = 'pending_open'`,
      )
      .run(adminId, "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z");
    const app = buildApp({ payment: dependencies });
    try {
      const historical = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { cookie: ownerSession.cookie },
      });
      assert.equal(historical.statusCode, 200);
      assert.deepEqual(historical.json().service, { status: "open" });
      assert.equal("items" in historical.json().service, false);

      const serviceId = firstValue(database, "SELECT id FROM services");
      if (typeof serviceId !== "number") throw new Error("service id is invalid");
      const encrypted = encryptServiceDeliveryItem(
        {
          serviceId,
          position: 1,
          item: {
            label: "线路",
            subscriptionUrl: DELIVERY_URL,
            monitorTargetKey: "DMIT Premium",
          },
        },
        DELIVERY_KEYRING,
      );
      database
        .prepare(
          `INSERT INTO service_delivery_items (
             service_id, position, label, key_version, nonce, ciphertext, tag,
             created_at, updated_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          serviceId,
          encrypted.label,
          encrypted.keyVersion,
          encrypted.nonce,
          flipFirstByte(encrypted.ciphertext),
          encrypted.tag,
          "2026-08-21T00:00:00.000Z",
          "2026-08-21T00:00:00.000Z",
        );
      const failed = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { cookie: ownerSession.cookie },
      });
      assert.equal(failed.statusCode, 503);
      assert.deepEqual(failed.json(), { error: { code: "payment_unavailable" } });
      assert.deepEqual(
        allRows(
          database,
          `SELECT actor, action, target_ref FROM audit_log
           WHERE action = 'service.delivery_decrypt_failed'`,
        ),
        [
          {
            actor: "system",
            action: "service.delivery_decrypt_failed",
            target_ref: order.orderRef,
          },
        ],
      );
    } finally {
      await app.close();
    }
  });
});
