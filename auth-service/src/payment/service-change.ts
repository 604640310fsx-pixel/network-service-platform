import { createHash, randomUUID } from "node:crypto";

import type { DatabaseConnection } from "../db.js";
import { findSellablePlan, PaymentDomainError, type PlanSelection } from "./commerce.js";
import { createStoredOrder, paymentResponse, type OrderServiceDependencies } from "./orders.js";

type DbRow = Record<string, unknown>;
type ChangeKind = "upgrade" | "downgrade";

function one(database: DatabaseConnection, sql: string, ...args: readonly unknown[]): DbRow | null {
  const rows = database.prepare(sql).all(...args);
  if (rows.length > 1) throw new Error("Service change database invariant failed");
  if (rows.length === 0) return null;
  if (typeof rows[0] !== "object" || rows[0] === null) throw new Error("Service change database invariant failed");
  return rows[0] as DbRow;
}

function number(row: DbRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Service change database invariant failed");
  return value;
}

function string(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("Service change database invariant failed");
  return value;
}

function instant(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new PaymentDomainError(409, "service_not_quotable");
  }
  return date;
}

// Calendar anniversary, clamped at month end (Jan 31 -> Feb 28/29).
export function addCalendarMonths(start: Date, months: number): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const first = new Date(Date.UTC(year, month, 1, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return first;
}

function discount(months: number): readonly [number, number] | null {
  if (months === 1) return [1, 1];
  if (months === 6) return [85, 100];
  if (months === 12) return [74, 100];
  return null;
}

export function proratedUpgradeFen(
  deltaMonthlyFen: number,
  months: number,
  discountNumerator: number,
  discountDenominator: number,
  remainingMs: number,
  totalMs: number,
): number {
  if (!Number.isSafeInteger(deltaMonthlyFen) || deltaMonthlyFen <= 0 ||
      !Number.isSafeInteger(remainingMs) || remainingMs <= 0 ||
      !Number.isSafeInteger(totalMs) || totalMs < remainingMs ||
      discount(months)?.[0] !== discountNumerator || discount(months)?.[1] !== discountDenominator) {
    throw new PaymentDomainError(409, "service_not_quotable");
  }
  const numerator = BigInt(deltaMonthlyFen) * BigInt(months) * BigInt(discountNumerator) * BigInt(remainingMs);
  const denominator = BigInt(discountDenominator) * BigInt(totalMs);
  const rounded = (numerator * 2n + denominator) / (2n * denominator);
  if (rounded <= 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PaymentDomainError(409, "service_not_quotable");
  }
  return Number(rounded);
}

function quotaGb(specId: string | null, typeId: string): number | null {
  if (specId === null && typeId === "local-isp") return 200;
  if (specId?.endsWith("-200g")) return 200;
  if (specId?.endsWith("-500g")) return 500;
  if (specId?.endsWith("-1t")) return 1000;
  return null;
}

function lineRank(typeId: string, specId: string | null): number | null {
  const lineId = specId === null && typeId === "local-isp" ? "ordinary" :
    specId?.replace(/-(200g|500g|1t)$/, "");
  const lines = typeId === "local-isp" ? ["ordinary", "half", "high", "live"] :
    typeId === "pure-native-ip" ? ["ordinary", "half", "high", "three-net"] : [];
  const index = lines.indexOf(lineId ?? "");
  return index < 0 ? null : index;
}

const ENTITLEMENT_SQL = `SELECT e.*, s.status AS service_status,
  sp.type_id, sp.region_id, sp.isp_id, sp.spec_id, o.duration_id,s.ends_at,
  p.status AS payment_status,o.status AS order_status,
  o.user_id AS original_user_id,o.type_id AS original_type_id,
  o.region_id AS original_region_id,o.isp_id AS original_isp_id
  FROM service_entitlements e
  JOIN sellable_plans sp ON sp.id = e.plan_id
  JOIN services s ON s.id = e.service_id
  JOIN payments p ON p.id = s.payment_id
  JOIN orders o ON o.id = p.order_id
  WHERE e.service_id = ? AND e.user_id = ?`;

function boundEntitlement(database: DatabaseConnection, serviceId: number, userId: number): DbRow {
  const row = one(database, ENTITLEMENT_SQL, serviceId, userId);
  if (row === null) throw new PaymentDomainError(404, "service_not_found");
  const start = instant(string(row, "period_start"));
  const end = instant(string(row, "period_end"));
  const usageStart = instant(string(row, "usage_start"));
  const usageEnd = instant(string(row, "usage_end"));
  const months = number(row, "period_months");
  const standard = discount(months);
  const monthlyWindowIsAnchored = standard !== null && Array.from({length:months},(_,index) => index).some((index) =>
    addCalendarMonths(start,index).getTime() === usageStart.getTime() &&
    addCalendarMonths(start,index+1).getTime() === usageEnd.getTime());
  const managementClosed = one(database, `SELECT service_id FROM wallet_termination_cases WHERE service_id=?`, serviceId) !== null ||
    one(database, `SELECT oc.order_id FROM wallet_order_closures oc JOIN payments p ON p.order_id=oc.order_id
      JOIN services s ON s.payment_id=p.id WHERE s.id=?`, serviceId) !== null;
  if (row.service_status !== "open" || row.payment_status !== "paid" || row.order_status !== "paid" ||
      row.original_user_id !== userId || managementClosed ||
      row.type_id !== row.original_type_id || row.region_id !== row.original_region_id || row.isp_id !== row.original_isp_id ||
      typeof row.ends_at !== "string" || instant(row.ends_at).getTime() !== end.getTime() ||
      (row.type_id !== "local-isp" && row.type_id !== "pure-native-ip") ||
      row.duration_id !== `month-${months}` || standard === null ||
      number(row, "discount_numerator") !== standard[0] ||
      number(row, "discount_denominator") !== standard[1] ||
      addCalendarMonths(start, months).getTime() !== end.getTime() ||
      !monthlyWindowIsAnchored ||
      usageStart < start || usageStart >= end ||
      number(row, "usage_used_gb") < 0 || number(row, "usage_quota_gb") <= 0 ||
      typeof row.provider_binding_ref !== "string" || row.provider_binding_ref.length === 0 ||
      (row.binding_provenance !== "synthetic" && row.binding_provenance !== "verified_opening")) {
    throw new PaymentDomainError(409, "service_not_quotable");
  }
  const currentPlan = one(database, "SELECT type_id, region_id, isp_id, spec_id, duration_id FROM sellable_plans WHERE id = ?", number(row, "plan_id"));
  const currentMonthly = one(database, "SELECT type_id, region_id, isp_id, spec_id, duration_id FROM sellable_plans WHERE id = ?", number(row, "monthly_plan_id"));
  if (currentPlan === null || currentMonthly === null ||
      currentPlan.type_id !== row.type_id || currentPlan.region_id !== row.region_id || currentPlan.isp_id !== row.isp_id ||
      currentPlan.spec_id !== row.spec_id || currentPlan.duration_id !== row.duration_id ||
      currentMonthly.type_id !== row.type_id || currentMonthly.region_id !== row.region_id || currentMonthly.isp_id !== row.isp_id ||
      currentMonthly.spec_id !== row.spec_id || currentMonthly.duration_id !== "month-1" ||
      number(row, "usage_quota_gb") !== quotaGb(row.spec_id as string | null, string(row, "type_id"))) {
    throw new PaymentDomainError(409, "service_not_quotable");
  }
  return row;
}

function entitlement(database: DatabaseConnection, serviceId: number, userId: number, now: Date): DbRow {
  const row = boundEntitlement(database,serviceId,userId);
  if (!Number.isFinite(now.getTime()) || now < instant(string(row,"period_start")) ||
      now >= instant(string(row,"period_end")) || now < instant(string(row,"usage_start")) ||
      now >= instant(string(row,"usage_end"))) throw new PaymentDomainError(409,"service_not_quotable");
  return row;
}

function activeChange(database: DatabaseConnection, serviceId: number): DbRow | null {
  return one(database, `SELECT id, kind, status FROM service_changes WHERE service_id = ?
    AND status IN ('pending_payment','pending_fulfillment','fulfillment_failed','scheduled')`, serviceId);
}

function hasPaidConflict(database: DatabaseConnection, serviceId: number): boolean {
  return database.prepare("SELECT id FROM service_changes WHERE service_id=? AND status='paid_conflict' LIMIT 1")
    .all(serviceId).length !== 0;
}

function target(database: DatabaseConnection, row: DbRow, specId: string | null, kind: ChangeKind): {
  selection: PlanSelection; planId: number; monthlyPlanId: number; monthlyFen: number; quota: number;
} {
  const selection: PlanSelection = {
    typeId: string(row, "type_id"), regionId: string(row, "region_id"), ispId: string(row, "isp_id"),
    specId, durationId: string(row, "duration_id"),
  };
  const quota = quotaGb(specId, selection.typeId);
  if (quota === null || specId === row.spec_id) throw new PaymentDomainError(409, "invalid_change_target");
  const plan = findSellablePlan(database, selection);
  const monthly = findSellablePlan(database, { ...selection, durationId: "month-1" });
  if (plan === null || monthly === null || !plan.isActive || !monthly.isActive ||
      (plan.totalSlots !== null && plan.occupiedSlots >= plan.totalSlots) ||
      (monthly.totalSlots !== null && monthly.occupiedSlots >= monthly.totalSlots)) {
    throw new PaymentDomainError(409, "plan_unavailable");
  }
  const currentFen = number(row, "monthly_price_fen");
  const currentQuota = number(row,"usage_quota_gb");
  const currentLineRank = lineRank(selection.typeId,row.spec_id as string | null);
  const targetLineRank = lineRank(selection.typeId,specId);
  if (!Number.isSafeInteger(monthly.priceFen) || monthly.priceFen <= 0 ||
      currentLineRank === null || targetLineRank === null ||
      (kind === "upgrade" && targetLineRank < currentLineRank) ||
      (kind === "downgrade" && targetLineRank >= currentLineRank) ||
      quota < currentQuota || (kind === "downgrade" && quota !== currentQuota) ||
      (kind === "upgrade" && monthly.priceFen <= currentFen) ||
      (kind === "downgrade" && monthly.priceFen >= currentFen)) {
    throw new PaymentDomainError(409, "invalid_change_target");
  }
  return { selection, planId: plan.id, monthlyPlanId: monthly.id, monthlyFen: monthly.priceFen, quota };
}

function checkedScheduledTarget(database: DatabaseConnection, current: DbRow, change: DbRow) {
  if (change.kind !== "downgrade" || change.status !== "scheduled" || change.user_id !== current.user_id ||
      change.service_id !== current.service_id || change.from_version !== current.version ||
      change.amount_fen !== 0 || change.order_id !== null || change.quote_ref !== null || change.receipt_ref !== null ||
      change.effective_at !== current.period_end || hasPaidConflict(database,number(current,"service_id"))) {
    throw new PaymentDomainError(409,"stale_change");
  }
  const plan = one(database,"SELECT spec_id FROM sellable_plans WHERE id=?",number(change,"target_plan_id"));
  if (plan === null) throw new PaymentDomainError(409,"plan_unavailable");
  const next = target(database,current,plan.spec_id as string|null,"downgrade");
  if (next.planId !== change.target_plan_id || next.monthlyPlanId !== change.target_monthly_plan_id ||
      next.monthlyFen !== change.target_monthly_fen) throw new PaymentDomainError(409,"stale_change");
  return next;
}

/** Read-only next-paid-period selection. A contradictory existing schedule never
 * falls back to current rights; old wallet-only schemas without this table do. */
export function scheduledRenewalTarget(database: DatabaseConnection, userId: number, serviceId: number): PlanSelection | null {
  if (one(database,"SELECT name FROM sqlite_master WHERE type='table' AND name='service_changes'") === null) return null;
  if (hasPaidConflict(database,serviceId)) throw new PaymentDomainError(409,"change_already_pending");
  const change = one(database,"SELECT * FROM service_changes WHERE service_id=? AND status='scheduled'",serviceId);
  if (change === null) return null;
  const current = boundEntitlement(database,serviceId,userId);
  return checkedScheduledTarget(database,current,change).selection;
}

/** Pure local demo only. Reaching expiry changes the selected line/plan, never
 * pays, extends service, starts a new period, or resets quota/usage. No scheduler. */
export function applyDueScheduledDowngrade(database: DatabaseConnection, mode: "LOCAL_DEMO_ONLY",
  userId: number, serviceId: number, changeId: number, now: Date) {
  if (mode !== "LOCAL_DEMO_ONLY") throw new PaymentDomainError(403,"local_demo_only");
  const operation = database.transaction(() => {
    const change = one(database,`SELECT * FROM service_changes WHERE id=? AND service_id=? AND user_id=? AND kind='downgrade'`,changeId,serviceId,userId);
    if (change === null || !["scheduled","applied"].includes(string(change,"status")))
      throw new PaymentDomainError(409,"no_scheduled_downgrade");
    const current = boundEntitlement(database,serviceId,userId);
    const receipt = `LOCAL-due-${changeId}`;
    if (!Number.isFinite(now.getTime()) || change.effective_at !== current.period_end ||
        now < instant(string(change,"effective_at")) || hasPaidConflict(database,serviceId))
      throw new PaymentDomainError(409,"change_not_due");
    if (change.status === "applied") {
      const plan = one(database,"SELECT spec_id FROM sellable_plans WHERE id=?",number(change,"target_plan_id"));
      if (change.receipt_ref !== receipt || current.version !== number(change,"from_version")+1 ||
          current.plan_id !== change.target_plan_id || current.monthly_plan_id !== change.target_monthly_plan_id ||
          current.monthly_price_fen !== change.target_monthly_fen || plan?.spec_id !== current.spec_id ||
          change.amount_fen !== 0 || change.order_id !== null || change.quote_ref !== null)
        throw new PaymentDomainError(409,"stale_change");
      return { status:"applied" as const,replay:true };
    }
    const next = checkedScheduledTarget(database,current,change);
    const updated = database.prepare(`UPDATE service_entitlements SET plan_id=?,monthly_plan_id=?,monthly_price_fen=?,
      version=version+1,updated_at=? WHERE service_id=? AND user_id=? AND version=?`).run(
      next.planId,next.monthlyPlanId,next.monthlyFen,now.toISOString(),serviceId,userId,number(current,"version"));
    if (updated.changes !== 1) throw new PaymentDomainError(409,"stale_change");
    const applied = database.prepare(`UPDATE service_changes SET status='applied',receipt_ref=?,updated_at=?
      WHERE id=? AND status='scheduled' AND from_version=?`).run(receipt,now.toISOString(),changeId,number(current,"version"));
    if (applied.changes !== 1) throw new PaymentDomainError(409,"stale_change");
    return { status:"applied" as const,replay:false };
  });
  return operation.immediate();
}

export function quoteServiceUpgrade(database: DatabaseConnection, userId: number, serviceId: number, specId: string | null, now: Date) {
  const operation = database.transaction(() => {
    const current = entitlement(database, serviceId, userId, now);
    if (activeChange(database, serviceId) !== null || hasPaidConflict(database,serviceId))
      throw new PaymentDomainError(409, "change_already_pending");
    const next = target(database, current, specId, "upgrade");
    const start = instant(string(current, "period_start"));
    const end = instant(string(current, "period_end"));
    const amountFen = proratedUpgradeFen(next.monthlyFen - number(current, "monthly_price_fen"),
      number(current, "period_months"), number(current, "discount_numerator"), number(current, "discount_denominator"),
      end.getTime() - now.getTime(), end.getTime() - start.getTime());
    const quoteRef = randomUUID();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    database.prepare(`INSERT INTO service_change_quotes
      (quote_ref,service_id,user_id,service_version,usage_version,target_plan_id,target_monthly_plan_id,target_monthly_fen,amount_fen,quoted_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(quoteRef, serviceId, userId, number(current, "version"), number(current, "usage_version"),
        next.planId, next.monthlyPlanId, next.monthlyFen, amountFen, now.toISOString(), expiresAt);
    return { quoteRef, amountFen, currency: "CNY" as const, expiresAt, effectiveCondition: "simulated_fulfillment_ack" as const,
      periodEnd: string(current, "period_end"), monthlyUsedGb: number(current, "usage_used_gb"), monthlyWindowEnd: string(current, "usage_end") };
  });
  return operation.immediate();
}

export function createServiceUpgradeOrder(dependencies: OrderServiceDependencies, input: {
  userId: number; serviceId: number; quoteRef: string; idempotencyKey: string; rawAccessToken: string; acknowledgedAmountFen: number;
}) {
  const operation = dependencies.database.transaction(() => {
    const database = dependencies.database;
    const previous = one(database, `SELECT sc.id, o.order_ref, o.amount_fen, o.status, p.reserved_until
      FROM orders o JOIN service_changes sc ON sc.order_id = o.id
      JOIN payments p ON p.order_id = o.id
      WHERE o.idempotency_key = ?`, input.idempotencyKey);
    if (previous !== null) {
      const quote = one(database, "SELECT service_id, user_id, quote_ref, target_plan_id FROM service_change_quotes WHERE quote_ref = ?", input.quoteRef);
      if (quote === null || quote.service_id !== input.serviceId || quote.user_id !== input.userId ||
          string(quote, "quote_ref") !== input.quoteRef || number(previous, "amount_fen") !== input.acknowledgedAmountFen) {
        throw new PaymentDomainError(409, "idempotency_key_conflict");
      }
      const linked = one(database, `SELECT sc.id FROM service_changes sc JOIN orders o ON o.id=sc.order_id
        WHERE o.idempotency_key=? AND sc.service_id=? AND sc.user_id=? AND sc.quote_ref=?`,
        input.idempotencyKey,input.serviceId,input.userId,input.quoteRef);
      if (linked === null) throw new PaymentDomainError(409,"idempotency_key_conflict");
      const targetPlan = one(database,"SELECT type_id,region_id,isp_id,spec_id,duration_id FROM sellable_plans WHERE id=(SELECT target_plan_id FROM service_change_quotes WHERE quote_ref=?)",input.quoteRef);
      if (targetPlan === null) throw new Error("Service change target invariant failed");
      const fingerprint = createHash("sha256").update(JSON.stringify({kind:"service_upgrade",userId:input.userId,
        serviceId:input.serviceId,quoteRef:input.quoteRef,amountFen:input.acknowledgedAmountFen})).digest("hex");
      return paymentResponse(createStoredOrder(dependencies,{idempotencyKey:input.idempotencyKey,rawAccessToken:input.rawAccessToken,
        selection:{typeId:string(targetPlan,"type_id"),regionId:string(targetPlan,"region_id"),ispId:string(targetPlan,"isp_id"),
          specId:targetPlan.spec_id as string|null,durationId:string(targetPlan,"duration_id")},
        contact:"LOCAL DEMO",scenarios:[],notes:null,amountFen:input.acknowledgedAmountFen,userId:input.userId,
        fingerprint,planId:number(quote,"target_plan_id"),couponId:null,discountFen:0,skipPlanOccupancy:true}));
    }
    const now = (dependencies.now ?? (() => new Date()))();
    const current = entitlement(database, input.serviceId, input.userId, now);
    const quote = one(database, "SELECT * FROM service_change_quotes WHERE quote_ref = ? AND service_id = ? AND user_id = ?", input.quoteRef, input.serviceId, input.userId);
    if (quote === null || string(quote, "expires_at") <= now.toISOString() ||
        number(quote, "service_version") !== number(current, "version") ||
        number(quote, "usage_version") !== number(current, "usage_version") ||
        number(quote, "amount_fen") !== input.acknowledgedAmountFen ||
        (quote.consumed_at !== null && previous === null)) throw new PaymentDomainError(409, "stale_change_quote");
    const plan = one(database, "SELECT spec_id FROM sellable_plans WHERE id = ?", number(quote, "target_plan_id"));
    if (plan === null || (plan.spec_id !== null && typeof plan.spec_id !== "string")) throw new PaymentDomainError(409, "stale_change_quote");
    const next = target(database, current, plan.spec_id as string | null, "upgrade");
    if (next.planId !== quote.target_plan_id || next.monthlyPlanId !== quote.target_monthly_plan_id || next.monthlyFen !== quote.target_monthly_fen ||
        activeChange(database, input.serviceId) !== null || hasPaidConflict(database,input.serviceId))
      throw new PaymentDomainError(409, "stale_change_quote");
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      kind: "service_upgrade", userId: input.userId, serviceId: input.serviceId, quoteRef: input.quoteRef,
      amountFen: input.acknowledgedAmountFen,
    })).digest("hex");
    const result = createStoredOrder(dependencies, {
      idempotencyKey: input.idempotencyKey, rawAccessToken: input.rawAccessToken,
      selection: next.selection, contact: "LOCAL DEMO", scenarios: [], notes: null,
      amountFen: input.acknowledgedAmountFen, userId: input.userId, fingerprint: requestFingerprint,
      planId: next.planId, couponId: null, discountFen: 0, skipPlanOccupancy: true,
    });
    const order = one(database, "SELECT id FROM orders WHERE order_ref = ?", result.orderRef);
    if (order === null) throw new Error("Service change order insertion failed");
    database.prepare(`INSERT INTO service_changes
      (service_id,user_id,kind,status,order_id,quote_ref,from_version,target_plan_id,target_monthly_plan_id,target_monthly_fen,amount_fen,created_at,updated_at)
      VALUES (?,?,'upgrade','pending_payment',?,?,?,?,?,?,?,?,?)`).run(
      input.serviceId, input.userId, number(order, "id"), input.quoteRef, number(current, "version"),
      next.planId, next.monthlyPlanId, next.monthlyFen, input.acknowledgedAmountFen, now.toISOString(), now.toISOString());
    database.prepare("UPDATE service_change_quotes SET consumed_at = ? WHERE quote_ref = ? AND consumed_at IS NULL")
      .run(now.toISOString(), input.quoteRef);
    return paymentResponse(result);
  });
  return operation.immediate();
}

export function scheduleServiceDowngrade(database: DatabaseConnection, userId: number, serviceId: number, specId: string | null, now: Date) {
  const operation = database.transaction(() => {
    const current = entitlement(database, serviceId, userId, now);
    if (activeChange(database, serviceId) !== null || hasPaidConflict(database,serviceId))
      throw new PaymentDomainError(409, "change_already_pending");
    const next = target(database, current, specId, "downgrade");
    database.prepare(`INSERT INTO service_changes
      (service_id,user_id,kind,status,from_version,target_plan_id,target_monthly_plan_id,target_monthly_fen,amount_fen,effective_at,created_at,updated_at)
      VALUES (?,?,'downgrade','scheduled',?,?,?,?,0,?,?,?)`).run(serviceId,userId,number(current,"version"),next.planId,next.monthlyPlanId,next.monthlyFen,
        string(current,"period_end"),now.toISOString(),now.toISOString());
    return { status: "scheduled" as const, amountFen: 0, effectiveAt: string(current, "period_end") };
  });
  return operation.immediate();
}

export function cancelServiceDowngrade(database: DatabaseConnection, userId: number, serviceId: number, now: Date) {
  const operation = database.transaction(() => {
    entitlement(database, serviceId, userId, now);
    const result = database.prepare(`UPDATE service_changes SET status='cancelled', updated_at=?
      WHERE service_id=? AND user_id=? AND kind='downgrade' AND status='scheduled' AND effective_at>?`)
      .run(now.toISOString(), serviceId, userId, now.toISOString());
    if (result.changes !== 1) throw new PaymentDomainError(409, "no_scheduled_downgrade");
    return { status: "cancelled" as const };
  });
  return operation.immediate();
}

export function acknowledgeServiceFulfillment(database: DatabaseConnection, userId: number, serviceId: number,
  receiptRef: string, succeeded: boolean, now: Date) {
  const operation = database.transaction(() => {
    const change = one(database, `SELECT * FROM service_changes WHERE service_id=? AND user_id=? AND kind='upgrade'
      AND status IN ('pending_fulfillment','fulfillment_failed','applied') ORDER BY id DESC LIMIT 1`, serviceId,userId);
    if (change === null) throw new PaymentDomainError(409, "no_paid_change");
    if (change.status === "applied") {
      if (change.receipt_ref === receiptRef) return { status: "applied" as const, replay: true };
      throw new PaymentDomainError(409, "change_already_applied");
    }
    const current = entitlement(database, serviceId, userId, now);
    if (number(change,"from_version") !== number(current,"version")) throw new PaymentDomainError(409,"stale_change");
    if (!succeeded) {
      database.prepare("UPDATE service_changes SET status='fulfillment_failed', failure_reason='simulated_failure', updated_at=? WHERE id=?")
        .run(now.toISOString(), number(change,"id"));
      return { status: "fulfillment_failed" as const, replay: false };
    }
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(receiptRef)) throw new PaymentDomainError(400,"invalid_receipt");
    const plan = one(database,"SELECT spec_id FROM sellable_plans WHERE id=?",number(change,"target_plan_id"));
    if (plan === null) throw new Error("Service change target invariant failed");
    const quota = quotaGb(plan.spec_id as string | null, string(current,"type_id"));
    if (quota === null) throw new Error("Service change target invariant failed");
    database.prepare(`UPDATE service_entitlements SET plan_id=?,monthly_plan_id=?,monthly_price_fen=?,
      usage_quota_gb=?,version=version+1,updated_at=? WHERE service_id=? AND version=?`).run(
      number(change,"target_plan_id"),number(change,"target_monthly_plan_id"),number(change,"target_monthly_fen"),
      quota,now.toISOString(),serviceId,number(current,"version"));
    database.prepare(`UPDATE service_changes SET status='applied',effective_at=?,receipt_ref=?,failure_reason=NULL,updated_at=? WHERE id=?`)
      .run(now.toISOString(),receiptRef,now.toISOString(),number(change,"id"));
    return { status: "applied" as const, replay: false };
  });
  return operation.immediate();
}

export function serviceChangeSnapshot(database: DatabaseConnection, serviceId: number, userId: number, now: Date) {
  let current: DbRow;
  try { current = entitlement(database,serviceId,userId,now); }
  catch (error) {
    if (error instanceof PaymentDomainError) return null;
    throw error;
  }
  const change = one(database, `SELECT sc.id,sc.kind,sc.status,sc.amount_fen,sc.effective_at,
      sc.target_monthly_fen,sp.spec_id AS target_spec_id,o.order_ref
    FROM service_changes sc JOIN sellable_plans sp ON sp.id=sc.target_plan_id
    LEFT JOIN orders o ON o.id=sc.order_id
    WHERE sc.service_id=? AND sc.user_id=?
    ORDER BY CASE WHEN sc.status IN ('pending_payment','pending_fulfillment','fulfillment_failed','scheduled') THEN 1 ELSE 0 END DESC,sc.id DESC LIMIT 1`,
    serviceId,userId);
  return {
    serviceId, typeId: string(current,"type_id"), regionId: string(current,"region_id"),
    ispId: string(current,"isp_id"), specId: current.spec_id as string | null,
    monthlyPriceFen: number(current,"monthly_price_fen"), periodEnd: string(current,"period_end"),
    usageUsedGb: number(current,"usage_used_gb"), usageQuotaGb: number(current,"usage_quota_gb"),
    usageWindowEnd: string(current,"usage_end"), version: number(current,"version"),
    periodMonths: number(current,"period_months"),
    bindingProvenance: string(current,"binding_provenance"),
    paidConflict: hasPaidConflict(database,serviceId),
    change: change === null ? null : { id: number(change,"id"), kind: string(change,"kind"), status: string(change,"status"),
      amountFen:number(change,"amount_fen"),targetSpecId:change.target_spec_id as string|null,
      targetMonthlyFen:number(change,"target_monthly_fen"),effectiveAt:change.effective_at as string|null,
      orderRef:change.order_ref as string|null },
  };
}

export function listServiceChangeOptions(database: DatabaseConnection, userId: number, serviceId: number, now: Date) {
  const current = entitlement(database, serviceId, userId, now);
  const rows = database.prepare(`SELECT month.spec_id,month.price_fen,period.id AS period_plan_id
    FROM sellable_plans month JOIN sellable_plans period
      ON period.type_id=month.type_id AND period.region_id=month.region_id
      AND period.isp_id=month.isp_id AND period.spec_id IS month.spec_id
      AND period.duration_id=? AND period.is_active=1
    WHERE month.type_id=? AND month.region_id=? AND month.isp_id=?
      AND month.duration_id='month-1' AND month.is_active=1
    ORDER BY month.price_fen,month.spec_id`).all(string(current,"duration_id"),string(current,"type_id"),
      string(current,"region_id"),string(current,"isp_id")) as DbRow[];
  return rows.flatMap((row) => {
    const specId = row.spec_id;
    if (specId !== null && typeof specId !== "string") throw new Error("Service change catalog invariant failed");
    const quota = quotaGb(specId as string|null,string(current,"type_id"));
    if (quota === null) return [];
    const monthlyFen = number(row,"price_fen");
    const currentFen = number(current,"monthly_price_fen");
    const currentQuota = number(current,"usage_quota_gb");
    const currentLineRank = lineRank(string(current,"type_id"),current.spec_id as string|null);
    const targetLineRank = lineRank(string(current,"type_id"),specId as string|null);
    if (currentLineRank === null || targetLineRank === null ||
        (targetLineRank < currentLineRank && (quota !== currentQuota || monthlyFen >= currentFen)) ||
        (targetLineRank >= currentLineRank && monthlyFen < currentFen)) return [];
    if (quota < currentQuota || (monthlyFen < currentFen && quota !== currentQuota) ||
        (monthlyFen === currentFen && specId !== current.spec_id)) return [];
    return [{specId,monthlyFen,direction:monthlyFen > currentFen ? "upgrade" as const :
      monthlyFen < currentFen ? "downgrade" as const : "current" as const}];
  });
}
