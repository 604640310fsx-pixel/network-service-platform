import type { DatabaseConnection } from "../db.js";
import { findSellablePlan } from "../payment/commerce.js";
import { addUtcMonths, parseEndsAt } from "../payment/admin-services.js";
import { CATALOG_VERSION } from "../payment/pricing.js";

/** Internal candidate only: callers must supply authenticated Session/CSRF/admin facts. */
export class WalletError extends Error {
  constructor(readonly code: string) { super(code); }
}
type Row = Record<string, unknown>;
function one(db: DatabaseConnection, sql: string, ...args: unknown[]): Row | null {
  const rows = db.prepare(sql).all(...args);
  if (rows.length > 1) throw new WalletError("INVARIANT_FAILED");
  return (rows[0] as Row | undefined) ?? null;
}
function integer(value: unknown, code = "INVARIANT_FAILED"): number {
  if (!Number.isSafeInteger(value)) throw new WalletError(code);
  return value as number;
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WalletError("INVALID_AMOUNT");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new WalletError("INVARIANT_FAILED");
  return value;
}
function timestamp(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new WalletError("INVALID_TIME");
  }
  return value;
}
function write<Result>(db: DatabaseConnection, fn: () => Result): Result {
  if (db.inTransaction) throw new WalletError("TRANSACTION_BOUNDARY_REQUIRED");
  return db.transaction(fn).immediate();
}
function ensureAccount(db: DatabaseConnection, userId: number): void {
  db.prepare("INSERT OR IGNORE INTO wallet_accounts (user_id,balance_fen) VALUES (?,0)").run(userId);
}
function balanceInTransaction(db: DatabaseConnection, userId: number): number {
  const row = one(db, "SELECT balance_fen FROM wallet_accounts WHERE user_id=?", userId);
  return row === null ? 0 : integer(row.balance_fen);
}
/** A missing genuine account is zero; any SQL/invariant error propagates as UNKNOWN. */
export function walletBalance(db: DatabaseConnection, userId: number): number {
  integer(userId, "INVALID_USER");
  return balanceInTransaction(db, userId);
}
function ledger(db: DatabaseConnection, userId: number, kind: string, amountFen: number, sourceKey: string, at: string): void {
  db.prepare("INSERT INTO wallet_ledger (user_id,kind,amount_fen,source_key,created_at) VALUES (?,?,?,?,?)")
    .run(userId, kind, amountFen, sourceKey, timestamp(at));
}
function recordConsentHistory(db: DatabaseConnection, serviceId: number, at: string): void {
  db.prepare(`INSERT INTO wallet_consent_history
    (service_id,revision,user_id,state,quote_key,price_fen,duration_id,next_billing_period,created_at)
    SELECT service_id,revision,user_id,state,quote_key,price_fen,duration_id,next_billing_period,?
    FROM wallet_consents WHERE service_id=?`).run(timestamp(at), serviceId);
}

