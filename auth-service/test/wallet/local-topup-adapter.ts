import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "../../src/db.js";
import { creditVerifiedTopup, type VerifiedTopup } from "../../src/wallet/candidate.js";

/** This module lives under test/ and is never imported by src/server.ts. */
export interface LocalTopupAdapter {
  readonly mode: "TEST_ONLY";
  readonly runtime: "test";
  checkoutUrl(topupId: string): string;
}

type SyntheticNotice = {
  readonly orderRef: string;
  readonly providerTradeNo: string;
  readonly merchantId: string;
  readonly amountFen: number;
  readonly currency: string;
  readonly finalStatus: string;
  readonly signature: string;
};

const REF = /^WT[A-Za-z0-9_-]{32}$/;
const NOTICE_KEYS = ["amountFen", "currency", "finalStatus", "merchantId", "orderRef", "providerTradeNo", "signature"];

function sign(secret: Buffer, notice: Omit<SyntheticNotice, "signature">): string {
  const canonical = [notice.orderRef, notice.providerTradeNo, notice.merchantId,
    String(notice.amountFen), notice.currency, notice.finalStatus].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function syntheticNotice(secret: Buffer, input: Omit<SyntheticNotice, "signature">): SyntheticNotice {
  return { ...input, signature: sign(secret, input) };
}

export function verifySyntheticNotice(database: DatabaseConnection, secret: Buffer, merchantId: string,
  raw: unknown): VerifiedTopup | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== NOTICE_KEYS.join(",")) return null;
  const { orderRef, providerTradeNo, amountFen, currency, finalStatus, signature } = body;
  if (typeof orderRef !== "string" || !REF.test(orderRef) ||
      typeof providerTradeNo !== "string" || !/^synthetic-[A-Za-z0-9_-]{1,80}$/.test(providerTradeNo) ||
      body.merchantId !== merchantId || !Number.isSafeInteger(amountFen) || (amountFen as number) <= 0 ||
      currency !== "CNY" || finalStatus !== "SUCCESS" ||
      typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return null;
  const row = database.prepare("SELECT amount_fen,currency FROM wallet_topups WHERE order_ref=?")
    .all(orderRef)[0] as { amount_fen: number; currency: string } | undefined;
  if (row === undefined || row.amount_fen !== amountFen || row.currency !== currency) return null;
  const expected = Buffer.from(sign(secret, body as Omit<SyntheticNotice, "signature">), "hex");
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
  return { orderRef, providerTradeNo, merchantId, amountFen: amountFen as number,
    currency: "CNY", finalStatus: "SUCCESS", signatureVerified: true };
}

export function registerLocalTopupAdapter(app: FastifyInstance, database: DatabaseConnection,
  secret: Buffer, merchantId: string, now: () => Date = () => new Date()): LocalTopupAdapter {
  if (process.env.NODE_ENV === "production" || process.env.TEST_ONLY !== "1") {
    throw new Error("Local topup adapter requires TEST_ONLY=1 outside production");
  }
  app.get<{ Params: { topupId: string } }>("/api/__test/topups/:topupId/checkout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const orderRef = request.params.topupId;
    if (!REF.test(orderRef)) return reply.code(404).send("Not found");
    const row = database.prepare("SELECT amount_fen FROM wallet_topups WHERE order_ref=?")
      .all(orderRef)[0] as { amount_fen: number } | undefined;
    if (row === undefined) return reply.code(404).send("Not found");
    const notice = syntheticNotice(secret, { orderRef, providerTradeNo: `synthetic-${orderRef}`,
      merchantId, amountFen: row.amount_fen, currency: "CNY", finalStatus: "SUCCESS" });
    const json = JSON.stringify(notice).replace(/</g, "\\u003c");
    reply.type("text/html; charset=utf-8");
    return reply.send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>TEST ONLY 充值</title>
      <main><h1>TEST ONLY · 本地模拟支付</h1><p>演示数据 · 非报价；不连接真实支付，不移动资金。</p>
      <p>金额 ¥${(row.amount_fen / 100).toFixed(2)}</p><button id="pay">模拟成功通知</button><p id="result"></p></main>
      <script>document.getElementById('pay').onclick=async()=>{const r=await fetch('/api/__test/topups/notify',
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${json})});
      document.getElementById('result').textContent=r.ok?'模拟通知已验证，请返回原页面查看服务端余额。':'模拟通知失败';};</script></html>`);
  });
  app.post("/api/__test/topups/notify", { bodyLimit: 4096 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const event = verifySyntheticNotice(database, secret, merchantId, request.body);
    if (event === null) return reply.code(400).send({ error: { code: "verification_failed" } });
    try {
      const result = creditVerifiedTopup(database, merchantId, event, now().toISOString());
      return reply.send({ result });
    } catch {
      return reply.code(503).send({ error: { code: "wallet_unavailable" } });
    }
  });
  return { mode: "TEST_ONLY", runtime: "test", checkoutUrl: (topupId) => `/api/__test/topups/${topupId}/checkout` };
}
