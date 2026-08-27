import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  FakeAlipaySdk,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

// 冻结公开契约的字段全集（顺序无关，用于精确断言"绝不多返回禁止字段"）。
const FROZEN_ORDER_KEYS = [
  "amountFen",
  "createdAt",
  "currency",
  "durationId",
  "ispId",
  "orderRef",
  "regionId",
  "reservedUntil",
  "serviceStatus",
  "specId",
  "status",
  "typeId",
];

interface SeedOrderInput {
  readonly userId: number | null;
  readonly orderRef: string;
  readonly status: "pending" | "paid" | "closed";
  readonly serviceStatus: "pending_open" | "open" | null;
  readonly createdAt: string;
  readonly reservedUntil: string | null;
  readonly specId?: string | null;
  readonly amountFen?: number;
  readonly contact?: string;
  readonly scenarios?: readonly string[];
  readonly notes?: string | null;
  readonly adminId?: number;
}

/* 直接按精确 DB 状态播种订单+支付(+服务)，用于覆盖状态语义 / 排序 / 字段裁剪。
   所有写入满足 migration 010 的 CHECK 约束与外键；不写 order_access_tokens
   （listMyOrders 本就不 JOIN 它）。仅测试夹具，不触碰生产逻辑。 */
function seedOrder(database: DatabaseConnection, input: SeedOrderInput): void {
  const amountFen = input.amountFen ?? 7_900;
  const specId = input.specId ?? null;
  const contact = input.contact ?? "seed-contact";
  const scenarios = JSON.stringify(input.scenarios ?? ["seed-scenario"]);
  const notes = input.notes ?? "seed-notes";
  database
    .prepare(
      `INSERT INTO orders (
         order_ref, idempotency_key, request_fingerprint, user_id,
         type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
         amount_fen, currency, contact, scenarios, notes, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'local-isp', 'us', 'us-verizon', ?, 'month-1', 'v1',
                 ?, 'CNY', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.orderRef,
      `idem-${input.orderRef}`,
      `fp-${input.orderRef}`,
      input.userId,
      specId,
      amountFen,
      contact,
      scenarios,
      notes,
      input.status,
      input.createdAt,
      input.createdAt,
    );
  const orderId = firstValue(
    database,
    "SELECT id FROM orders WHERE order_ref = ?",
    input.orderRef,
  );

  const tradeNo = input.status === "pending" ? null : `trade-${input.orderRef}`;
  const paidAt = input.status === "paid" ? input.createdAt : null;
  const closedAt = input.status === "closed" ? input.createdAt : null;
  const closeReason = input.status === "closed" ? "alipay_trade_closed" : null;
  const alipayTradeStatus =
    input.status === "paid"
      ? "TRADE_SUCCESS"
      : input.status === "closed"
        ? "TRADE_CLOSED"
        : null;
  database
    .prepare(
      `INSERT INTO payments (
         order_id, out_trade_no, channel, app_id, amount_fen, currency,
         status, trade_no, alipay_trade_status, last_queried_at,
         close_reason, paid_at, closed_at, reserved_until, created_at, updated_at
       ) VALUES (?, ?, 'alipay_page', 'app-123', ?, 'CNY', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderId,
      input.orderRef,
      amountFen,
      input.status,
      tradeNo,
      alipayTradeStatus,
      closeReason,
      paidAt,
      closedAt,
      input.reservedUntil,
      input.createdAt,
      input.createdAt,
    );

  if (input.serviceStatus === null) {
    return;
  }
  const paymentId = firstValue(
    database,
    "SELECT id FROM payments WHERE out_trade_no = ?",
    input.orderRef,
  );
  const openedAt = input.serviceStatus === "open" ? input.createdAt : null;
  const openedBy = input.serviceStatus === "open" ? (input.adminId ?? null) : null;
  database
    .prepare(
      `INSERT INTO services (
         payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(paymentId, input.serviceStatus, openedBy, openedAt, input.createdAt, input.createdAt);
}

test("me/orders requires a session and scopes results to the caller in SQL", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userA = insertAuthenticationUser(database, {
      email: "a@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const userB = insertAuthenticationUser(database, {
      email: "b@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const userC = insertAuthenticationUser(database, {
      email: "c@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const sessionA = insertWebSession(database, userA);
    const sessionB = insertWebSession(database, userB);
    const sessionC = insertWebSession(database, userC);

    seedOrder(database, {
      userId: userA,
      orderRef: "DLA1",
      status: "pending",
      serviceStatus: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      reservedUntil: "2026-08-21T00:30:00.000Z",
    });
    seedOrder(database, {
      userId: userA,
      orderRef: "DLA2",
      status: "closed",
      serviceStatus: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      reservedUntil: null,
    });
    seedOrder(database, {
      userId: userB,
      orderRef: "DLB1",
      status: "pending",
      serviceStatus: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      reservedUntil: "2026-08-21T00:30:00.000Z",
    });

    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/me/orders" });
      assert.equal(anonymous.statusCode, 401);
      assert.deepEqual(anonymous.json(), { error: { code: "unauthorized" } });
      assert.equal(anonymous.headers["cache-control"], "no-store");

      const mine = await app.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: sessionA.cookie },
      });
      assert.equal(mine.statusCode, 200);
      assert.equal(mine.headers["cache-control"], "no-store");
      const mineRefs = (mine.json().items as Array<{ orderRef: string }>).map(
        (item) => item.orderRef,
      );
      assert.deepEqual(mineRefs, ["DLA1", "DLA2"]);
      assert.equal(mine.body.includes("DLB1"), false);

      // orderRef 查询参数不得绕过所有权：即便附带 user B 的订单号，仍只返回 A 的。
      const spoofed = await app.inject({
        method: "GET",
        url: "/api/me/orders?orderRef=DLB1",
        headers: { cookie: sessionA.cookie },
      });
      assert.equal(spoofed.statusCode, 200);
      assert.deepEqual(
        (spoofed.json().items as Array<{ orderRef: string }>).map((item) => item.orderRef),
        ["DLA1", "DLA2"],
      );

      const other = await app.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: sessionB.cookie },
      });
      assert.equal(other.statusCode, 200);
      assert.deepEqual(
        (other.json().items as Array<{ orderRef: string }>).map((item) => item.orderRef),
        ["DLB1"],
      );

      const empty = await app.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: sessionC.cookie },
      });
      assert.equal(empty.statusCode, 200);
      assert.deepEqual(empty.json(), { items: [] });
    } finally {
      await app.close();
    }
  });
});

test("me/orders returns the frozen fields with correct status semantics and no forbidden data", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "fields@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const session = insertWebSession(database, userId);

    // paid / closed 的 DB reserved_until 故意保留非空，断言响应仍归 null。
    seedOrder(database, {
      userId,
      orderRef: "DLPENDING",
      status: "pending",
      serviceStatus: null,
      createdAt: "2026-08-21T04:00:00.000Z",
      reservedUntil: "2026-08-21T04:30:00.000Z",
      specId: null,
      amountFen: 7_900,
      contact: "secret-contact-value",
      scenarios: ["secret-scenario-value"],
      notes: "secret-notes-value",
    });
    seedOrder(database, {
      userId,
      orderRef: "DLPAIDPENDING",
      status: "paid",
      serviceStatus: "pending_open",
      createdAt: "2026-08-21T03:00:00.000Z",
      reservedUntil: "2026-08-21T03:30:00.000Z",
      specId: "dedicated",
      amountFen: 12_900,
    });
    seedOrder(database, {
      userId,
      orderRef: "DLPAIDOPEN",
      status: "paid",
      serviceStatus: "open",
      createdAt: "2026-08-21T02:00:00.000Z",
      reservedUntil: "2026-08-21T02:30:00.000Z",
      adminId,
    });
    seedOrder(database, {
      userId,
      orderRef: "DLCLOSED",
      status: "closed",
      serviceStatus: null,
      createdAt: "2026-08-21T01:00:00.000Z",
      reservedUntil: "2026-08-21T01:30:00.000Z",
    });

    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: session.cookie },
      });
      assert.equal(response.statusCode, 200);
      const items = response.json().items as Array<Record<string, unknown>>;

      // created_at DESC 排序，逐项精确匹配冻结契约。
      assert.deepEqual(items, [
        {
          orderRef: "DLPENDING",
          typeId: "local-isp",
          regionId: "us",
          ispId: "us-verizon",
          specId: null,
          durationId: "month-1",
          status: "pending",
          amountFen: 7_900,
          currency: "CNY",
          createdAt: "2026-08-21T04:00:00.000Z",
          reservedUntil: "2026-08-21T04:30:00.000Z",
          serviceStatus: null,
        },
        {
          orderRef: "DLPAIDPENDING",
          typeId: "local-isp",
          regionId: "us",
          ispId: "us-verizon",
          specId: "dedicated",
          durationId: "month-1",
          status: "paid",
          amountFen: 12_900,
          currency: "CNY",
          createdAt: "2026-08-21T03:00:00.000Z",
          reservedUntil: null,
          serviceStatus: "pending_open",
        },
        {
          orderRef: "DLPAIDOPEN",
          typeId: "local-isp",
          regionId: "us",
          ispId: "us-verizon",
          specId: null,
          durationId: "month-1",
          status: "paid",
          amountFen: 7_900,
          currency: "CNY",
          createdAt: "2026-08-21T02:00:00.000Z",
          reservedUntil: null,
          serviceStatus: "open",
        },
        {
          orderRef: "DLCLOSED",
          typeId: "local-isp",
          regionId: "us",
          ispId: "us-verizon",
          specId: null,
          durationId: "month-1",
          status: "closed",
          amountFen: 7_900,
          currency: "CNY",
          createdAt: "2026-08-21T01:00:00.000Z",
          reservedUntil: null,
          serviceStatus: null,
        },
      ]);

      // 每一项的键集合恰好等于冻结契约，杜绝任何禁止字段泄漏。
      for (const item of items) {
        assert.deepEqual(Object.keys(item).sort(), FROZEN_ORDER_KEYS);
      }
      // 敏感明文绝不出现在响应体中。
      for (const forbidden of [
        "secret-contact-value",
        "secret-scenario-value",
        "secret-notes-value",
        "trade-",
        "out_trade_no",
        "paymentId",
        "serviceId",
        "userId",
        "tokenHash",
      ]) {
        assert.equal(response.body.includes(forbidden), false, `leaked: ${forbidden}`);
      }
    } finally {
      await app.close();
    }
  });
});

test("me/orders orders by created_at DESC then id DESC for stable ties", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "order@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const session = insertWebSession(database, userId);

    // o1 最早；o2 与 o3 同一 created_at，o3 后插入(更大 id)。期望 [o3, o2, o1]。
    seedOrder(database, {
      userId,
      orderRef: "DLO1",
      status: "closed",
      serviceStatus: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      reservedUntil: null,
    });
    seedOrder(database, {
      userId,
      orderRef: "DLO2",
      status: "closed",
      serviceStatus: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      reservedUntil: null,
    });
    seedOrder(database, {
      userId,
      orderRef: "DLO3",
      status: "closed",
      serviceStatus: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      reservedUntil: null,
    });

    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: session.cookie },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        (response.json().items as Array<{ orderRef: string }>).map((item) => item.orderRef),
        ["DLO3", "DLO2", "DLO1"],
      );
    } finally {
      await app.close();
    }
  });
});

test("me/orders never queries or refreshes Alipay, even end-to-end", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "noalipay@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const session = insertWebSession(database, userId);
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);

    // 真实下单流程产生一个 pending 订单（单订单 GET 会触发支付宝刷新，列表不得触发）。
    const created = createPaymentOrder(dependencies, {
      idempotencyKey: "noalipay-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "real-contact",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId,
    });
    const pageCallsAfterCreate = sdk.pageCalls.length;

    const app = buildApp({ payment: dependencies });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: session.cookie },
      });
      assert.equal(response.statusCode, 200);
      const items = response.json().items as Array<Record<string, unknown>>;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.orderRef, created.orderRef);
      assert.equal(items[0]?.status, "pending");
      assert.equal(items[0]?.serviceStatus, null);
      assert.equal(typeof items[0]?.reservedUntil, "string");

      // 关键断言：列表接口零支付宝调用（query / close），也不新增 page 调用。
      assert.equal(sdk.queryCalls.length, 0);
      assert.equal(sdk.closeCalls.length, 0);
      assert.equal(sdk.pageCalls.length, pageCallsAfterCreate);
      // 也没有把 last_queried_at 写脏（列表是纯只读）。
      assert.equal(
        firstValue(database, "SELECT last_queried_at FROM payments WHERE out_trade_no = ?", created.orderRef),
        null,
      );
    } finally {
      await app.close();
    }
  });
});

test("me/orders returns 503 when payment is disabled or a row is inconsistent (fail closed)", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "failclosed@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const session = insertWebSession(database, userId);

    const disabledApp = buildApp({ payment: { enabled: false } });
    try {
      const disabled = await disabledApp.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: session.cookie },
      });
      // 停用时由 payment 前置守卫短路 503（与同级 /api/me/services 一致）。
      assert.equal(disabled.statusCode, 503);
      assert.deepEqual(disabled.json(), { error: { code: "payment_unavailable" } });
    } finally {
      await disabledApp.close();
    }

    // 数据异常：paid 订单缺少 service 行，违反 paid→serviceStatus 语义 → fail closed 503。
    seedOrder(database, {
      userId,
      orderRef: "DLANOMALY",
      status: "paid",
      serviceStatus: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      reservedUntil: null,
    });
    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/me/orders",
        headers: { cookie: session.cookie },
      });
      // 到达处理器的响应（含 fail-closed 503）由路由设置 no-store。
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: { code: "payment_unavailable" } });
      assert.equal(response.headers["cache-control"], "no-store");
    } finally {
      await app.close();
    }
  });
});