export interface VerifiedTopup {
  readonly orderRef: string; readonly providerTradeNo: string; readonly merchantId: string;
  readonly amountFen: number; readonly currency: "CNY"; readonly finalStatus: "SUCCESS";
  readonly signatureVerified: true;
}
/** Local intent only. It creates no provider request and moves no funds. */
export function createTopupIntent(db: DatabaseConnection, actor: InternalActor, orderRef: string, amountFen: number): "CREATED" | "REPLAY" {
  return write(db, () => {
    authorize(actor);
    positive(amountFen);
    if (!orderRef) throw new WalletError("INVALID_ORDER_REF");
    const old = one(db, "SELECT user_id,amount_fen,currency FROM wallet_topups WHERE order_ref=?", orderRef);
    if (old) {
      if (old.user_id !== actor.userId || old.amount_fen !== amountFen || old.currency !== "CNY") throw new WalletError("TOPUP_MISMATCH");
      return "REPLAY";
    }
    db.prepare("INSERT INTO wallet_topups(user_id,order_ref,amount_fen,currency) VALUES (?,?,?,'CNY')")
      .run(actor.userId, orderRef, amountFen);
    return "CREATED";
  });
}
/** Raw notifications and browser returns must never call this without internal verification. */
export function creditVerifiedTopup(db: DatabaseConnection, expectedMerchantId: string, event: VerifiedTopup, at: string): "CREDITED" | "REPLAY" {
  return write(db, () => {
    if (event.signatureVerified !== true || event.finalStatus !== "SUCCESS" || event.currency !== "CNY" || event.merchantId !== expectedMerchantId || !event.providerTradeNo) {
      throw new WalletError("VERIFICATION_REQUIRED");
    }
    const topup = one(db, "SELECT user_id,amount_fen,currency,provider_trade_no,credited_at FROM wallet_topups WHERE order_ref=?", event.orderRef);
    if (!topup || integer(topup.amount_fen) !== positive(event.amountFen) || topup.currency !== event.currency) throw new WalletError("TOPUP_MISMATCH");
    if (topup.credited_at !== null) {
      if (topup.provider_trade_no !== event.providerTradeNo) throw new WalletError("TRADE_CONFLICT");
      return "REPLAY";
    }
    if (topup.provider_trade_no !== null && topup.provider_trade_no !== event.providerTradeNo) throw new WalletError("TRADE_CONFLICT");
    const userId = integer(topup.user_id);
    ensureAccount(db, userId);
    const next = balanceInTransaction(db, userId) + event.amountFen;
    if (!Number.isSafeInteger(next)) throw new WalletError("BALANCE_OVERFLOW");
    db.prepare("UPDATE wallet_topups SET provider_trade_no=?,credited_at=? WHERE order_ref=? AND credited_at IS NULL")
      .run(event.providerTradeNo, timestamp(at), event.orderRef);
    db.prepare("UPDATE wallet_accounts SET balance_fen=? WHERE user_id=?").run(next, userId);
    ledger(db, userId, "TOPUP", event.amountFen, `topup:${event.orderRef}`, at);
    return "CREDITED";
  });
}

export type BillingPeriod = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
export interface AuthoritativeQuote {
  readonly key: string; readonly serviceId: number; readonly ownerId: number;
  readonly priceFen: number; readonly durationId: string; readonly period: BillingPeriod;
  readonly previousEndsAt: string; readonly newEndsAt: string;
}
export interface ServiceEligibility {
  readonly serviceId: number; readonly ownerId: number | null; readonly purchased: boolean;
  readonly endsAt: string | null;
}
/** Existing paid order is the ownership source. An admin grant cannot satisfy this join. */
export function purchasedService(db: DatabaseConnection, serviceId: number): ServiceEligibility {
  const row = one(db, `SELECT s.id AS service_id,s.ends_at,o.user_id
    FROM services s JOIN payments p ON p.id=s.payment_id
    JOIN orders o ON o.id=p.order_id
    WHERE s.id=? AND s.status='open' AND p.status='paid' AND o.status='paid'`, serviceId);
  if (!row) return { serviceId, ownerId: null, purchased: false, endsAt: null };
  // Normalize through the same strict-instant helper the quote uses, so a stored
  // `ends_at` in any accepted ISO shape equals the quote's previousEndsAt.
  const ends = row.ends_at === null ? null : parseEndsAt(row.ends_at);
  const endsAt = ends === null || !ends.ok ? null : ends.value;
  return { serviceId: integer(row.service_id), ownerId: row.user_id === null ? null : integer(row.user_id),
    purchased: true, endsAt };
}
function assertLiveService(db: DatabaseConnection, supplied: ServiceEligibility): void {
  const live = purchasedService(db, supplied.serviceId);
  if (!live.purchased || live.ownerId !== supplied.ownerId || live.endsAt !== supplied.endsAt || supplied.purchased !== true) {
    throw new WalletError("QUOTE_UNAVAILABLE");
  }
}
/** Billing period → catalog duration_id. Same `month-N` convention the admin panel
    already parses; an id that is absent/inactive in sellable_plans still fails closed. */
