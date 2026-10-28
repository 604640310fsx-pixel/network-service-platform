import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { createAlipayPrecreateQrCode } from "../../src/payment/alipay.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  FakeAlipaySdk,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

const QR = "https://qr.alipay.com/bax08431xmsd8ptaa9jf00d1";

async function captureWarnings<Result>(run: () => Promise<Result>): Promise<{ result: Result; warnings: string[] }> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

async function createOrder(sdk: FakeAlipaySdk) {
  return withAuthenticationDatabase(async (database) => {
    const app = buildApp({ payment: paymentDependencies(database, sdk) });
    const buyerId = insertAuthenticationUser(database, { email: "buyer@example.com", passwordHash: "hash", status: "active" });
    const session = insertWebSession(database, buyerId);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
          "idempotency-key": "precreate-key-1",
          "x-order-access-token": ACCESS_TOKEN_A,
        },
        payload: { ...localIspSelection(), contact: "wechat-user", scenarios: ["AI 工具"], notes: null, acknowledgedAmountFen: 7_900 },
      });
      const repeat = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${response.json().orderRef}/pay-page`,
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
          "x-order-access-token": ACCESS_TOKEN_A,
        },
        payload: {},
      });
      return { response, repeat };
    } finally {
      await app.close();
    }
  });
}

test("a successful precreate adds the Alipay QR code next to the unchanged website-pay URL", async () => {
  const sdk = new FakeAlipaySdk();
  sdk.precreateResponse = (ref: unknown) => ({ code: "10000", msg: "Success", outTradeNo: ref, qrCode: QR });
  const { result: { response, repeat }, warnings } = await captureWarnings(() => createOrder(sdk));
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ["amountFen", "currency", "orderRef", "payUrl", "qrCode", "reservedUntil", "status"]);
  assert.equal(body.qrCode, QR);
  assert.equal(body.payUrl, `https://alipay.example.test/pay/${body.orderRef}`);
  // The pay-page recovery path returns the same additive field.
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json().qrCode, QR);
  // Same trade: same out_trade_no, amount and subject as page.pay, notify URL passed.
  const call = sdk.precreateCalls[0]!;
  assert.equal(call.bizContent.outTradeNo, body.orderRef);
  assert.equal(call.bizContent.totalAmount, "79.00");
  assert.equal(call.bizContent.subject, (sdk.pageCalls[0]!.parameters as { bizContent: { subject: string } }).bizContent.subject);
  assert.equal(typeof call.notifyUrl, "string");
  assert.deepEqual(warnings.filter((line) => line.includes("precreate")), []);
});

test("a merchant without 当面付 keeps the frozen website-pay result and logs only provider codes", async () => {
  const sdk = new FakeAlipaySdk();
  const { result: { response }, warnings } = await captureWarnings(() => createOrder(sdk));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), ["amountFen", "currency", "orderRef", "payUrl", "reservedUntil", "status"]);
  assert.ok(warnings.length >= 1);
  assert.deepEqual(JSON.parse(warnings[0]!), { event: "precreate_unavailable", provider_code: "40004", provider_sub_code: "ACQ.ACCESS_FORBIDDEN" });
});

test("SDK errors and malformed QR codes never break checkout or leak into logs", async () => {
  for (const precreateResponse of [
    new Error(`network down ${QR}`),
    { code: "10000", qrCode: "https://evil.example/qr" },
    { code: "10000", qrCode: QR, outTradeNo: "SOME-OTHER-ORDER" },
    "not-an-object",
  ]) {
    const sdk = new FakeAlipaySdk();
    const { result, warnings } = await captureWarnings(() =>
      createAlipayPrecreateQrCode(sdk, { notifyUrl: "https://www.example.test/api/pay/alipay/notify" }, { outTradeNo: "ORDER-1", amountFen: 5_900 }),
    );
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0]!, /qr\.alipay\.com|evil\.example|network down/);
  }
});
