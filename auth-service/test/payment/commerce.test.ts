import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoupon,
  findSellablePlan,
  normalizeCouponCode,
  PaymentDomainError,
  releasePlanAndCouponForOrder,
  resolveQuote,
  updateCoupon,
  updateSellablePlan,
} from "../../src/payment/commerce.js";
import { createPaymentOrder, retryPaymentOrder } from "../../src/payment/orders.js";
import { finalizeClosed, finalizePaid } from "../../src/payment/state-machine.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  ACCESS_TOKEN_C,
  TEST_NOW,
  allRows,
  firstValue,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

function residentialSelection() {
  return {
    typeId: "residential",
    regionId: "vn",
    ispId: "vnpt-corp",
    specId: "shared-5",
    durationId: "month-1",
  } as const;
}

function occupiedSlots(database: ReturnType<typeof paymentDependencies>["database"], selection: ReturnType<typeof localIspSelection>): number {
  return firstValue(
    database,
    `SELECT occupied_slots FROM sellable_plans
     WHERE type_id = ? AND region_id = ? AND isp_id = ? AND spec_id IS ? AND duration_id = ?`,
    selection.typeId,
    selection.regionId,
    selection.ispId,
    selection.specId,
    selection.durationId,
  ) as number;
}

test("finding a fixed-price plan (spec_id NULL) is safe against SQLite's NULL-is-distinct UNIQUE semantics", async () => {
  await withAuthenticationDatabase(async (database) => {
    const plan = findSellablePlan(database, localIspSelection());
    assert.notEqual(plan, null);
    assert.equal(plan?.priceFen, 7_900);
    assert.equal(plan?.isActive, true);
    assert.equal(plan?.totalSlots, null);
  });
});

test("a fixed-price order occupies one slot on creation and the slot is released exactly once when the order closes", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    // 把这个组合的库存收紧到 1，便于观察占用/释放的精确计数。
    database
      .prepare(
        `UPDATE sellable_plans SET total_slots = 1
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      )
      .run();

    const order = createPaymentOrder(dependencies, {
      idempotencyKey: "slot-key-1",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: null,
      couponCode: null,
    });
    assert.equal(occupiedSlots(database, localIspSelection()), 1);

    finalizeClosed(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-close-1",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
    });
    assert.equal(occupiedSlots(database, localIspSelection()), 0);

    // 重复关闭事件（幂等重放）不得二次释放（变成负数）。
    finalizeClosed(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-close-1",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
    });
    assert.equal(occupiedSlots(database, localIspSelection()), 0);
  });
});

test("paid orders never release their slot even if a late TRADE_CLOSED arrives", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    database
      .prepare(
        `UPDATE sellable_plans SET total_slots = 1
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      )
      .run();
    const order = createPaymentOrder(dependencies, {
      idempotencyKey: "slot-key-paid",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: null,
      couponCode: null,
    });
    finalizePaid(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-paid-1",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
    });
    assert.equal(occupiedSlots(database, localIspSelection()), 1);

    // 迟到的 TRADE_CLOSED：ignored_paid 分支，绝不释放。
    const result = finalizeClosed(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-paid-1",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
    });
    assert.equal(result, "ignored_paid");
    assert.equal(occupiedSlots(database, localIspSelection()), 1);
  });
});

