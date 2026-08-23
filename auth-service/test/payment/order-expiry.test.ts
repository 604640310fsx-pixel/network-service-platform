import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  ORDER_EXPIRY_GRACE_MS,
  startOrderExpirySweep,
  sweepExpiredPendingPayments,
} from "../../src/payment/order-expiry.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  FakeAlipaySdk,
  TEST_NOW,
  firstValue,
  localIspSelection,
  paymentDependencies,
  queryResult,
  tradeNotExistResult,
} from "./helpers.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1_000;

function createExpiredOrder(
  dependencies: ReturnType<typeof paymentDependencies>,
  createdMinutesAgo: number,
) {
  const createdAt = new Date(new Date(TEST_NOW).getTime() - createdMinutesAgo * 60 * 1_000);
  return createPaymentOrder(
    { ...dependencies, now: () => createdAt },
    {
      idempotencyKey: `expiry-key-${createdMinutesAgo}`,
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "wechat",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: null,
      couponCode: null,
    },
  );
}

test("the sweep ignores pending payments that have not yet passed the 30-minute deadline plus 2-minute grace", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    // 刚创建，远未到期。
    createExpiredOrder(dependencies, 5);
    const result = await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(result.scanned, 0);
    assert.equal(sdk.queryCalls.length, 0);
    assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
  });
});

test("an order created exactly at the 30-minute deadline is not yet swept until the 2-minute grace also passes", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    createExpiredOrder(dependencies, 30); // reserved_until == now exactly
    const result = await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(result.scanned, 0);
    assert.equal(sdk.queryCalls.length, 0);
  });
});

test("expired-but-actually-paid: the sweep must finalize as paid, never close, when Alipay's authoritative query says TRADE_SUCCESS", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    sdk.queryResponse = queryResult({
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: order.orderRef,
      tradeNo: "trade-swept-paid",
    });
    const result = await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(result.scanned, 1);
    assert.equal(firstValue(database, "SELECT status FROM payments"), "paid");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);
    // 未占用超发计数：唯一一次占用（创建时）依然计着，从未被释放。
    assert.equal(
      firstValue(
        database,
        `SELECT occupied_slots FROM sellable_plans
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      ),
      1,
    );
  });
});

test("WAIT_BUYER_PAY past grace triggers an active trade.close then a requery; still-waiting keeps pending and does not release", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    sdk.queryResponse = queryResult({
      tradeStatus: "WAIT_BUYER_PAY",
      outTradeNo: order.orderRef,
    });
    await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.deepEqual(sdk.closeCalls, [order.orderRef]);
    assert.equal(sdk.queryCalls.length, 2); // 首次查询 + 关单后复查
    assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
    assert.equal(
      firstValue(
        database,
        `SELECT occupied_slots FROM sellable_plans
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      ),
      1,
    );
  });
});

test("WAIT_BUYER_PAY past grace: if the requery after trade.close confirms TRADE_CLOSED, the order closes and its slot releases", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    let callCount = 0;
    const originalExec = sdk.exec.bind(sdk);
    sdk.exec = async (method, parameters, options) => {
      if (method === "alipay.trade.query") {
        callCount += 1;
        sdk.queryResponse =
          callCount === 1
            ? queryResult({ tradeStatus: "WAIT_BUYER_PAY", outTradeNo: order.orderRef, tradeNo: "trade-consistent" })
            : queryResult({ tradeStatus: "TRADE_CLOSED", outTradeNo: order.orderRef, tradeNo: "trade-consistent" });
      }
      return originalExec(method, parameters, options);
    };
    await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(sdk.closeCalls.length, 1);
    assert.equal(firstValue(database, "SELECT status FROM payments"), "closed");
    assert.equal(
      firstValue(
        database,
        `SELECT occupied_slots FROM sellable_plans
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      ),
      0,
    );
  });
});

test("WAIT_BUYER_PAY past grace: if the requery after trade.close discovers TRADE_SUCCESS (buyer paid mid-close-race), paid wins and nothing is released", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    let callCount = 0;
    const originalExec = sdk.exec.bind(sdk);
    sdk.exec = async (method, parameters, options) => {
      if (method === "alipay.trade.query") {
        callCount += 1;
        sdk.queryResponse =
          callCount === 1
            ? queryResult({ tradeStatus: "WAIT_BUYER_PAY", outTradeNo: order.orderRef, tradeNo: "trade-raced-paid" })
            : queryResult({ tradeStatus: "TRADE_SUCCESS", outTradeNo: order.orderRef, tradeNo: "trade-raced-paid" });
      }
      return originalExec(method, parameters, options);
    };
    await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(firstValue(database, "SELECT status FROM payments"), "paid");
    assert.equal(
      firstValue(
        database,
        `SELECT occupied_slots FROM sellable_plans
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      ),
      1,
    );
  });
});

test("ACQ.TRADE_NOT_EXIST past the deadline and grace allows a local close via the exact same finalizeClosed path, releasing the slot", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    sdk.queryResponse = tradeNotExistResult();
    await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(firstValue(database, "SELECT status FROM payments"), "closed");
    assert.equal(firstValue(database, "SELECT close_reason FROM payments"), "alipay_trade_closed");
    assert.equal(
      firstValue(
        database,
        `SELECT occupied_slots FROM sellable_plans
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      ),
      0,
    );
    assert.equal(
      firstValue(
        database,
        "SELECT COUNT(*) FROM audit_log WHERE action = 'payment.expired_locally_closed' AND target_ref = ?",
        order.orderRef,
      ),
      1,
    );
    // 合成关闭事件不产生真实通知记录。
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 0);
  });
});

test("unknown trade_status or a query exception past grace keeps the payment pending and releases nothing", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    createExpiredOrder(dependencies, 40);
    sdk.queryResponse = { code: "10000", tradeStatus: "SOMETHING_ELSE", outTradeNo: "ignored" };
    await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
    assert.equal(
      firstValue(
        database,
        `SELECT occupied_slots FROM sellable_plans
         WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND spec_id IS NULL AND duration_id='month-1'`,
      ),
      1,
    );
  });
});

test("a network exception during the sweep's query leaves the payment pending", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    createExpiredOrder(dependencies, 40);
    sdk.exec = async () => {
      throw new Error("network unavailable");
    };
    await sweepExpiredPendingPayments({ ...dependencies, now: () => new Date(TEST_NOW) });
    assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
  });
});

test("the in-process scheduler never overlaps two sweeps: a slow sweep in flight causes the next tick to be skipped", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    createExpiredOrder(dependencies, 40);
    let concurrentRuns = 0;
    let maxConcurrentRuns = 0;
    let totalRuns = 0;
    const originalExec = sdk.exec.bind(sdk);
    sdk.exec = async (method, parameters, options) => {
      if (method === "alipay.trade.query") {
        concurrentRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
        totalRuns += 1;
        await delay(120);
        concurrentRuns -= 1;
      }
      return originalExec(method, parameters, options);
    };
    const scheduler = startOrderExpirySweep({ ...dependencies, now: () => new Date(TEST_NOW) }, 40);
    await delay(500);
    scheduler.stop();
    assert.equal(maxConcurrentRuns, 1, "a slower sweep must block subsequent ticks, never run concurrently");
    assert.ok(totalRuns >= 1);
  });
});

test("ORDER_EXPIRY_GRACE_MS is exactly two minutes and the reservation window is exactly thirty minutes, matching the frozen deadlines", () => {
  assert.equal(ORDER_EXPIRY_GRACE_MS, 2 * 60 * 1_000);
  assert.equal(THIRTY_MINUTES_MS, 30 * 60 * 1_000);
});
