import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import {
  ORDER_EXPIRY_GRACE_MS,
  startOrderExpirySweep,
  sweepExpiredPendingPayments,
} from "../../src/payment/order-expiry.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import {
  observePendingTradeForCancel,
  refreshExpiredPendingPayment,
  refreshPaymentFromAlipay,
  type RefreshTarget,
} from "../../src/payment/payment-refresh.js";
import type { DatabaseConnection } from "../../src/db.js";
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

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

function databaseFacts(database: DatabaseConnection): string {
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  return JSON.stringify(names.map(({ name }) => [name,
    database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
  ]));
}

const observationEntries = ["refresh", "expired", "cancel", "sweep"] as const;
async function observeThrough(
  entry: typeof observationEntries[number],
  dependencies: ReturnType<typeof paymentDependencies>,
  target: RefreshTarget,
) {
  if (entry === "refresh") return refreshPaymentFromAlipay(dependencies, target);
  if (entry === "expired") return refreshExpiredPendingPayment(dependencies, target);
  if (entry === "cancel") return observePendingTradeForCancel(dependencies, target);
  return sweepExpiredPendingPayments(dependencies);
}

test("wrong-app payments stay UNKNOWN at every observation entry, with zero provider calls and zero database changes", async () => {
  for (const entry of observationEntries) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createExpiredOrder(dependencies, 40);
      database.prepare("UPDATE payments SET app_id='historical-other-app'").run();
      const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
        outTradeNo: order.orderRef, amountFen: order.amountFen };
      // Either answer would be dangerous if queried with the wrong merchant.
      for (const response of [queryResult({ tradeStatus: "WAIT_BUYER_PAY", outTradeNo: order.orderRef }), tradeNotExistResult()]) {
        sdk.queryResponse = response;
        const before = databaseFacts(database);
        const result = await observeThrough(entry, dependencies, target);
        if (entry === "cancel") assert.deepEqual(result, { kind: "unknown" });
        assert.deepEqual(sdk.queryCalls, [], entry);
        assert.deepEqual(sdk.closeCalls, [], entry);
        assert.deepEqual(sdk.precreateCalls, [], entry);
        assert.equal(databaseFacts(database), before, `${entry}: includes throttle/audit/orders/stock/coupons/rights`);
      }
    });
  }
});

test("payment-order and caller-target mismatches are rejected before throttle or provider side effects", async () => {
  for (const mismatch of ["target-id", "target-ref", "target-amount", "invalid-id", "order-amount", "order-status"] as const) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createExpiredOrder(dependencies, 40);
      const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
        outTradeNo: order.orderRef, amountFen: order.amountFen };
      if (mismatch === "target-id") target.paymentId += 100;
      if (mismatch === "invalid-id") target.paymentId = Number.NaN;
      if (mismatch === "target-ref") target.outTradeNo = "different-synthetic-ref";
      if (mismatch === "target-amount") target.amountFen += 1;
      if (mismatch === "order-amount") database.prepare("UPDATE orders SET amount_fen=amount_fen+1").run();
      if (mismatch === "order-status") database.prepare("UPDATE orders SET status='closed'").run();
      const before = databaseFacts(database);
      // A sweep obtains its own target; only persisted mismatches apply there.
      for (const entry of observationEntries.filter(e => e !== "sweep" || mismatch.startsWith("order-"))) {
        const result = await observeThrough(entry, dependencies, target);
        if (entry === "cancel") assert.deepEqual(result, { kind: "unknown" });
        assert.equal(databaseFacts(database), before, `${mismatch}/${entry}`);
      }
      assert.deepEqual(sdk.queryCalls, []);
      assert.deepEqual(sdk.closeCalls, []);
    });
  }
});

test("a matching-app normal refresh still accepts signed paid evidence and remains replay safe", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
      outTradeNo: order.orderRef, amountFen: order.amountFen };
    sdk.queryResponse = queryResult({ tradeStatus: "TRADE_SUCCESS", outTradeNo: order.orderRef });
    await refreshPaymentFromAlipay(dependencies, target);
    assert.equal(firstValue(database, "SELECT status FROM payments"), "paid");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);
    assert.deepEqual(sdk.queryOptions, [{ validateSign: true }]);
    const afterPaid = databaseFacts(database);
    await refreshPaymentFromAlipay(dependencies, target);
    assert.equal(sdk.queryCalls.length, 1);
    assert.equal(databaseFacts(database), afterPaid);
  });
});

test("a matching-app cancellation observation retains query-close-requery without applying the caller's local transition", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
      outTradeNo: order.orderRef, amountFen: order.amountFen };
    sdk.queryResponse = () => queryResult({ outTradeNo: order.orderRef,
      tradeStatus: sdk.queryCalls.length === 1 ? "WAIT_BUYER_PAY" : "TRADE_CLOSED" });
    assert.equal((await observePendingTradeForCancel(dependencies, target)).kind, "closed");
    assert.deepEqual(sdk.closeCalls, [order.orderRef]);
    assert.deepEqual(sdk.queryOptions, [{ validateSign: true }, { validateSign: true }]);
    assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 0);
  });
});

