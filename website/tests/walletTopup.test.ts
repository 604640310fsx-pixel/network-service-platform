import assert from "node:assert/strict";
import test from "node:test";
import { createMyTopup, getMyTopup, parseTopupYuan, WalletApiError,
  // @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
} from "../app/lib/wallet-api.ts";

const TOPUP_ID = `WT${"A".repeat(32)}`;
const PENDING = { topupId: TOPUP_ID, status: "PENDING", amountFen: 125, currency: "CNY", succeededAt: null };

async function withFetch(body: unknown, run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<void>, status = 200) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test("topup amount parsing is exact and rejects invalid or unsafe fen", () => {
  assert.equal(parseTopupYuan("1.25"), 125);
  assert.equal(parseTopupYuan("0.01"), 1);
  assert.equal(parseTopupYuan("0"), null);
  assert.equal(parseTopupYuan("1.234"), null);
  assert.equal(parseTopupYuan("-1"), null);
  assert.equal(parseTopupYuan("90071992547410"), null);
});

test("topup client sends exact body, CSRF and key, then reads server status", async () => {
  await withFetch({ ...PENDING, checkout: { kind: "REDIRECT", url: `/api/__test/topups/${TOPUP_ID}/checkout` } }, async (calls) => {
    const intent = await createMyTopup("csrf", "idem-key", 125);
    assert.equal(intent.topupId, TOPUP_ID);
    assert.equal(calls[0]?.url, "/api/me/wallet/topups");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(calls[0]?.init.body, '{"amountFen":125}');
    assert.equal(calls[0]?.init.cache, "no-store");
    assert.equal(calls[0]?.init.credentials, "same-origin");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["X-CSRF-Token"], "csrf");
    assert.equal(headers["Idempotency-Key"], "idem-key");
  });
  await withFetch({ ...PENDING, status: "SUCCEEDED", succeededAt: "2026-10-07T00:00:00.000Z" }, async (calls) => {
    assert.equal((await getMyTopup(TOPUP_ID)).status, "SUCCEEDED");
    assert.equal(calls[0]?.url, `/api/me/wallet/topups/${TOPUP_ID}`);
    assert.equal(calls[0]?.init.method, "GET");
  });
});

test("topup client refuses malformed success and preserves server errors", async () => {
  for (const body of [{ ...PENDING, status: "SUCCEEDED" }, { ...PENDING, amountFen: 0 },
    { ...PENDING, checkout: { kind: "REDIRECT", url: "" } }]) {
    await withFetch(body, async () => {
      await assert.rejects(createMyTopup("csrf", "idem-key", 125), (error: unknown) =>
        error instanceof WalletApiError && error.code === "invalid_response");
    });
  }
  await withFetch({ error: { code: "wallet_unavailable" } }, async () => {
    await assert.rejects(getMyTopup(TOPUP_ID), (error: unknown) =>
      error instanceof WalletApiError && error.code === "wallet_unavailable" && error.status === 503);
  }, 503);
});
