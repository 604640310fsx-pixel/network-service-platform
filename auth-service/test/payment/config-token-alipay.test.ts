import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadAlipayConfig,
  loadConfig,
  loadDeliveryCredentialConfig,
} from "../../src/config.js";
import { issueCsrfToken, verifyCsrfToken } from "../../src/http/csrf.js";
import {
  createAlipayPagePayUrl,
  formatFenAsYuan,
  parseYuanAsFen,
} from "../../src/payment/alipay.js";
import {
  computeOrderAccessTokenHash,
  orderAccessTokenExpiry,
} from "../../src/session/order-access-token.js";
import {
  ACCESS_TOKEN_A,
  CSRF_KEY,
  DELIVERY_KEYRING,
  FakeAlipaySdk,
  TEST_NOW,
  TOKEN_KEYRING,
} from "./helpers.js";

test("disabled payment config does not require or read Alipay keys", () => {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "3101",
    DB_PATH: "/tmp/payment-disabled.sqlite",
    NODE_ENV: "test",
    REGISTRATION_ENABLED: "false",
    PAYMENT_ENABLED: "false",
    ALIPAY_PRIVATE_KEY_FILE: "/path/that/does/not/exist",
    ALIPAY_PUBLIC_KEY_FILE: "/path/that/does/not/exist",
  });
  assert.equal(config.paymentEnabled, false);
  assert.throws(
    () => loadAlipayConfig({ PAYMENT_ENABLED: "false" }),
    /Alipay configuration is disabled/,
  );
});

test("delivery credential loader reads only the frozen independent keyring", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delivery-config-"));
  try {
    const path = join(directory, "delivery_payload_enc_keyring");
    await writeFile(path, JSON.stringify(DELIVERY_KEYRING), "utf8");
    assert.deepEqual(
      loadDeliveryCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      { deliveryEncKeyring: DELIVERY_KEYRING },
    );

    await writeFile(
      path,
      JSON.stringify({ version: 2, keys: { "2": "not-base64" } }),
      "utf8",
    );
    assert.throws(
      () => loadDeliveryCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      /Delivery credential configuration is invalid/,
    );
    await rm(path);
    assert.throws(
      () => loadDeliveryCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      /Delivery credential configuration is invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabled payment config requires every exact field and loads public-key mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alipay-config-"));
  try {
    const privateKeyFile = join(directory, "merchant-private.pem");
    const publicKeyFile = join(directory, "alipay-public.pem");
    await writeFile(privateKeyFile, "PRIVATE-KEY-CONTENT\n", "utf8");
    await writeFile(publicKeyFile, "PUBLIC-KEY-CONTENT\n", "utf8");
    const environment: NodeJS.ProcessEnv = {
      PAYMENT_ENABLED: "true",
      ALIPAY_ENVIRONMENT: "sandbox",
      ALIPAY_APP_ID: "app-123",
      ALIPAY_SELLER_ID: "seller-456",
      ALIPAY_NOTIFY_URL: "https://example.test/notify",
      ALIPAY_RETURN_URL: "https://example.test/return",
      ALIPAY_PRIVATE_KEY_FILE: privateKeyFile,
      ALIPAY_PUBLIC_KEY_FILE: publicKeyFile,
      ALIPAY_PRIVATE_KEY_TYPE: "PKCS8",
    };
    assert.deepEqual(loadAlipayConfig(environment), {
      appId: "app-123",
      sellerId: "seller-456",
      gateway: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
      notifyUrl: "https://example.test/notify",
      returnUrl: "https://example.test/return",
      privateKey: "PRIVATE-KEY-CONTENT",
      alipayPublicKey: "PUBLIC-KEY-CONTENT",
      privateKeyType: "PKCS8",
    });
    for (const name of [
      "ALIPAY_APP_ID",
      "ALIPAY_SELLER_ID",
      "ALIPAY_ENVIRONMENT",
      "ALIPAY_NOTIFY_URL",
      "ALIPAY_RETURN_URL",
      "ALIPAY_PRIVATE_KEY_FILE",
      "ALIPAY_PUBLIC_KEY_FILE",
      "ALIPAY_PRIVATE_KEY_TYPE",
    ]) {
      assert.throws(
        () => loadAlipayConfig({ ...environment, [name]: undefined }),
        /Alipay configuration is invalid/,
        name,
      );
    }
    assert.throws(
      () =>
        loadAlipayConfig({
          ...environment,
          ALIPAY_PRIVATE_KEY_TYPE: "RSA2",
        }),
      /Alipay configuration is invalid/,
    );
    assert.throws(
      () =>
        loadAlipayConfig({
          ...environment,
          ALIPAY_ENVIRONMENT: "staging",
        }),
      /Alipay configuration is invalid/,
    );
    assert.equal(
      loadAlipayConfig({
        ...environment,
        ALIPAY_ENVIRONMENT: "production",
      }).gateway,
      "https://openapi.alipay.com/gateway.do",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("order access token is exactly 43 base64url characters in its own HKDF domain", () => {
  assert.equal(ACCESS_TOKEN_A.length, 43);
  assert.match(ACCESS_TOKEN_A, /^[A-Za-z0-9_-]{43}$/);
  const orderToken = computeOrderAccessTokenHash(ACCESS_TOKEN_A, TOKEN_KEYRING);
  assert.deepEqual(orderToken, {
    tokenHash: orderToken.tokenHash,
    tokenKeyVersion: 1,
  });
  assert.equal(orderToken.tokenHash.length, 43);
  assert.equal(
    orderAccessTokenExpiry(TEST_NOW),
    "2026-09-20T00:00:00.000Z",
  );
  assert.throws(() => computeOrderAccessTokenHash(`v1.${ACCESS_TOKEN_A}`, TOKEN_KEYRING));
});

test("CSRF verification is strict and constant-length", () => {
  const sessionHash = Buffer.alloc(32, 0x51).toString("base64url");
  const token = issueCsrfToken(CSRF_KEY, sessionHash);
  assert.equal(verifyCsrfToken(CSRF_KEY, sessionHash, token), true);
  assert.equal(verifyCsrfToken(CSRF_KEY, sessionHash, `${token.slice(0, -1)}A`), false);
  assert.equal(verifyCsrfToken(CSRF_KEY, sessionHash, [token]), false);
});

test("pageExecute uses the frozen GET contract and exact integer amount formatting", () => {
  assert.equal(formatFenAsYuan(0), "0.00");
  assert.equal(formatFenAsYuan(89), "0.89");
  assert.equal(formatFenAsYuan(527_000), "5270.00");
  assert.equal(parseYuanAsFen("5270.00"), 527_000);
  assert.equal(parseYuanAsFen("0.9"), 90);
  assert.equal(parseYuanAsFen("1.001"), null);

  const sdk = new FakeAlipaySdk();
  const payUrl = createAlipayPagePayUrl(
    sdk,
    {
      notifyUrl: "https://example.test/notify",
      returnUrl: "https://example.test/return",
    },
    { outTradeNo: "DL123", amountFen: 8_900 },
  );
  assert.equal(payUrl, "https://alipay.example.test/pay/DL123");
  assert.deepEqual(sdk.pageCalls, [
    {
      method: "alipay.trade.page.pay",
      httpMethod: "GET",
      parameters: {
        bizContent: {
          outTradeNo: "DL123",
          productCode: "FAST_INSTANT_TRADE_PAY",
          totalAmount: "89.00",
          subject: "网络环境诊断与人工技术服务",
          timeoutExpress: "30m",
        },
        notifyUrl: "https://example.test/notify",
        returnUrl: "https://example.test/return",
      },
    },
  ]);
});
