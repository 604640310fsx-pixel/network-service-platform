import type { DatabaseConnection } from "../../src/db.js";
import type {
  AlipaySdkLike,
  AlipayTradeQueryResult,
} from "../../src/payment/alipay.js";
import type { PaymentEnabledDependencies } from "../../src/http/payment-routes.js";
import { generateSessionToken } from "../../src/session/session-token.js";

export const TEST_NOW = new Date("2026-08-21T00:00:00.000Z");
export const TOKEN_KEY = Buffer.alloc(32, 0x41).toString("base64");
export const TOKEN_KEYRING = {
  version: 1,
  keys: { "1": TOKEN_KEY },
} as const;
export const CSRF_KEY = Buffer.alloc(32, 0x42);
export const DELIVERY_KEY = Buffer.alloc(32, 0x43).toString("base64");
export const DELIVERY_KEYRING = {
  version: 2,
  keys: { "1": Buffer.alloc(32, 0x44).toString("base64"), "2": DELIVERY_KEY },
} as const;
export const ACCESS_TOKEN_A = Buffer.alloc(32, 0x11).toString("base64url");
export const ACCESS_TOKEN_B = Buffer.alloc(32, 0x22).toString("base64url");
export const ACCESS_TOKEN_C = Buffer.alloc(32, 0x33).toString("base64url");

export class FakeAlipaySdk implements AlipaySdkLike {
  readonly pageCalls: Array<{
    readonly method: string;
    readonly httpMethod: string;
    readonly parameters: unknown;
  }> = [];
  readonly pageResults: unknown[] = [];
  readonly notifyBodies: Array<Readonly<Record<string, unknown>>> = [];
  readonly queryCalls: string[] = [];
  readonly queryOptions: unknown[] = [];
  readonly closeCalls: string[] = [];
  verifyNotify = true;
  queryResponse: unknown = {
    code: "10000",
    tradeStatus: "WAIT_BUYER_PAY",
    outTradeNo: "unset",
    tradeNo: "trade-unset",
    totalAmount: "79.00",
  };
  closeResponse: unknown = { code: "10000" };

  pageExecute(
    method: "alipay.trade.page.pay",
    httpMethod: "GET",
    parameters: {
      readonly bizContent: Readonly<Record<string, string>>;
      readonly notifyUrl: string;
      readonly returnUrl: string;
    },
  ): string {
    this.pageCalls.push({ method, httpMethod, parameters });
    const result = this.pageResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result === undefined
      ? `https://alipay.example.test/pay/${parameters.bizContent.outTradeNo}`
      : (result as string);
  }

  checkNotifySignV2(parameters: Readonly<Record<string, unknown>>): boolean {
    this.notifyBodies.push(parameters);
    return this.verifyNotify;
  }

  async exec(
    method: "alipay.trade.query" | "alipay.trade.close",
    parameters: {
      readonly bizContent: Readonly<Record<string, string>>;
      readonly notifyUrl?: string;
    },
    options: { readonly validateSign: true },
  ): Promise<unknown> {
    const outTradeNo = parameters.bizContent.outTradeNo;
    if (typeof outTradeNo !== "string") {
      throw new Error("unexpected outTradeNo");
    }
    if (method === "alipay.trade.close") {
      this.closeCalls.push(outTradeNo);
      return this.closeResponse;
    }
    if (method !== "alipay.trade.query") {
      throw new Error("unexpected method");
    }
    this.queryCalls.push(outTradeNo);
    this.queryOptions.push(options);
    return this.queryResponse;
  }
}

export function paymentDependencies(
  database: DatabaseConnection,
  sdk = new FakeAlipaySdk(),
  randomUuid: () => string = () => "11111111-1111-4111-8111-111111111111",
): PaymentEnabledDependencies {
  return {
    enabled: true,
    database,
    tokenHmacKeyring: TOKEN_KEYRING,
    deliveryEncKeyring: DELIVERY_KEYRING,
    csrfSigningKey: CSRF_KEY,
    monitorTargetCatalog: {
      list: async () => [
        { key: "DMIT Premium", label: "DMIT Premium" },
        { key: "Tokyo Transit A", label: "日本东京 VPS 中转 A" },
      ],
    },
    appId: "app-123",
    sellerId: "seller-456",
    notifyUrl: "https://example.test/api/pay/alipay/notify",
    returnUrl: "https://example.test/subscribe/request",
    sdk,
    now: () => new Date(TEST_NOW),
    randomUuid,
  };
}

export function localIspSelection() {
  return {
    typeId: "local-isp",
    regionId: "us",
    ispId: "us-verizon",
    specId: null,
    durationId: "month-1",
  } as const;
}

export function firstValue(
  database: DatabaseConnection,
  source: string,
  ...parameters: readonly unknown[]
): unknown {
  const rows = database.prepare(source).all(...parameters);
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error("query did not return one row");
  }
  return Object.values(rows[0])[0];
}

export function allRows(
  database: DatabaseConnection,
  source: string,
  ...parameters: readonly unknown[]
): Array<Record<string, unknown>> {
  return database.prepare(source).all(...parameters) as Array<
    Record<string, unknown>
  >;
}

export function insertWebSession(
  database: DatabaseConnection,
  userId: number,
): { readonly rawToken: string; readonly cookie: string } {
  const token = generateSessionToken(TOKEN_KEYRING, () => Buffer.alloc(32, userId));
  const familyId = `family-${userId}`;
  database
    .prepare(
      "INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)",
    )
    .run(familyId, userId, TEST_NOW.toISOString());
  database
    .prepare(
      `INSERT INTO sessions (
         token_hash, hmac_key_version, user_id, session_family_id, audience,
         created_at, expires_at, last_seen_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'web', ?, ?, ?, NULL)`,
    )
    .run(
      token.tokenHash,
      token.hmacKeyVersion,
      userId,
      familyId,
      TEST_NOW.toISOString(),
      new Date(TEST_NOW.getTime() + 31 * 24 * 60 * 60 * 1_000).toISOString(),
      TEST_NOW.toISOString(),
    );
  return {
    rawToken: token.rawToken,
    cookie: `__Host-web_session=${token.rawToken}`,
  };
}

export function queryResult(
  input: Partial<AlipayTradeQueryResult> & {
    readonly tradeStatus: string;
    readonly outTradeNo: string;
  },
): unknown {
  return {
    code: input.code ?? "10000",
    subCode: input.subCode ?? undefined,
    tradeStatus: input.tradeStatus,
    outTradeNo: input.outTradeNo,
    tradeNo: input.tradeNo ?? "trade-123",
    totalAmount: input.totalAmount ?? "79.00",
  };
}

export function tradeNotExistResult(): unknown {
  return { code: "40004", subCode: "ACQ.TRADE_NOT_EXIST" };
}
