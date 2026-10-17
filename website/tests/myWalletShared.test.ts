import assert from "node:assert/strict";
import test from "node:test";
import { getMyWalletSnapshotFor, refreshMyWallet, subscribeMyWallet, __resetMyWalletSharedForTest,
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

function collect(owner: string) {
  const seen: string[] = [];
  const stop = subscribeMyWallet(() => seen.push(getMyWalletSnapshotFor(owner).kind));
  return { seen, stop };
}

test("two subscribers receive the same server snapshot together", async () => {
  __resetMyWalletSharedForTest();
  await withFetch(() => wallet(0), async (calls) => {
    const panel = collect("A");
    const header = collect("A");
    await refreshMyWallet("A");
    assert.equal(getMyWalletSnapshotFor("A").kind, "ready");
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
    const panel = collect("A");
    const header = collect("A");
    await refreshMyWallet("A");
    fen = 1234;
    await refreshMyWallet("A");
    const snap = getMyWalletSnapshotFor("A");
    assert.equal(snap.kind, "ready");
    if (snap.kind === "ready") assert.equal(snap.wallet.balanceFen, 1234);
    assert.equal(calls.filter((u) => u === "/api/me/wallet").length, 2);
    panel.stop(); header.stop();
  });
});

test("identity boundary never exposes the prior owner's snapshot", async () => {
  __resetMyWalletSharedForTest();
  await withFetch(() => wallet(500), async (calls) => {
    await refreshMyWallet("A");
    const snapA = getMyWalletSnapshotFor("A");
    assert.equal(snapA.kind, "ready");
    if (snapA.kind === "ready") assert.equal(snapA.wallet.balanceFen, 500);
    // first-paint fence: B reads loading, never A's cached value
    assert.equal(getMyWalletSnapshotFor("B").kind, "loading");
    const pB = refreshMyWallet("B");
    assert.equal(getMyWalletSnapshotFor("B").kind, "loading");
    await pB;
    const snapB = getMyWalletSnapshotFor("B");
    assert.equal(snapB.kind, "ready");
    // A's view is fenced in both directions
    assert.equal(getMyWalletSnapshotFor("A").kind, "loading");
    assert.equal(calls.filter((u) => u === "/api/me/wallet").length, 2);
  });
});

test("a late displaced response can neither publish nor clear the new owner's read", async () => {
  __resetMyWalletSharedForTest();
  let calls = 0;
  const releases: Array<(() => void) | undefined> = [];
  await withFetch(async () => {
    const i = calls;
    calls += 1;
    await new Promise<void>((res) => { releases[i] = res; });
    return wallet(i === 0 ? 111 : 222);
  }, async () => {
    const pA = refreshMyWallet("A");
    const pB = refreshMyWallet("B");
    assert.equal(calls, 2);
    releases[0]!();                    // A's response lands LATE, after B took over
    await pA.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getMyWalletSnapshotFor("B").kind, "loading"); // A never published to B
    releases[1]!();
    await pB;
    // ready could only be emitted while walletInflight still === B's fetch —
    // A's displaced finally neither published nor cleared it.
    const snapB = getMyWalletSnapshotFor("B");
    assert.equal(snapB.kind, "ready");
    if (snapB.kind === "ready") assert.equal(snapB.wallet.balanceFen, 222);
    assert.equal(calls, 2);
    assert.equal(getMyWalletSnapshotFor("A").kind, "loading");
  });
});

test("failed and unauthorized reads broadcast distinct states and never invent credit", async () => {
  __resetMyWalletSharedForTest();
  await withFetch(() => new Response(JSON.stringify({ error: { code: "wallet_unavailable" } }),
    { status: 503, headers: { "Content-Type": "application/json" } }), async () => {
    await refreshMyWallet("A");
    const snap = getMyWalletSnapshotFor("A");
    assert.equal(snap.kind, "error");
    if (snap.kind === "error") assert.equal(snap.code, "wallet_unavailable");
  });
  __resetMyWalletSharedForTest();
  await withFetch(() => new Response(JSON.stringify({ error: { code: "unauthorized" } }),
    { status: 401, headers: { "Content-Type": "application/json" } }), async () => {
    await refreshMyWallet("A");
    assert.equal(getMyWalletSnapshotFor("A").kind, "unauthorized");
  });
});