const PERIOD_DURATION_ID: Readonly<Record<BillingPeriod, string>> = {
  MONTHLY: "month-1", QUARTERLY: "month-3", SEMIANNUAL: "month-6", ANNUAL: "month-12",
};
/** Server-side renewal quote. Derives everything from the owned paid service's order
    tuple + the live sellable_plans row — caller/browser-supplied price, key or expiry
    is never consulted. Any missing/inactive/ambiguous source fails QUOTE_UNAVAILABLE. */
export function produceRenewalQuote(db: DatabaseConnection, serviceId: number, period: BillingPeriod, actorUserId: number): AuthoritativeQuote {
  const row = one(db, `SELECT s.ends_at,o.user_id,o.type_id,o.region_id,o.isp_id,o.spec_id
    FROM services s JOIN payments p ON p.id=s.payment_id
    JOIN orders o ON o.id=p.order_id
    WHERE s.id=? AND s.status='open' AND p.status='paid' AND o.status='paid'`, serviceId);
  if (!row || row.user_id === null) throw new WalletError("QUOTE_UNAVAILABLE");
  if (integer(row.user_id) !== actorUserId) throw new WalletError("FORBIDDEN");
  const endsAt = parseEndsAt(row.ends_at);
  if (!endsAt.ok || endsAt.value === null) throw new WalletError("QUOTE_UNAVAILABLE");
  const field = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0) throw new WalletError("QUOTE_UNAVAILABLE");
    return value;
  };
  const typeId = field(row.type_id), regionId = field(row.region_id), ispId = field(row.isp_id);
  const specId = row.spec_id === null ? null : field(row.spec_id);
  /* Consent TERMS key: current catalog version + full tuple + CNY price + period
     duration. Expiry is deliberately NOT bound — terms identical across successive
     periods need no reconsent; the cycle snapshot (previousEndsAt/newEndsAt) is
     protected by UNIQUE(service_id,previous_ends_at) and the in-transaction re-read.
     The live constant is bound, never the order's purchase-time stamp. */
  const catalogVersion = field(CATALOG_VERSION);
  const durationId = PERIOD_DURATION_ID[period];
  const months = /^month-(\d+)$/.exec(durationId);
  if (months === null) throw new WalletError("QUOTE_UNAVAILABLE");
  let plan;
  try {
    plan = findSellablePlan(db, { typeId, regionId, ispId, specId, durationId });
  } catch {
    throw new WalletError("QUOTE_UNAVAILABLE");
  }
  if (plan === null || !plan.isActive) throw new WalletError("QUOTE_UNAVAILABLE");
  const previousEndsAt = endsAt.value;
  const newEndsAt = addUtcMonths(previousEndsAt, Number(months[1]));
  return {
    key: `renewal-quote:${catalogVersion}:${typeId}:${regionId}:${ispId}:${specId ?? ""}:${durationId}:${plan.priceFen}`,
    serviceId, ownerId: integer(row.user_id), priceFen: plan.priceFen, durationId, period,
    previousEndsAt, newEndsAt,
  };
}
function validQuote(quote: AuthoritativeQuote | null, service: ServiceEligibility, period: BillingPeriod): quote is AuthoritativeQuote {
  return !!quote && !!quote.key && !!quote.durationId && quote.serviceId === service.serviceId &&
    quote.ownerId === service.ownerId && quote.period === period && quote.priceFen > 0 &&
    Number.isSafeInteger(quote.priceFen) && quote.previousEndsAt === service.endsAt &&
    Number.isFinite(Date.parse(quote.newEndsAt)) && Date.parse(quote.newEndsAt) > Date.parse(quote.previousEndsAt);
}
function eligible(service: ServiceEligibility): void {
  if (!service.purchased || service.ownerId === null || !service.endsAt || !Number.isFinite(Date.parse(service.endsAt))) {
    throw new WalletError("QUOTE_UNAVAILABLE");
  }
}
export function setRenewalConsent(db: DatabaseConnection, serviceId: number, actorUserId: number,
  period: BillingPeriod, expectedRevision: number, enabled: boolean, at: string): number {
  return write(db, () => {
    const old = one(db, "SELECT revision,user_id FROM wallet_consents WHERE service_id=?", serviceId);
    if (old && old.user_id !== actorUserId) throw new WalletError("FORBIDDEN");
    /* Enabling binds the server-produced quote inside this same transaction (owned
       open paid service, finite expiry, live active plan); no caller price/key/expiry
       is ever stored. Disabling needs only the real current owner + revision and works
       even when the catalog is unavailable. */
    const fresh = enabled ? produceRenewalQuote(db, serviceId, period, actorUserId) : null;
    if (!enabled && old === null && purchasedService(db, serviceId).ownerId !== actorUserId) {
      throw new WalletError("FORBIDDEN");
    }
    const revision = old ? integer(old.revision) : 0;
    if (revision !== expectedRevision) throw new WalletError("REVISION_CONFLICT");
    const next = revision + 1;
    db.prepare(`INSERT INTO wallet_consents (service_id,user_id,state,revision,quote_key,price_fen,duration_id,next_billing_period,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(service_id) DO UPDATE SET
      state=excluded.state,revision=excluded.revision,quote_key=excluded.quote_key,price_fen=excluded.price_fen,
      duration_id=excluded.duration_id,next_billing_period=excluded.next_billing_period,updated_at=excluded.updated_at`)
      .run(serviceId, actorUserId, enabled ? "ENABLED" : "DISABLED", next,
        fresh ? fresh.key : null, fresh ? fresh.priceFen : null, fresh ? fresh.durationId : null, period, timestamp(at));
    recordConsentHistory(db, serviceId, at);
    return next;
  });
}
/** Current consent snapshot for an owned service; null when the caller does not own
    it or no consent row exists. */