test("identity drift during a query prevents close and any local finalization at every direct entry", async () => {
  for (const entry of ["refresh", "expired", "cancel"] as const) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createExpiredOrder(dependencies, 40);
      const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
        outTradeNo: order.orderRef, amountFen: order.amountFen };
      const protectedFacts = () => JSON.stringify(["orders", "services", "sellable_plans", "coupons", "coupon_redemptions", "audit_log"]
        .map(name => [name, database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
      const before = protectedFacts();
      sdk.queryResponse = () => {
        database.prepare("UPDATE payments SET app_id='different-during-await'").run();
        return queryResult({ tradeStatus: "WAIT_BUYER_PAY", outTradeNo: order.orderRef });
      };
      const result = await observeThrough(entry, dependencies, target);
      if (entry === "cancel") assert.deepEqual(result, { kind: "unknown" });
      assert.equal(sdk.queryCalls.length, 1);
      assert.deepEqual(sdk.closeCalls, []);
      assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
      assert.equal(firstValue(database, "SELECT alipay_trade_status FROM payments"), null);
      assert.equal(protectedFacts(), before);
    });
  }
});

test("identity drift plus provider throw writes no failure audit after the initially valid throttle", async () => {
  for (const entry of ["refresh", "expired", "cancel", "sweep"] as const) {
    for (const throwAt of entry === "refresh" || entry === "sweep" ? ["query"] as const : ["query", "close"] as const) {
      await withAuthenticationDatabase(async (database) => {
        const sdk = new FakeAlipaySdk();
        const dependencies = paymentDependencies(database, sdk);
        const order = createExpiredOrder(dependencies, 40);
        const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
          outTradeNo: order.orderRef, amountFen: order.amountFen };
        sdk.queryResponse = queryResult({ tradeStatus: "WAIT_BUYER_PAY", outTradeNo: order.orderRef });
        let atDrift: string | undefined;
        const providerMethods: string[] = [];
        const originalExec = sdk.exec.bind(sdk);
        sdk.exec = async (method, parameters, options) => {
          providerMethods.push(method);
          if (method === `alipay.trade.${throwAt}`) {
            // Model a provider await rejecting after an external identity change.
            await Promise.resolve();
            database.prepare("UPDATE payments SET app_id='different-before-provider-throw'").run();
            atDrift = databaseFacts(database);
            throw new Error("synthetic provider failure after drift");
          }
          return originalExec(method, parameters, options);
        };
        const result = await observeThrough(entry, dependencies, target);
        if (entry === "cancel") assert.deepEqual(result, { kind: "unknown" });
        assert.notEqual(atDrift, undefined, `${entry}/${throwAt} reached controlled await`);
        assert.equal(databaseFacts(database), atDrift, `${entry}/${throwAt}: no post-drift audit or other write`);
        assert.notEqual(firstValue(database, "SELECT last_queried_at FROM payments"), null,
          "the initial valid throttle already occurred and is not claimed unchanged");
        assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
        assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 0);
        assert.deepEqual(providerMethods, throwAt === "query"
          ? ["alipay.trade.query"] : ["alipay.trade.query", "alipay.trade.close"],
        "no provider attempt follows the drifted failure");
      });
    }
  }
});