test("sequential creation against a one-slot plan rejects the second order within the existing synchronous SQLite semantics", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    database
      .prepare(
        `UPDATE sellable_plans SET total_slots = 1
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      )
      .run();

    createPaymentOrder(dependencies, {
      idempotencyKey: "race-key-1",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: null,
      couponCode: null,
    });

    assert.throws(
      () =>
        createPaymentOrder(dependencies, {
          idempotencyKey: "race-key-2",
          rawAccessToken: ACCESS_TOKEN_B,
          selection: localIspSelection(),
          contact: "wechat",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 7_900,
          userId: null,
          couponCode: null,
        }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "sold_out",
    );
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
  });
});

test("resolveQuote never mutates plan or coupon state (a quote does not occupy inventory or a coupon slot)", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createCoupon(database, {
      code: "quote10",
      kind: "percent",
      amountOffFen: null,
      percentOff: 10,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: 1,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const quote = resolveQuote(database, {
        selection: localIspSelection(),
        couponCode: "quote10",
        now: () => new Date(TEST_NOW),
      });
      assert.equal(quote.listPriceFen, 7_900);
      assert.equal(quote.discountFen, 790);
      assert.equal(quote.amountFen, 7_110);
    }
    assert.equal(occupiedSlots(database, localIspSelection()), 0);
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'QUOTE10'"), 0);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM coupon_redemptions"), 0);
  });
});

test("changing a plan price affects only new orders; the old order amount stays frozen and a stale new amount is rejected", async () => {
  await withAuthenticationDatabase(async (database) => {
    let sequence = 0;
    const dependencies = paymentDependencies(database, undefined, () => {
      sequence += 1;
      return `${sequence.toString().padStart(8, "0")}-4444-4444-8444-444444444444`;
    });
    const adminId = insertAuthenticationUser(database, {
      email: "admin2@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const oldOrder = createPaymentOrder(dependencies, {
      idempotencyKey: "old-price-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: null,
      couponCode: null,
    });
    assert.equal(
      firstValue(database, "SELECT amount_fen FROM orders WHERE order_ref = ?", oldOrder.orderRef),
      7_900,
    );
    assert.equal(
      firstValue(database, "SELECT amount_fen FROM payments WHERE out_trade_no = ?", oldOrder.orderRef),
      7_900,
    );

    updateSellablePlan(database, {
      planId: findSellablePlan(database, localIspSelection())!.id,
      priceFen: 8_900,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });

    // 调价不能回写历史订单或历史支付快照。
    assert.equal(
      firstValue(database, "SELECT amount_fen FROM orders WHERE order_ref = ?", oldOrder.orderRef),
      7_900,
    );
    assert.equal(
      firstValue(database, "SELECT amount_fen FROM payments WHERE out_trade_no = ?", oldOrder.orderRef),
      7_900,
    );
    assert.throws(
      () =>
        createPaymentOrder(dependencies, {
          idempotencyKey: "stale-price-key",
          rawAccessToken: ACCESS_TOKEN_A,
          selection: localIspSelection(),
          contact: "wechat",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 7_900,
          userId: null,
          couponCode: null,
        }),
      (error: unknown) =>
        error instanceof PaymentDomainError &&
        error.code === "price_changed" &&
        error.details.currentAmountFen === 8_900,
    );
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);

    const newOrder = createPaymentOrder(dependencies, {
      idempotencyKey: "new-price-key",
      rawAccessToken: ACCESS_TOKEN_B,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 8_900,
      userId: null,
      couponCode: null,
    });
    assert.equal(
      firstValue(database, "SELECT amount_fen FROM orders WHERE order_ref = ?", newOrder.orderRef),
      8_900,
    );
    assert.deepEqual(
      allRows(database, "SELECT amount_fen FROM orders ORDER BY id"),
      [{ amount_fen: 7_900 }, { amount_fen: 8_900 }],
    );
  });
});

test("coupon validity rejects not-started, expired, below-minimum, and out-of-scope quotes", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "coupon-rules-admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const residentialPlanId = findSellablePlan(database, residentialSelection())!.id;
    const common = {
      kind: "percent" as const,
      amountOffFen: null,
      percentOff: 10,
      maxRedemptions: null,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    };

    createCoupon(database, {
      ...common,
      code: "FUTURE10",
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2026-08-22T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
    });
    createCoupon(database, {
      ...common,
      code: "EXPIRED10",
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2026-08-20T23:59:59.999Z",
    });
    createCoupon(database, {
      ...common,
      code: "MINIMUM10",
      minAmountFen: 7_901,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
    });
    createCoupon(database, {
      ...common,
      code: "RESIDENTIAL10",
      minAmountFen: null,
      scope: "plans",
      planIds: [residentialPlanId],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
    });

    for (const couponCode of ["FUTURE10", "EXPIRED10", "MINIMUM10", "RESIDENTIAL10"]) {
      assert.throws(
        () =>
          resolveQuote(database, {
            selection: localIspSelection(),
            couponCode,
            now: () => new Date(TEST_NOW),
          }),
        (error: unknown) => error instanceof PaymentDomainError && error.code === "coupon_invalid",
        couponCode,
      );
    }
  });
});

test("reusing one Idempotency-Key with a different couponCode is rejected without creating or redeeming a second order", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const adminId = insertAuthenticationUser(database, {
      email: "coupon-idempotency-admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    for (const [code, percentOff] of [
      ["SAVE10", 10],
      ["SAVE20", 20],
    ] as const) {
      createCoupon(database, {
        code,
        kind: "percent",
        amountOffFen: null,
        percentOff,
        minAmountFen: null,
        scope: "all",
        planIds: [],
        startsAt: "2020-01-01T00:00:00.000Z",
        endsAt: "2030-01-01T00:00:00.000Z",
        maxRedemptions: null,
        adminUserId: adminId,
        now: () => new Date(TEST_NOW),
      });
    }

    createPaymentOrder(dependencies, {
      idempotencyKey: "coupon-idempotency-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_110,
      userId: null,
      couponCode: "SAVE10",
    });
    assert.throws(
      () =>
        createPaymentOrder(dependencies, {
          idempotencyKey: "coupon-idempotency-key",
          rawAccessToken: ACCESS_TOKEN_A,
          selection: localIspSelection(),
          contact: "wechat",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 6_320,
          userId: null,
          couponCode: "SAVE20",
        }),
      (error: unknown) =>
        error instanceof PaymentDomainError && error.code === "idempotency_key_conflict",
    );
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
    assert.deepEqual(
      allRows(database, "SELECT code, redeemed_count FROM coupons ORDER BY code"),
      [
        { code: "SAVE10", redeemed_count: 1 },
        { code: "SAVE20", redeemed_count: 0 },
      ],
    );
  });
});

test("coupon code matching is case-insensitive on write and read", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const adminId = insertAuthenticationUser(database, {
      email: "admin3@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createCoupon(database, {
      code: "  save10  ",
      kind: "percent",
      amountOffFen: null,
      percentOff: 10,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: null,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    assert.equal(normalizeCouponCode("  save10  "), "SAVE10");
    for (const attemptedCode of ["save10", "SAVE10", "SaVe10", "  save10  "]) {
      const quote = resolveQuote(database, {
        selection: localIspSelection(),
        couponCode: attemptedCode,
        now: () => new Date(TEST_NOW),
      });
      assert.equal(quote.couponCode, "SAVE10");
      assert.equal(quote.amountFen, 7_110);
    }
  });
});

test("a fixed coupon discount that would push the payable amount to zero or below is rejected, not silently clamped", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "admin4@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createCoupon(database, {
      code: "toobig",
      kind: "fixed",
      amountOffFen: 7_900,
      percentOff: null,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: null,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    assert.throws(
      () =>
        resolveQuote(database, {
          selection: localIspSelection(),
          couponCode: "toobig",
          now: () => new Date(TEST_NOW),
        }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "coupon_invalid",
    );
    createCoupon(database, {
      code: "exact",
      kind: "fixed",
      amountOffFen: 7_900,
      percentOff: null,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: null,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    // 恰好等于价格：折后金额=0，同样必须拒绝，不允许 ¥0 订单。
    assert.throws(
      () =>
        resolveQuote(database, {
          selection: localIspSelection(),
          couponCode: "exact",
          now: () => new Date(TEST_NOW),
        }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "coupon_invalid",
    );
  });
});

test("an active plan actively priced above the single-payment cap is rejected amount_limit_exceeded (guard exercised in isolation, independent of the seeded off-sale combos)", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const adminId = insertAuthenticationUser(database, {
      email: "admin5@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const planId = findSellablePlan(database, localIspSelection())!.id;
    updateSellablePlan(database, {
      planId,
      priceFen: 250_000,
      isActive: true,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    assert.throws(
      () =>
        resolveQuote(database, {
          selection: localIspSelection(),
          couponCode: null,
          now: () => new Date(TEST_NOW),
        }),
      (error: unknown) =>
        error instanceof PaymentDomainError &&
        error.code === "amount_limit_exceeded" &&
        error.details.maxSingleFen === 200_000,
    );
    void dependencies;
  });
});

test("an off-sale plan is rejected plan_unavailable even at a modest price", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "admin6@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const planId = findSellablePlan(database, localIspSelection())!.id;
    updateSellablePlan(database, {
      planId,
      isActive: false,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    assert.throws(
      () =>
        resolveQuote(database, {
          selection: localIspSelection(),
          couponCode: null,
          now: () => new Date(TEST_NOW),
        }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "plan_unavailable",
    );
  });
});

test("sequential redemption against a coupon with max_redemptions=1: first order succeeds, second is rejected coupon_invalid", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const adminId = insertAuthenticationUser(database, {
      email: "admin7@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createCoupon(database, {
      code: "onlyone",
      kind: "percent",
      amountOffFen: null,
      percentOff: 10,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: 1,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });

    createPaymentOrder(dependencies, {
      idempotencyKey: "coupon-race-1",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_110,
      userId: null,
      couponCode: "onlyone",
    });
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'ONLYONE'"), 1);

    assert.throws(
      () =>
        createPaymentOrder(dependencies, {
          idempotencyKey: "coupon-race-2",
          rawAccessToken: ACCESS_TOKEN_B,
          selection: residentialSelection(),
          contact: "wechat",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 8_010, // 8900 * 0.9
          userId: null,
          couponCode: "onlyone",
        }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "coupon_invalid",
    );
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'ONLYONE'"), 1);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
  });
});

test("closing an order releases its coupon redemption exactly once and keeps a released history row", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const adminId = insertAuthenticationUser(database, {
      email: "admin8@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createCoupon(database, {
      code: "release1",
      kind: "percent",
      amountOffFen: null,
      percentOff: 10,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: 1,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    const order = createPaymentOrder(dependencies, {
      idempotencyKey: "release-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_110,
      userId: null,
      couponCode: "release1",
    });
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'RELEASE1'"), 1);

    finalizeClosed(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-release-1",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "71.10",
      totalAmountFen: 7_110,
      appId: "app-123",
      sellerId: "seller-456",
    });
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'RELEASE1'"), 0);
    const redemptions = allRows(database, "SELECT released_at FROM coupon_redemptions");
    assert.equal(redemptions.length, 1);
    assert.notEqual(redemptions[0]?.released_at, null);

    // 直接重复调用释放函数本身也必须幂等（防御性测试释放逻辑自身，而不是经由 finalizeClosed 的守卫）。
    const orderIdRow = allRows(database, "SELECT id FROM orders WHERE order_ref = ?", order.orderRef);
    releasePlanAndCouponForOrder(database, orderIdRow[0]?.id as number, () => new Date(TEST_NOW));
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'RELEASE1'"), 0);
  });
});

test("retry reuses the original order's redeemed coupon and revalidates it fresh; an order with no coupon retries with no coupon", async () => {
  await withAuthenticationDatabase(async (database) => {
    // 这个测试里会连续创建多笔真正不同的订单（非幂等重放），需要各自不同的
    // order_ref；paymentDependencies() 默认的 randomUuid 是固定值，会撞
    // UNIQUE(order_ref)，这里换成递增序列。
    let sequence = 0;
    const dependencies = paymentDependencies(database, undefined, () => {
      sequence += 1;
      return `${sequence.toString().padStart(8, "0")}-3333-4333-8333-333333333333`;
    });
    const adminId = insertAuthenticationUser(database, {
      email: "admin9@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createCoupon(database, {
      code: "retrycoupon",
      kind: "percent",
      amountOffFen: null,
      percentOff: 10,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: null,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    const original = createPaymentOrder(dependencies, {
      idempotencyKey: "retry-original",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_110,
      userId: null,
      couponCode: "retrycoupon",
    });
    finalizeClosed(dependencies, {
      outTradeNo: original.orderRef,
      tradeNo: "trade-retry-orig",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "71.10",
      totalAmountFen: 7_110,
      appId: "app-123",
      sellerId: "seller-456",
    });
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'RETRYCOUPON'"), 0);
    const buyerId = insertAuthenticationUser(database, {
      email: "retry-coupon-buyer@example.test",
      passwordHash: "hash",
      status: "active",
    });

    const retried = retryPaymentOrder(dependencies, {
      oldOrderRef: original.orderRef,
      idempotencyKey: "retry-attempt",
      oldRawAccessToken: ACCESS_TOKEN_A,
      newRawAccessToken: ACCESS_TOKEN_B,
      currentUserId: buyerId,
    });
    assert.equal(retried.amountFen, 7_110);
    assert.equal(firstValue(database, "SELECT redeemed_count FROM coupons WHERE code = 'RETRYCOUPON'"), 1);
    const retriedRedemption = allRows(
      database,
      `SELECT coupon_redemptions.id FROM coupon_redemptions
       JOIN orders ON orders.id = coupon_redemptions.order_id
       WHERE orders.order_ref = ? AND coupon_redemptions.released_at IS NULL`,
      retried.orderRef,
    );
    assert.equal(retriedRedemption.length, 1);

    // retry 接口不接受客户端换券：deactivate 优惠券后重试应重新校验并拒绝。
    updateCoupon(database, {
      couponId: firstValue(database, "SELECT id FROM coupons WHERE code = 'RETRYCOUPON'") as number,
      isActive: false,
      now: () => new Date(TEST_NOW),
    });
    finalizeClosed(dependencies, {
      outTradeNo: retried.orderRef,
      tradeNo: "trade-retry-second",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "71.10",
      totalAmountFen: 7_110,
      appId: "app-123",
      sellerId: "seller-456",
    });
    assert.throws(
      () =>
        retryPaymentOrder(dependencies, {
          oldOrderRef: retried.orderRef,
          idempotencyKey: "retry-attempt-2",
          oldRawAccessToken: ACCESS_TOKEN_B,
          newRawAccessToken: ACCESS_TOKEN_C,
          currentUserId: buyerId,
        }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "coupon_invalid",
    );

    // 原订单从未用过优惠券的情况：retry 也应该无券。
    const noCouponOriginal = createPaymentOrder(dependencies, {
      idempotencyKey: "retry-no-coupon-orig",
      rawAccessToken: ACCESS_TOKEN_C,
      selection: residentialSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 8_900,
      userId: null,
      couponCode: null,
    });
    finalizeClosed(dependencies, {
      outTradeNo: noCouponOriginal.orderRef,
      tradeNo: "trade-no-coupon-orig",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "89.00",
      totalAmountFen: 8_900,
      appId: "app-123",
      sellerId: "seller-456",
    });
    const noCouponRetry = retryPaymentOrder(dependencies, {
      oldOrderRef: noCouponOriginal.orderRef,
      idempotencyKey: "retry-no-coupon-attempt",
      oldRawAccessToken: ACCESS_TOKEN_C,
      newRawAccessToken: Buffer.alloc(32, 0x55).toString("base64url"),
      currentUserId: buyerId,
    });
    assert.equal(noCouponRetry.amountFen, 8_900);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM coupon_redemptions WHERE order_id = (SELECT id FROM orders WHERE order_ref = ?)", noCouponRetry.orderRef), 0);
  });
});

test("PATCH-style coupon update rejects lowering max_redemptions below the already-redeemed count", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const adminId = insertAuthenticationUser(database, {
      email: "admin10@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const coupon = createCoupon(database, {
      code: "capcheck",
      kind: "percent",
      amountOffFen: null,
      percentOff: 10,
      minAmountFen: null,
      scope: "all",
      planIds: [],
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2030-01-01T00:00:00.000Z",
      maxRedemptions: 5,
      adminUserId: adminId,
      now: () => new Date(TEST_NOW),
    });
    createPaymentOrder(dependencies, {
      idempotencyKey: "cap-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_110,
      userId: null,
      couponCode: "capcheck",
    });
    assert.throws(
      () =>
        updateCoupon(database, {
          couponId: coupon.id,
          maxRedemptions: 0,
          now: () => new Date(TEST_NOW),
        }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "invalid_max_redemptions",
    );
  });
});