test("A -> logout -> B never leaks A's snapshot across the anonymous boundary", async () => {
  __resetMyWalletSharedForTest();
  let authed = true;
  const denied = () => new Response(JSON.stringify({ error: { code: "unauthorized" } }),
    { status: 401, headers: { "Content-Type": "application/json" } });
  await withFetch(() => authed ? wallet(500) : denied(), async (calls) => {
    await refreshMyWallet("user:A");
    const snapA = getMyWalletSnapshotFor("user:A");
    assert.equal(snapA.kind, "ready");
    if (snapA.kind === "ready") assert.equal(snapA.wallet.balanceFen, 500);

    authed = false;
    const pAnon = refreshMyWallet("anonymous");          // SPA logout boundary
    assert.equal(getMyWalletSnapshotFor("anonymous").kind, "loading"); // first-paint fence
    assert.equal(getMyWalletSnapshotFor("user:A").kind, "loading");    // A fenced immediately
    await pAnon;
    assert.equal(getMyWalletSnapshotFor("anonymous").kind, "unauthorized"); // 401 maps, not A's balance

    authed = true;
    await refreshMyWallet("user:B");
    const snapB = getMyWalletSnapshotFor("user:B");
    assert.equal(snapB.kind, "ready");
    assert.equal(getMyWalletSnapshotFor("user:A").kind, "loading");
    assert.equal(getMyWalletSnapshotFor("anonymous").kind, "loading");
    assert.equal(calls.filter((u) => u === "/api/me/wallet").length, 3);
  });
});

test("a late displaced FAILURE can neither publish nor clear the new owner's read", async () => {
  __resetMyWalletSharedForTest();
  let calls = 0;
  const gates: Array<{ res: (r: Response) => void; rej: (e: unknown) => void } | undefined> = [];
  await withFetch(() => new Promise<Response>((res, rej) => {
    const i = calls;
    calls += 1;
    gates[i] = { res, rej };
  }), async () => {
    const pA = refreshMyWallet("A");
    const pB = refreshMyWallet("B");                     // identity boundary displaces A
    assert.equal(calls, 2);
    gates[0]!.rej(new Error("network down"));            // A's request FAILS late, after B took over
    await pA.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getMyWalletSnapshotFor("B").kind, "loading"); // A's error never published to B
    gates[1]!.res(wallet(222));
    await pB;
    const snapB = getMyWalletSnapshotFor("B");
    assert.equal(snapB.kind, "ready");                   // B's read survived A's error/finally
    if (snapB.kind === "ready") assert.equal(snapB.wallet.balanceFen, 222);
    assert.equal(calls, 2);
  });
});

test("reset aborts the in-flight controller and an old finally cannot clear the new request", async () => {
  __resetMyWalletSharedForTest();
  let calls = 0;
  const signals: Array<AbortSignal | undefined> = [];
  const releases: Array<(() => void) | undefined> = [];
  await withFetch((_input, init) => {
    const i = calls;
    calls += 1;
    signals[i] = init?.signal ?? undefined;
    return new Promise<Response>((res) => { releases[i] = () => res(wallet(700 + i)); });
  }, async () => {
    const pA = refreshMyWallet("A");
    __resetMyWalletSharedForTest();                      // reset seam aborts A's controller
    assert.equal(signals[0]?.aborted, true);
    const pB = refreshMyWallet("B");
    assert.equal(calls, 2);
    assert.equal(signals[1]?.aborted, false);            // B's controller is independent
    releases[0]!();                                      // A settles late after reset
    await pA.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getMyWalletSnapshotFor("B").kind, "loading"); // old finally did not clear B
    releases[1]!();
    await pB;
    const snapB = getMyWalletSnapshotFor("B");
    assert.equal(snapB.kind, "ready");
    if (snapB.kind === "ready") assert.equal(snapB.wallet.balanceFen, 701);
    assert.equal(calls, 2);
  });
});

test("independent concurrent retries coalesce and settle exactly one queued follow-up read", async () => {
  __resetMyWalletSharedForTest();
  let calls = 0;
  let fen = 100;
  const releases: Array<(() => void) | undefined> = [];
  await withFetch(() => {
    const i = calls;
    calls += 1;
    return new Promise<Response>((res) => { releases[i] = () => res(wallet(fen)); });
  }, async () => {
    const p1 = refreshMyWallet("A");
    const p2 = refreshMyWallet("A");                     // independent retry while in-flight
    assert.equal(calls, 1);                              // coalesced, no duplicate GET
    fen = 300;
    releases[0]!();
    await p1; await p2;
    assert.equal(calls, 2);                              // exactly one queued follow-up
    releases[1]!();
    for (let i = 0; i < 5 && getMyWalletSnapshotFor("A").kind !== "ready"; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const snap = getMyWalletSnapshotFor("A");
    assert.equal(snap.kind, "ready");
    if (snap.kind === "ready") assert.equal(snap.wallet.balanceFen, 300); // newest server value wins
    assert.equal(calls, 2);
  });
});
