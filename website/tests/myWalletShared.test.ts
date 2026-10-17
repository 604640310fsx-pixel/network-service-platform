import assert from "node:assert/strict";
import test from "node:test";
import { getMyWalletSnapshot, refreshMyWallet, subscribeMyWallet, __resetMyWalletSharedForTest,
  // @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
} from "../app/lib/wallet-api.ts";

const wallet = (fen: number) => new Response(JSON.stringify({ balanceFen: fen, currency: "CNY" }),
  { status: 200, headers: { "Content-Type": "application/json" } });

async function withFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  run: (calls: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return handler(input, init);
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
}

function collect() {
  const seen: string[] = [];
  const stop = subscribeMyWallet(() => seen.push(getMyWalletSnapshot().kind));
  return { seen, stop };
}

test("two subscribers receive the same server snapshot together", async () => {
  __resetMyWalletSharedForTest();
  await withFetch(() => wallet(0), async (calls) => {
    const panel = collect();
    const header = collect();
    await refreshMyWallet();
    assert.equal(getMyWalletSnapshot().kind, "ready");
    assert.deepEqual(panel.seen, ["loading", "ready"]);
    assert.deepEqual(header.seen, ["loading", "ready"]);
    assert.equal(calls.filter((u) => u === "/api/me/wallet").length, 1);
    panel.stop(); header.stop();
  });
});

test("confirmed credit refreshes every subscriber to the new server value", async () => {
  __resetMyWalletSharedForTest();
  let fen = 0;
  await withFetch(() => wallet(fen), async (calls) => {
    const panel = collect();
    const header = collect();
    await refreshMyWallet();
    fen = 1234;
    await refreshMyWallet();
    const snap = getMyWalletSnapshot();
    assert.equal(snap.kind, "ready");
    if (snap.kind === "ready") assert.equal(snap.wallet.balanceFen, 1234);
    assert.equal(calls.filter((u) => u === "/api/me/wallet").length, 2);
    panel.stop(); header.stop();
  });
});

test("failed and concurrent reads never invent credit and collapse in-flight retries", async () => {
  __resetMyWalletSharedForTest();
  let calls = 0;
  let release: (() => void) | null = null;
  await withFetch(async () => {
    calls += 1;
    await new Promise<void>((res) => { release = res; });
    return wallet(999);
  }, async () => {
    const p1 = refreshMyWallet();
    const p2 = refreshMyWallet();
    assert.equal(calls, 1);
    release!();
    await p1; await p2;
    // the queued retry fires exactly one follow-up read after the in-flight read settles
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 2);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    const snap = getMyWalletSnapshot();
    assert.equal(snap.kind, "ready");
  });
  __resetMyWalletSharedForTest();
  await withFetch(() => new Response(JSON.stringify({ error: { code: "wallet_unavailable" } }),
    { status: 503, headers: { "Content-Type": "application/json" } }), async () => {
    await refreshMyWallet();
    const snap = getMyWalletSnapshot();
    assert.equal(snap.kind, "error");
    if (snap.kind === "error") assert.equal(snap.code, "wallet_unavailable");
  });
  __resetMyWalletSharedForTest();
  await withFetch(() => new Response(JSON.stringify({ error: { code: "unauthorized" } }),
    { status: 401, headers: { "Content-Type": "application/json" } }), async () => {
    await refreshMyWallet();
    assert.equal(getMyWalletSnapshot().kind, "unauthorized");
  });
});
