import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  WalletApiError,
  formatWalletFen,
  getMyWallet,
  getRenewalConsent,
  getRenewalQuote,
  putRenewalConsent,
  // @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
} from "../app/lib/wallet-api.ts";

type Call = { readonly url: string; readonly init: RequestInit };

async function withFetch<Result>(
  respond: (call: Call) => { status: number; body: unknown },
  run: (calls: Call[]) => Promise<Result>,
): Promise<Result> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("wallet balance parses the frozen DTO; a real zero balance is a genuine ¥0.00", async () => {
  await withFetch(() => ({ status: 200, body: { balanceFen: 0, currency: "CNY" } }), async (calls) => {
    const wallet = await getMyWallet();
    assert.deepEqual(wallet, { balanceFen: 0, currency: "CNY" });
    assert.equal(calls[0]?.url, "/api/me/wallet");
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(calls[0]?.init.credentials, "same-origin");
  });
  assert.equal(formatWalletFen(0), "¥0.00");
  assert.equal(formatWalletFen(5), "¥0.05");
  assert.equal(formatWalletFen(123456), "¥1,234.56");
  for (const body of [{ balanceFen: -1, currency: "CNY" }, { balanceFen: 1.5, currency: "CNY" }, { balanceFen: 100, currency: "USD" }, { currency: "CNY" }]) {
    await withFetch(() => ({ status: 200, body }), async () => {
      await assert.rejects(getMyWallet(), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_response");
    });
  }
});

test("wallet errors keep the server envelope code and status", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "csrf_invalid"], [404, "not_found"], [409, "quote_unavailable"], [409, "revision_conflict"], [400, "invalid_request"], [503, "wallet_unavailable"]] as const) {
    await withFetch(() => ({ status, body: { error: { code } } }), async () => {
      await assert.rejects(getMyWallet(), (error: unknown) => error instanceof WalletApiError && error.code === code && error.status === status);
    });
  }
});

test("renewal quote and consent parse the frozen DTOs, including the never-set consent", async () => {
  const quote = { key: "renewal-quote:v1:t:r:i::month-1:5900", priceFen: 5900, currency: "CNY", durationId: "month-1", period: "MONTHLY", previousEndsAt: "2026-11-01T00:00:00.000Z", newEndsAt: "2026-12-01T00:00:00.000Z" };
  await withFetch(() => ({ status: 200, body: { quote } }), async (calls) => {
    assert.deepEqual(await getRenewalQuote(7, "MONTHLY"), quote);
    assert.equal(calls[0]?.url, "/api/me/services/7/renewal-quote?period=MONTHLY");
  });
  // Never-set consent: candidate.ts returns DISABLED / revision 0 / nulls / updatedAt "".
  await withFetch(() => ({ status: 200, body: { consent: { state: "DISABLED", revision: 0, period: null, priceFen: null, durationId: null, updatedAt: "" } } }), async (calls) => {
    assert.deepEqual(await getRenewalConsent(7), { state: "DISABLED", revision: 0, period: null, priceFen: null, durationId: null, updatedAt: null });
    assert.equal(calls[0]?.url, "/api/me/services/7/renewal-consent");
  });
  for (const body of [{ quote: { ...quote, period: "WEEKLY" } }, { quote: { ...quote, priceFen: "59" } }, { quote: { ...quote, key: "" } }, {}]) {
    await withFetch(() => ({ status: 200, body }), async () => {
      await assert.rejects(getRenewalQuote(7, "MONTHLY"), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_response");
    });
  }
});

test("consent PUT sends only {period, expectedRevision, enabled} with the session CSRF token", async () => {
  await withFetch(() => ({ status: 200, body: { revision: 4 } }), async (calls) => {
    const revision = await putRenewalConsent("c".repeat(43), 7, { period: "QUARTERLY", expectedRevision: 3, enabled: true });
    assert.equal(revision, 4);
    assert.equal(calls[0]?.url, "/api/me/services/7/renewal-consent");
    assert.equal(calls[0]?.init.method, "PUT");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["X-CSRF-Token"], "c".repeat(43));
    // No price, quote key or expiry ever leaves the browser.
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { period: "QUARTERLY", expectedRevision: 3, enabled: true });
  });
  await withFetch(() => ({ status: 409, body: { error: { code: "revision_conflict" } } }), async () => {
    await assert.rejects(
      putRenewalConsent("c".repeat(43), 7, { period: "MONTHLY", expectedRevision: 0, enabled: false }),
      (error: unknown) => error instanceof WalletApiError && error.code === "revision_conflict" && error.status === 409,
    );
  });
});

test("invalid service ids and periods never reach the network", async () => {
  await withFetch(() => ({ status: 200, body: {} }), async (calls) => {
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(getRenewalConsent(id), (error: unknown) => error instanceof WalletApiError && error.code === "not_found");
    }
    await assert.rejects(getRenewalQuote(7, "WEEKLY" as never), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_request");
    await assert.rejects(
      putRenewalConsent("c".repeat(43), 7, { period: "MONTHLY", expectedRevision: -1, enabled: true }),
      (error: unknown) => error instanceof WalletApiError && error.code === "invalid_request",
    );
    assert.equal(calls.length, 0);
  });
});

test("profile and dashboard never show a counterfeit zero while loading or after an error", () => {
  const profile = source("../app/components/profile/ProfilePage.tsx");
  const dashboard = source("../app/components/dashboard/BuyerDashboardOverview.tsx");
  const hook = source("../app/lib/useWallet.ts");
  assert.match(profile, /state\.kind === "ready" && <span className="cc-profile-wallet-amount">\{formatWalletFen\(state\.wallet\.balanceFen\)\}<\/span>/);
  assert.match(profile, /state\.kind === "loading" && <span className="cc-profile-wallet-muted">\{copy\.loading\}<\/span>/);
  assert.match(dashboard, /value: wallet\.state\.kind === "ready" \? formatWalletFen\(wallet\.state\.wallet\.balanceFen\) : "—",/);
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  // Header: only signed-in sessions read the wallet; non-ready states show "—", never ¥0.00.
  assert.match(shell, /\{authStatus === "authenticated" && <HeaderWalletChip \/>\}/);
  assert.match(shell, /<b>\{ready \? formatWalletFen\(state\.wallet\.balanceFen\) : "—"\}<\/b>/);
  assert.doesNotMatch(shell, /balancePending/);
  for (const file of [profile, dashboard, hook, shell]) {
    assert.doesNotMatch(file, /balanceFen \?\? 0|balanceFen: 0|formatWalletFen\(0\)/);
  }
});