export function readRenewalConsent(db: DatabaseConnection, serviceId: number, actorUserId: number):
  { readonly state: string; readonly revision: number; readonly period: string | null;
    readonly priceFen: number | null; readonly durationId: string | null; readonly updatedAt: string } | null {
  const owner = one(db, `SELECT o.user_id FROM services s
    JOIN payments p ON p.id=s.payment_id JOIN orders o ON o.id=p.order_id WHERE s.id=?`, serviceId);
  if (!owner || owner.user_id === null || integer(owner.user_id) !== actorUserId) return null;
  const row = one(db, `SELECT state,revision,next_billing_period,price_fen,duration_id,updated_at
    FROM wallet_consents WHERE service_id=?`, serviceId);
  if (!row) return { state: "DISABLED", revision: 0, period: null, priceFen: null, durationId: null, updatedAt: "" };
  return {
    state: text(row.state), revision: integer(row.revision),
    period: row.next_billing_period === null ? null : text(row.next_billing_period),
    priceFen: row.price_fen === null ? null : integer(row.price_fen),
    durationId: row.duration_id === null ? null : text(row.duration_id),
    updatedAt: text(row.updated_at),
  };
}
export function changeNextBillingPeriod(db: DatabaseConnection, serviceId: number, ownerId: number, period: BillingPeriod,
  expectedRevision: number, at: string): number {
  return write(db, () => {
    const old = one(db, "SELECT user_id,state,revision FROM wallet_consents WHERE service_id=?", serviceId);
    if (!old || old.user_id !== ownerId) throw new WalletError("FORBIDDEN");
    if (old.revision !== expectedRevision) throw new WalletError("REVISION_CONFLICT");
    db.prepare("UPDATE wallet_consents SET state=?,revision=?,next_billing_period=?,updated_at=? WHERE service_id=?")
      .run(old.state === "DISABLED" ? "DISABLED" : "RECONSENT_REQUIRED", expectedRevision + 1, period, timestamp(at), serviceId);
    recordConsentHistory(db, serviceId, at);
    return expectedRevision + 1;
  });
}
export function renewalDryRun(db: DatabaseConnection, service: ServiceEligibility, quote: AuthoritativeQuote | null): "READY" | "DISABLED" | "RECONSENT_REQUIRED" | "QUOTE_UNAVAILABLE" {
  try { assertLiveService(db, service); eligible(service); }
  catch (error) {
    if (error instanceof WalletError && error.code === "QUOTE_UNAVAILABLE") return "QUOTE_UNAVAILABLE";
    throw error;
  }
  const consent = one(db, "SELECT * FROM wallet_consents WHERE service_id=?", service.serviceId);
  if (!consent || consent.state === "DISABLED") return "DISABLED";
  if (consent.state === "RECONSENT_REQUIRED") return "RECONSENT_REQUIRED";
  if (!validQuote(quote, service, consent.next_billing_period as BillingPeriod)) return "QUOTE_UNAVAILABLE";
  if (consent.quote_key !== quote.key || consent.price_fen !== quote.priceFen || consent.duration_id !== quote.durationId) return "RECONSENT_REQUIRED";
  return "READY";
}
/** Fixture-only modeled extension. There is no production scheduler or external service action. */
export function runRenewalFixture(db: DatabaseConnection, mode: "TEST_ONLY", service: ServiceEligibility, quote: AuthoritativeQuote | null,
  expectedRevision: number, at: string): "COMMITTED" | "DUPLICATE" | "RECONSENT_REQUIRED" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    assertLiveService(db, service);
    eligible(service);
    const consent = one(db, "SELECT revision,state,next_billing_period FROM wallet_consents WHERE service_id=?", service.serviceId);
    if (!consent || consent.revision !== expectedRevision) throw new WalletError("REVISION_CONFLICT");
    const cycle = one(db, "SELECT id FROM wallet_renewal_cycles WHERE service_id=? AND previous_ends_at=?", service.serviceId, service.endsAt);
    if (cycle) return "DUPLICATE";
    /* Re-derive the authoritative quote inside the deduction transaction and consume
       its fields for the debit/cycle/extension: a re-priced or deactivated plan,
       moved expiry or tuple change since consent invalidates the bound key, and a
       caller object carrying a genuine key but hostile amounts/expiry is never
       consumed — only the produced fields reach the ledger. */
    let fresh: AuthoritativeQuote | null = null;
    try {
      fresh = produceRenewalQuote(db, service.serviceId, consent.next_billing_period as BillingPeriod, service.ownerId!);
    } catch (error) {
      if (!(error instanceof WalletError && error.code === "QUOTE_UNAVAILABLE")) throw error;
    }
    let state = renewalDryRun(db, service, quote);
    if (state === "READY" && (fresh === null || !quote || fresh.key !== quote.key)) {
      state = fresh === null ? "QUOTE_UNAVAILABLE" : "RECONSENT_REQUIRED";
    }
    if (state === "RECONSENT_REQUIRED") {
      if (consent.state === "ENABLED") {
        db.prepare("UPDATE wallet_consents SET state='RECONSENT_REQUIRED',revision=revision+1,updated_at=? WHERE service_id=?")
          .run(timestamp(at), service.serviceId);
        recordConsentHistory(db, service.serviceId, at);
      }
      return "RECONSENT_REQUIRED";
    }
    if (state !== "READY" || !quote || !fresh) throw new WalletError(state);
    const account = one(db, "SELECT balance_fen FROM wallet_accounts WHERE user_id=?", service.ownerId);
    if (!account || integer(account.balance_fen) < fresh.priceFen) throw new WalletError("INSUFFICIENT_FUNDS");
    db.prepare("UPDATE wallet_accounts SET balance_fen=balance_fen-? WHERE user_id=? AND balance_fen>=?")
      .run(fresh.priceFen, service.ownerId, fresh.priceFen);
    db.prepare(`INSERT INTO wallet_renewal_cycles (service_id,previous_ends_at,new_ends_at,user_id,amount_fen,quote_key,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(service.serviceId, timestamp(fresh.previousEndsAt), timestamp(fresh.newEndsAt),
      service.ownerId, fresh.priceFen, fresh.key, timestamp(at));
    ledger(db, service.ownerId!, "RENEWAL_DEBIT", -fresh.priceFen, `cycle:${service.serviceId}:${service.endsAt}`, at);
    db.prepare(`INSERT INTO wallet_service_extensions(service_id,modeled_ends_at) VALUES (?,?)
      ON CONFLICT(service_id) DO UPDATE SET modeled_ends_at=excluded.modeled_ends_at`).run(service.serviceId, fresh.newEndsAt);
    return "COMMITTED";
  });
}

export interface InternalActor { readonly userId: number; readonly sessionValid: boolean; readonly csrfValid: boolean; readonly isAdmin: boolean; }
function authorize(actor: InternalActor): void {
  if (!actor.sessionValid || !actor.csrfValid || !Number.isSafeInteger(actor.userId)) throw new WalletError("UNAUTHORIZED");
}
export interface ManagedOrder { readonly id: number; readonly ownerId: number | null; readonly status: "pending" | "paid" | "closed";
  readonly paymentStatus: "pending" | "paid" | "closed"; readonly confirmed: boolean; }
/** Hooks must perform SQL on the supplied connection only; no network or external side effects. */
export function cancelPendingOrder(db: DatabaseConnection, actor: InternalActor, orderId: number, at: string,
  loadCurrentOrder: (database: DatabaseConnection, orderId: number) => ManagedOrder | null,
  releaseOnce: (database: DatabaseConnection, order: ManagedOrder, kind: "inventory" | "coupon") => void): "CANCELLED" | "ALREADY_CANCELLED" {
  return write(db, () => {
    authorize(actor);
    const order = loadCurrentOrder(db, orderId);
    if (!order || order.id !== orderId) throw new WalletError("ORDER_UNAVAILABLE");
    if (!actor.isAdmin && order.ownerId !== actor.userId) throw new WalletError("FORBIDDEN");
    const old = one(db, "SELECT order_id FROM wallet_order_closures WHERE order_id=?", orderId);
    if (old) return "ALREADY_CANCELLED";
    if (order.status !== "pending" || order.paymentStatus !== "pending" || order.confirmed ||
      one(db, "SELECT order_id FROM wallet_order_settlements WHERE order_id=?", order.id)) throw new WalletError("NOT_CANCELLABLE");
    db.prepare("INSERT INTO wallet_order_closures(order_id,closed_by_user_id,closed_at,inventory_released,coupon_released) VALUES (?,?,?,?,?)")
      .run(order.id, actor.userId, timestamp(at), 0, 0);
    releaseOnce(db, order, "inventory");
    db.prepare("UPDATE wallet_order_closures SET inventory_released=1 WHERE order_id=?").run(order.id);
    releaseOnce(db, order, "coupon");
    db.prepare("UPDATE wallet_order_closures SET coupon_released=1 WHERE order_id=?").run(order.id);
    return "CANCELLED";
  });
}
export function assertOrderOpenForAction(db: DatabaseConnection, orderId: number): void {
  if (one(db, "SELECT order_id FROM wallet_order_closures WHERE order_id=?", orderId)) throw new WalletError("MANAGEMENT_CLOSED");
}
export interface VerifiedOrderPayment {
  readonly orderId: number; readonly providerTradeNo: string; readonly amountFen: number;
  readonly merchantId: string; readonly currency: "CNY"; readonly finalStatus: "SUCCESS";
  readonly signatureVerified: true;
}
/** Only an internally verified event; fulfill hook is SQL-only on this connection. */
export function recordVerifiedOrderPayment(db: DatabaseConnection, expectedMerchantId: string, event: VerifiedOrderPayment,
  at: string, fulfill: (database: DatabaseConnection, orderId: number) => void): "PAID" | "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" | "REPLAY" {
  return write(db, () => {
    const { orderId, providerTradeNo: tradeNo, amountFen } = event;
    positive(amountFen);
    if (event.signatureVerified !== true || event.finalStatus !== "SUCCESS" || event.currency !== "CNY" ||
      event.merchantId !== expectedMerchantId || !tradeNo) throw new WalletError("VERIFICATION_REQUIRED");
    const payment = one(db, `SELECT p.amount_fen,p.currency,p.status AS payment_status,p.trade_no,
      o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.order_id=?`, orderId);
    if (!payment || payment.amount_fen !== amountFen || payment.currency !== event.currency) throw new WalletError("PAYMENT_MISMATCH");
    const existing = one(db, "SELECT provider_trade_no,amount_fen FROM wallet_order_settlements WHERE order_id=?", orderId);
    if (existing) {
      if (existing.provider_trade_no !== tradeNo || existing.amount_fen !== amountFen) throw new WalletError("TRADE_CONFLICT");
      return "REPLAY";
    }
    const closed = one(db, "SELECT order_id FROM wallet_order_closures WHERE order_id=?", orderId) !== null;
    const orderStatus = payment.order_status;
    const paymentStatus = payment.payment_status;
    if ((orderStatus !== "pending" && orderStatus !== "paid" && orderStatus !== "closed") ||
      (paymentStatus !== "pending" && paymentStatus !== "paid" && paymentStatus !== "closed")) {
      throw new WalletError("INVARIANT_FAILED");
    }
    if (orderStatus === "paid" && paymentStatus === "paid") {
      if (payment.trade_no !== tradeNo) throw new WalletError("PAYMENT_STATE_CONFLICT");
      db.prepare("INSERT INTO wallet_order_settlements(order_id,provider_trade_no,amount_fen,state,recorded_at) VALUES (?,?,?,?,?)")
        .run(orderId, tradeNo, amountFen, closed ? "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" : "PAID", timestamp(at));
      return closed ? "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" : "REPLAY";
    }
    const locallyClosed = closed || orderStatus === "closed" || paymentStatus === "closed";
    if (!locallyClosed && (orderStatus !== "pending" || paymentStatus !== "pending")) throw new WalletError("PAYMENT_STATE_CONFLICT");
    const state = locallyClosed ? "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" : "PAID";
    db.prepare("INSERT INTO wallet_order_settlements(order_id,provider_trade_no,amount_fen,state,recorded_at) VALUES (?,?,?,?,?)")
      .run(orderId, tradeNo, amountFen, state, timestamp(at));
    if (!locallyClosed) fulfill(db, orderId);
    return state;
  });
}

export function requestPaidServiceTermination(db: DatabaseConnection, actor: InternalActor, serviceId: number,
  sourceKind: "ORIGINAL_PAYMENT" | "WALLET_RENEWAL", sourceId: number, at: string): void {
  write(db, () => {
    authorize(actor);
    if (!actor.isAdmin) throw new WalletError("FORBIDDEN");
    const service = purchasedService(db, serviceId);
    if (!service.purchased) throw new WalletError("SOURCE_UNAVAILABLE");
    if (sourceKind === "ORIGINAL_PAYMENT") {
      const payment = one(db, "SELECT payment_id FROM services WHERE id=?", serviceId);
      if (!payment || payment.payment_id !== sourceId) throw new WalletError("SOURCE_UNAVAILABLE");
    } else {
      const cycle = one(db, "SELECT id FROM wallet_renewal_cycles WHERE id=? AND service_id=?", sourceId, serviceId);
      if (!cycle) throw new WalletError("SOURCE_UNAVAILABLE");
    }
    const prior = one(db, "SELECT service_id FROM wallet_termination_cases WHERE service_id=?", serviceId);
    if (!prior) {
      db.prepare(`INSERT INTO wallet_termination_cases(service_id,requested_at,requested_by,stop_state)
        VALUES (?,?,?,'REQUESTED')`).run(serviceId, timestamp(at), actor.userId);
      db.prepare("UPDATE wallet_consents SET state='DISABLED',revision=revision+1,updated_at=? WHERE service_id=?")
        .run(at, serviceId);
      if (one(db, "SELECT revision FROM wallet_consents WHERE service_id=?", serviceId)) recordConsentHistory(db, serviceId, at);
    }
    const refundCase = one(db, "SELECT service_id FROM wallet_refund_cases WHERE source_kind=? AND source_id=?", sourceKind, sourceId);
    if (refundCase) {
      if (refundCase.service_id !== serviceId) throw new WalletError("SOURCE_CONFLICT");
      return;
    }
    db.prepare(`INSERT INTO wallet_refund_cases(service_id,refund_state,source_kind,source_id)
      VALUES (?,'AWAITING_POLICY',?,?)`).run(serviceId, sourceKind, sourceId);
  });
}
/** Isolated accounting fixture. No policy decision or real funds transfer is inferred. */
export function recordWalletReversalFixture(db: DatabaseConnection, mode: "TEST_ONLY", actor: InternalActor,
  cycleId: number, refundKey: string, amountFen: number, authorizedAmountFen: number, at: string): "RECORDED" | "REPLAY" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    authorize(actor);
    if (!actor.isAdmin) throw new WalletError("FORBIDDEN");
    positive(amountFen);
    if (!refundKey || !Number.isSafeInteger(authorizedAmountFen) || authorizedAmountFen < amountFen) throw new WalletError("POLICY_REQUIRED");
    const cycle = one(db, "SELECT user_id,amount_fen FROM wallet_renewal_cycles WHERE id=?", cycleId);
    if (!cycle) throw new WalletError("SOURCE_UNAVAILABLE");
    const refundCase = one(db, `SELECT service_id FROM wallet_refund_cases
      WHERE source_kind='WALLET_RENEWAL' AND source_id=? AND refund_state='PROCESSING'`, cycleId);
    if (!refundCase) throw new WalletError("REFUND_NOT_PROCESSING");
    const existing = one(db, "SELECT cycle_id,amount_fen FROM wallet_refund_reversals WHERE refund_key=?", refundKey);
    if (existing) {
      if (existing.cycle_id !== cycleId || existing.amount_fen !== amountFen) throw new WalletError("REFUND_CONFLICT");
      return "REPLAY";
    }
    const paid = integer(cycle.amount_fen);
    const total = one(db, "SELECT COALESCE(SUM(amount_fen),0) AS total FROM wallet_refund_reversals WHERE cycle_id=?", cycleId);
    if (integer(total!.total) + amountFen > Math.min(paid, authorizedAmountFen)) throw new WalletError("REFUND_EXCEEDS_PAID");
    const userId = integer(cycle.user_id);
    ensureAccount(db, userId);
    const next = balanceInTransaction(db, userId) + amountFen;
    if (!Number.isSafeInteger(next)) throw new WalletError("BALANCE_OVERFLOW");
    db.prepare("INSERT INTO wallet_refund_reversals(refund_key,cycle_id,amount_fen,created_at) VALUES (?,?,?,?)")
      .run(refundKey, cycleId, amountFen, timestamp(at));
    db.prepare("UPDATE wallet_accounts SET balance_fen=? WHERE user_id=?").run(next, userId);
    ledger(db, userId, "REFUND_REVERSAL", amountFen, `reversal:${refundKey}`, at);
    return "RECORDED";
  });
}