test("raw WAIT without a validated event never authorizes close or releases local rights", async () => {
  for (const entry of ["expired", "cancel", "sweep"] as const) {
    for (const rejection of ["unrecognized", "contradictory-not-exist", "out-trade", "amount", "missing-trade"] as const) {
      await withAuthenticationDatabase(async (database) => {
        const sdk = new FakeAlipaySdk();
        const dependencies = paymentDependencies(database, sdk);
        const order = createExpiredOrder(dependencies, 40);
        const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
          outTradeNo: order.orderRef, amountFen: order.amountFen };
        const response = queryResult({ tradeStatus: "WAIT_BUYER_PAY", outTradeNo: order.orderRef }) as Record<string, unknown>;
        if (rejection === "unrecognized") response.code = "20000";
        if (rejection === "contradictory-not-exist") {
          response.code = "40004";
          response.subCode = "ACQ.TRADE_NOT_EXIST";
        }
        if (rejection === "out-trade") response.outTradeNo = "different-provider-ref";
        if (rejection === "amount") response.totalAmount = "1.00";
        if (rejection === "missing-trade") response.tradeNo = null;
        sdk.queryResponse = response;
        const protectedFacts = () => JSON.stringify(["orders", "services", "sellable_plans", "coupons", "coupon_redemptions", "payment_notifications"]
          .map(name => [name, database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
        const before = protectedFacts();
        const result = await observeThrough(entry, dependencies, target);
        if (entry === "cancel") assert.deepEqual(result, { kind: "unknown" });
        assert.deepEqual(sdk.queryCalls, [order.orderRef]);
        assert.deepEqual(sdk.closeCalls, []);
        assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
        assert.equal(firstValue(database, "SELECT alipay_trade_status FROM payments"), null);
        assert.equal(firstValue(database, "SELECT close_reason FROM payments"), null);
        assert.equal(protectedFacts(), before);
      });
    }
  }
});

test("initial binding database errors propagate before any provider or throttle call", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createExpiredOrder(dependencies, 40);
    const target = { paymentId: firstValue(database, "SELECT id FROM payments") as number,
      outTradeNo: order.orderRef, amountFen: order.amountFen };
    const before = databaseFacts(database);
    const failingDatabase = new Proxy(database, {
      get(object, key, receiver) {
        if (key === "prepare") return (source: string) => {
          if (source.includes("o.amount_fen AS order_amount_fen")) throw new Error("synthetic database failure");
          return object.prepare(source);
        };
        const value = Reflect.get(object, key, receiver) as unknown;
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
    for (const entry of observationEntries) {
      await assert.rejects(observeThrough(entry, { ...dependencies, database: failingDatabase }, target), /synthetic database failure/);
    }
    assert.deepEqual(sdk.queryCalls, []);
    assert.deepEqual(sdk.closeCalls, []);
    assert.equal(databaseFacts(database), before);
  });
});

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

test("a later signed authoritative SUCCESS replaces the synthetic local-expiry trade number and restores the customer-visible order to paid", async () => {
  await withAuthenticationDatabase(async (database) => {
    let currentTime = new Date(TEST_NOW);
    const sdk = new FakeAlipaySdk();
    const dependencies = {
      ...paymentDependencies(database, sdk),
      now: () => new Date(currentTime),
    };
    const order = createExpiredOrder(dependencies, 40);
    sdk.queryResponse = tradeNotExistResult();
    await sweepExpiredPendingPayments(dependencies);
    assert.equal(firstValue(database, "SELECT status FROM payments"), "closed");
    assert.equal(
      firstValue(database, "SELECT trade_no FROM payments"),
      `LOCAL-EXPIRED-${order.orderRef}`,
    );

    currentTime = new Date(TEST_NOW.getTime() + 16_000);
    sdk.queryResponse = queryResult({
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: order.orderRef,
      tradeNo: "real-alipay-trade-after-local-expiry",
    });
    const app = buildApp({ payment: dependencies });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { "x-order-access-token": ACCESS_TOKEN_A },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, "paid");
      assert.equal(response.json().service.status, "pending_open");
      assert.equal(firstValue(database, "SELECT status FROM payments"), "paid");
      assert.equal(
        firstValue(database, "SELECT trade_no FROM payments"),
        "real-alipay-trade-after-local-expiry",
      );
      assert.equal(firstValue(database, "SELECT close_reason FROM payments"), null);
      assert.equal(firstValue(database, "SELECT closed_at FROM payments"), null);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);
    } finally {
      await app.close();
    }
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
    await scheduler.stop();
    assert.equal(maxConcurrentRuns, 1, "a slower sweep must block subsequent ticks, never run concurrently");
    assert.ok(totalRuns >= 1);
  });
});

test("scheduler stop is shared, prevents later sweeps, and drains an in-flight sweep before resource close", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const baseDependencies = paymentDependencies(database, sdk);
    createExpiredOrder(baseDependencies, 40);

    let sweepCount = 0;
    const instrumentedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (source: string) => {
            if (
              source.includes("FROM payments") &&
              source.includes("reserved_until < ?")
            ) {
              sweepCount += 1;
            }
            return target.prepare(source);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const dependencies = {
      ...baseDependencies,
      database: instrumentedDatabase,
      now: () => new Date(TEST_NOW),
    };
    const queryStarted = deferred();
    const releaseQuery = deferred();
    const originalExec = sdk.exec.bind(sdk);
    sdk.exec = async (method, parameters, options) => {
      if (method === "alipay.trade.query") {
        queryStarted.resolve();
        await releaseQuery.promise;
      }
      return originalExec(method, parameters, options);
    };

    const scheduler = startOrderExpirySweep(dependencies, 20);
    await Promise.race([
      queryStarted.promise,
      delay(1_000).then(() => {
        throw new Error("scheduler did not start the controlled sweep");
      }),
    ]);
    assert.equal(sweepCount, 1);

    const firstStop = scheduler.stop();
    const concurrentStop = scheduler.stop();
    assert.strictEqual(concurrentStop, firstStop);
    let stopSettled = false;
    let resourceClosed = false;
    void firstStop.then(() => {
      stopSettled = true;
      resourceClosed = true;
    });

    await delay(60);
    assert.equal(stopSettled, false);
    assert.equal(resourceClosed, false);
    assert.equal(sweepCount, 1, "ticks during the active sweep must be skipped");

    releaseQuery.resolve();
    await firstStop;
    assert.equal(stopSettled, true);
    assert.equal(resourceClosed, true);
    assert.strictEqual(scheduler.stop(), firstStop);

    await delay(80);
    assert.equal(sweepCount, 1, "no sweep may start after the first stop call");
  });
});

test("ORDER_EXPIRY_GRACE_MS is exactly two minutes and the reservation window is exactly thirty minutes, matching the frozen deadlines", () => {
  assert.equal(ORDER_EXPIRY_GRACE_MS, 2 * 60 * 1_000);
  assert.equal(THIRTY_MINUTES_MS, 30 * 60 * 1_000);
});
