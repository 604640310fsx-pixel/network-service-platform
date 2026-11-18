import type { DatabaseConnection } from "../db.js";
import { WALLET_RENEWAL_LIVE_STATES_SQL } from "./schema.js";
import {
  assertLiveService, eligible, integer, ledger, one, purchasedService,
  produceRenewalQuote, recordConsentHistory, renewalDryRun, serviceManagementClosed,
  spendableBalanceInTransaction, text, timestamp, unresolvedRenewalContradiction,
  WalletError, write,
  type AuthoritativeQuote, type BillingPeriod, type ServiceEligibility,
} from "./candidate.js";

type Row = Record<string, unknown>;

/* TEST_ONLY modeled renewal execution: hold-first, external-extension-confirmed.
   There is no production scheduler, provider call, real hold, real dispatch or
   real settlement. The simulated external effect happens outside SQL entirely;
   trusted simulated evidence is persisted independently of the settlement
   transaction, so external truth survives any later local rollback. Every
   function is inert unless called with mode "TEST_ONLY". */

export const ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RenewalOperationState =
  "HOLD_ACTIVE" | "DISPATCH_AUTHORIZED" | "EVIDENCE_RECORDED" |
  "COMPLETED" | "CANCELLED" | "RELEASED" | "CONFLICT";

export interface RenewalOperationView {
  readonly id: number; readonly serviceId: number; readonly userId: number;
  readonly state: RenewalOperationState;
  readonly previousEndsAt: string; readonly newEndsAt: string;
  readonly amountFen: number; readonly durationId: string; readonly quoteKey: string;
  readonly consentRevision: number;
  readonly dispatchId: string | null; readonly dispatchAnchorAt: string | null;
  readonly evidenceId: number | null; readonly cycleId: number | null;
  readonly conflictDetail: string | null; readonly escalationDueAt: string | null;
  readonly createdAt: string; readonly resolvedAt: string | null;
}
/* Simulated trusted external confirmation. The claim must bind the authorized
   dispatch id, the exact bound resource and, for a success outcome, the
   fulfilled term — a bare ok/HTTP-200/exit-0/website-date shape is never
   accepted as proof. Whether a real provider can produce this evidence is
   unknown and deliberately not modeled. */
export interface SimulatedExtensionEvidence {
  readonly dispatchId: string;
  readonly resourceKey: string;
  readonly outcome: "APPLIED" | "NO_EFFECT" | "REJECTED";
  readonly termEndsAt: string | null;
  readonly sourceRef: string;
}

function operation(db: DatabaseConnection, operationId: number): Row | null {
  return one(db, "SELECT * FROM wallet_renewal_operations WHERE id=?", integer(operationId, "INVALID_REQUEST"));
}
function resourceKey(serviceId: number): string {
  return `service:${serviceId}`;
}
function lastId(db: DatabaseConnection): number {
  const row = one(db, "SELECT last_insert_rowid() AS id");
  if (row === null) throw new WalletError("INVARIANT_FAILED");
  return integer(row.id);
}
/* Facts are preserved, never overwritten. Every contradictory external claim is
   appended to wallet_renewal_contradictions (repeat claims are never silently
   dropped). An operation still occupying a live state moves to CONFLICT and
   keeps holding its uniqueness slot; an already-terminal operation is never
   resurrected into that set — it keeps its terminal state and only gains the
   conflict marker. No capture/release/overwrite/compensation happens here;
   owner reconciliation resolves it, and nothing automatic follows. */
function markConflict(db: DatabaseConnection, op: Row, detail: string, at: string,
  claim: SimulatedExtensionEvidence | null = null): "CONFLICT" {
  const operationId = integer(op.id);
  const state = text(op.state);
  if (claim !== null) {
    db.prepare(`INSERT INTO wallet_renewal_contradictions
      (operation_id,dispatch_id,resource_key,outcome,term_ends_at,source_ref,detail,recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(operationId, claim.dispatchId, claim.resourceKey, claim.outcome,
        claim.termEndsAt, claim.sourceRef, `on:${state}; ${detail}`, timestamp(at));
  }
  if (state === "HOLD_ACTIVE" || state === "DISPATCH_AUTHORIZED" || state === "EVIDENCE_RECORDED") {
    db.prepare(`UPDATE wallet_renewal_operations SET state='CONFLICT',
      conflict_detail=COALESCE(conflict_detail || '; ', '') || ?,
      resolved_at=COALESCE(resolved_at,?) WHERE id=?`).run(`from:${state}; ${detail}`, timestamp(at), operationId);
  } else {
    db.prepare(`UPDATE wallet_renewal_operations
      SET conflict_detail=COALESCE(conflict_detail || '; ', '') || ? WHERE id=?`)
      .run(`on:${state}; ${detail}`, operationId);
  }
  return "CONFLICT";
}

export function readRenewalOperation(db: DatabaseConnection, operationId: number): RenewalOperationView | null {
  const op = operation(db, operationId);
  if (op === null) return null;
  return {
    id: integer(op.id), serviceId: integer(op.service_id), userId: integer(op.user_id),
    state: text(op.state) as RenewalOperationState,
    previousEndsAt: text(op.intended_previous_ends_at), newEndsAt: text(op.intended_new_ends_at),
    amountFen: integer(op.amount_fen), durationId: text(op.duration_id), quoteKey: text(op.quote_key),
    consentRevision: integer(op.consent_revision),
    dispatchId: op.dispatch_id === null ? null : text(op.dispatch_id),
    dispatchAnchorAt: op.dispatch_anchor_at === null ? null : text(op.dispatch_anchor_at),
    evidenceId: op.evidence_id === null ? null : integer(op.evidence_id),
    cycleId: op.cycle_id === null ? null : integer(op.cycle_id),
    conflictDetail: op.conflict_detail === null ? null : text(op.conflict_detail),
    escalationDueAt: op.escalation_due_at === null ? null : text(op.escalation_due_at),
    createdAt: text(op.created_at), resolvedAt: op.resolved_at === null ? null : text(op.resolved_at),
  };
}

/* T1 — immutable intent plus hold, atomically. The authoritative quote and
   consent are re-validated inside this transaction; availability is judged on
   spendable funds B - H; reserving writes the hold only and never touches the
   settled balance or ledger. RECONSENT_REQUIRED keeps the existing
   update-consent/append-history/return semantics (not a thrown rollback). */
export function reserveRenewalOperation(
  db: DatabaseConnection, mode: "TEST_ONLY", service: ServiceEligibility,
  quote: AuthoritativeQuote | null, expectedRevision: number, at: string,
): { readonly operationId: number } | "DUPLICATE" | "RECONSENT_REQUIRED" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    assertLiveService(db, service);
    eligible(service);
    // Same frozen guard as the fixture runner: a management-closed service can
    // never start a cycle regardless of an old consent or quote object.
    if (serviceManagementClosed(db, service.serviceId)) throw new WalletError("SERVICE_CLOSED");
    /* One unresolved operation per service/prior expiry — a new operation id or
       a fresh consent revision must not bypass an outstanding attempt for the
       same period. Backstopped by the partial unique index. */
    const live = one(db, `SELECT id FROM wallet_renewal_operations
      WHERE service_id=? AND intended_previous_ends_at=? AND state IN ${WALLET_RENEWAL_LIVE_STATES_SQL}`,
      service.serviceId, service.endsAt);
    if (live !== null) return "DUPLICATE";
    /* An unresolved contradictory claim on this period forbids a fresh attempt —
       the external truth is disputed, so no new intent/hold may be created. */
    if (unresolvedRenewalContradiction(db, service.serviceId, service.endsAt!)) {
      throw new WalletError("UNRESOLVED_CONFLICT");
    }
    const consent = one(db, "SELECT revision,state,next_billing_period FROM wallet_consents WHERE service_id=?", service.serviceId);
    if (!consent || consent.revision !== expectedRevision) throw new WalletError("REVISION_CONFLICT");
    const cycle = one(db, "SELECT id FROM wallet_renewal_cycles WHERE service_id=? AND previous_ends_at=?", service.serviceId, service.endsAt);
    if (cycle) return "DUPLICATE";
    /* Re-derive the authoritative quote inside this transaction; only produced
       fields are consumed for the operation snapshot — identical rule as the
       fixture runner, so a caller-supplied price/expiry never reaches state. */
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
    if (!account || spendableBalanceInTransaction(db, service.ownerId!) < fresh.priceFen) {
      throw new WalletError("INSUFFICIENT_FUNDS");
    }
    db.prepare(`INSERT INTO wallet_renewal_operations
      (service_id,user_id,intended_previous_ends_at,intended_new_ends_at,amount_fen,currency,
       duration_id,quote_key,consent_revision,state,created_at)
      VALUES (?,?,?,?,?,'CNY',?,?,?,'HOLD_ACTIVE',?)`)
      .run(service.serviceId, service.ownerId, timestamp(fresh.previousEndsAt), timestamp(fresh.newEndsAt),
        fresh.priceFen, fresh.durationId, fresh.key, integer(expectedRevision), timestamp(at));
    const operationId = lastId(db);
    db.prepare(`INSERT INTO wallet_renewal_holds
      (operation_id,user_id,amount_fen,state,created_at) VALUES (?,?,?,'ACTIVE',?)`)
      .run(operationId, service.ownerId, fresh.priceFen, timestamp(at));
    return { operationId };
  });
}

/* T2 — durable dispatch authorization. After this commits, the operation is
   MAY_HAVE_DISPATCHED: no cancellation, release, retry or second dispatch is
   allowed, and a later consent disable/price change binds only future cycles.
   The persisted anchor is the earliest-possible-dispatch timestamp; it is set
   once under the dispatch_id IS NULL guard and is never reset by replays,
   evidence or settlement. A crashed send stays unknown, never assumed unsent.

   Before a dispatch identity is ever bound, the operation must still be what
   T1 approved: the service still owned/open/not management-closed, the consent
   still ENABLED at the bound revision, no unresolved contradictory claim on the
   period, and the freshly re-derived authoritative quote identical to the
   operation snapshot. Any drift refuses without side effects — the hold stays
   active and pre-dispatch cancellation remains possible. */
export function authorizeRenewalDispatch(
  db: DatabaseConnection, mode: "TEST_ONLY", operationId: number, dispatchId: string, at: string,
): "AUTHORIZED" | "REPLAY" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    if (typeof dispatchId !== "string" || dispatchId.length === 0) throw new WalletError("INVALID_REQUEST");
    const op = operation(db, operationId);
    if (op === null) throw new WalletError("NOT_FOUND");
    if (op.dispatch_id !== null) {
      if (op.dispatch_id === dispatchId) return "REPLAY";
      throw new WalletError("INVALID_STATE"); // dispatch identity is immutable once bound
    }
    if (op.state !== "HOLD_ACTIVE") throw new WalletError("INVALID_STATE");
    /* Re-derive the authoritative quote now (inside this transaction): it fails
       SERVICE_CLOSED on management closure/termination, FORBIDDEN on owner
       drift and QUOTE_UNAVAILABLE when the service/plan no longer resolves. */
    const consent = one(db, "SELECT state,revision,next_billing_period FROM wallet_consents WHERE service_id=?", op.service_id);
    const fresh = produceRenewalQuote(db, integer(op.service_id),
      (consent === null ? null : consent.next_billing_period) as BillingPeriod, integer(op.user_id));
    if (fresh.key !== op.quote_key || fresh.priceFen !== integer(op.amount_fen) ||
        fresh.durationId !== op.duration_id ||
        fresh.previousEndsAt !== op.intended_previous_ends_at ||
        fresh.newEndsAt !== op.intended_new_ends_at) {
      throw new WalletError("QUOTE_CHANGED");
    }
    if (consent === null || consent.state !== "ENABLED") throw new WalletError("INVALID_STATE");
    if (integer(consent.revision) !== integer(op.consent_revision)) throw new WalletError("REVISION_CONFLICT");
    if (unresolvedRenewalContradiction(db, integer(op.service_id), text(op.intended_previous_ends_at))) {
      throw new WalletError("UNRESOLVED_CONFLICT");
    }
    const updated = db.prepare(`UPDATE wallet_renewal_operations
      SET state='DISPATCH_AUTHORIZED', dispatch_id=?, dispatch_anchor_at=?
      WHERE id=? AND state='HOLD_ACTIVE' AND dispatch_id IS NULL`)
      .run(dispatchId, timestamp(at), operationId);
    if (updated.changes !== 1) throw new WalletError("INVALID_STATE");
    return "AUTHORIZED";
  });
}

/* Cancellation is the atomic loser of the T2 race: it succeeds only while the
   operation is HOLD_ACTIVE with no dispatch bound. Winning sets CANCELLED and
   releases the hold in the same transaction — release lowers H only and never
   credits B. After durable authorization it is INVALID_STATE. */
export function cancelRenewalOperation(
  db: DatabaseConnection, mode: "TEST_ONLY", operationId: number, at: string,
): "CANCELLED" | "REPLAY" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const op = operation(db, operationId);
    if (op === null) throw new WalletError("NOT_FOUND");
    if (op.state === "CANCELLED") return "REPLAY";
    const cancelled = db.prepare(`UPDATE wallet_renewal_operations
      SET state='CANCELLED', resolved_at=? WHERE id=? AND state='HOLD_ACTIVE' AND dispatch_id IS NULL`)
      .run(timestamp(at), operationId);
    if (cancelled.changes !== 1) throw new WalletError("INVALID_STATE");
    const released = db.prepare(`UPDATE wallet_renewal_holds
      SET state='RELEASED', resolved_at=? WHERE operation_id=? AND state='ACTIVE'`)
      .run(timestamp(at), operationId);
    if (released.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    return "CANCELLED";
  });
}

/* T3 — persist trusted simulated external evidence, independently of T4. The
   claim is bound to the authorized dispatch, the exact resource and (for a
   success claim) the exact fulfilled term before any write. Identical replay is
   REPLAY; a different bound claim is preserved contradiction → CONFLICT. If
   persistence itself fails the operation simply stays DISPATCH_AUTHORIZED
   (unknown) — no redispatch, no release. */
export function recordRenewalEvidence(
  db: DatabaseConnection, mode: "TEST_ONLY", operationId: number,
  evidence: SimulatedExtensionEvidence, at: string,
): "RECORDED" | "REPLAY" | "CONFLICT" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const op = operation(db, operationId);
    if (op === null) throw new WalletError("NOT_FOUND");
    if (op.dispatch_id === null) throw new WalletError("INVALID_STATE");
    if (evidence.dispatchId !== op.dispatch_id) throw new WalletError("EVIDENCE_MISMATCH");
    if (evidence.resourceKey !== resourceKey(integer(op.service_id))) throw new WalletError("EVIDENCE_MISMATCH");
    if (evidence.outcome === "APPLIED" && evidence.termEndsAt !== op.intended_new_ends_at) throw new WalletError("EVIDENCE_MISMATCH");
    if (evidence.outcome !== "APPLIED" && evidence.termEndsAt !== null) throw new WalletError("EVIDENCE_MISMATCH");
    if (typeof evidence.sourceRef !== "string" || evidence.sourceRef.length === 0) throw new WalletError("EVIDENCE_MISMATCH");
    const existing = one(db, "SELECT * FROM wallet_renewal_evidence WHERE operation_id=?", operationId);
    if (existing !== null) {
      const same = existing.dispatch_id === evidence.dispatchId && existing.resource_key === evidence.resourceKey &&
        existing.outcome === evidence.outcome && existing.term_ends_at === evidence.termEndsAt &&
        existing.source_ref === evidence.sourceRef;
      if (same) return "REPLAY";
      return markConflict(db, op, `contradictory evidence outcome:${evidence.outcome} term:${evidence.termEndsAt}`, at, evidence);
    }
    if (op.state !== "DISPATCH_AUTHORIZED") {
      /* A bound late claim on a terminal operation is preserved append-only —
         the row keeps its terminal state, the claim lands in the contradictions
         log, and nothing resurrects, re-debits or releases. */
      return markConflict(db, op, `late evidence outcome:${evidence.outcome} term:${evidence.termEndsAt}`, at, evidence);
    }
    db.prepare(`INSERT INTO wallet_renewal_evidence
      (operation_id,dispatch_id,resource_key,outcome,term_ends_at,source_ref,recorded_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(operationId, evidence.dispatchId, evidence.resourceKey, evidence.outcome,
        evidence.termEndsAt, evidence.sourceRef, timestamp(at));
    db.prepare("UPDATE wallet_renewal_operations SET state='EVIDENCE_RECORDED', evidence_id=? WHERE id=?")
      .run(lastId(db), operationId);
    return "RECORDED";
  });
}

/* T4 — final local settlement, atomic. Requires recorded trusted APPLIED
   evidence that still binds this dispatch/resource/term, the service still
   owned-open and not management-closed, untouched expiry and no prior cycle for
   the period. Own-hold capture consumes the reservation once: the ordinary
   B - H availability check is not applied again (it would double-subtract).
   Any post-dispatch local conflict → CONFLICT with facts preserved; no capture,
   release, overwrite, reopen or compensation happens automatically. If this
   transaction rolls back after external success, the evidence and operation
   state survive; recovery may only rerun this same local settlement. */
export function settleRenewalOperation(
  db: DatabaseConnection, mode: "TEST_ONLY", operationId: number, at: string,
): "COMPLETED" | "REPLAY" | "CONFLICT" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const op = operation(db, operationId);
    if (op === null) throw new WalletError("NOT_FOUND");
    if (op.state === "COMPLETED") return "REPLAY";
    if (op.state !== "EVIDENCE_RECORDED") throw new WalletError("INVALID_STATE");
    const ev = one(db, "SELECT * FROM wallet_renewal_evidence WHERE operation_id=?", operationId);
    if (ev === null) throw new WalletError("INVARIANT_FAILED");
    /* Wrong-route calls refuse without poisoning state: a non-APPLIED outcome
       belongs to the release path; nothing here may flip the operation. */
    if (ev.outcome !== "APPLIED") throw new WalletError("INVALID_STATE");
    if (ev.dispatch_id !== op.dispatch_id || ev.resource_key !== resourceKey(integer(op.service_id)) ||
        ev.term_ends_at !== op.intended_new_ends_at) {
      return markConflict(db, op, "recorded evidence no longer binds this operation", at);
    }
    const serviceId = integer(op.service_id);
    const previousEndsAt = text(op.intended_previous_ends_at);
    /* An unresolved contradictory claim on this period freezes settlement —
       refusal only, the operation stays EVIDENCE_RECORDED until the claim is
       reconciled; it is never auto-captured, released or overwritten. */
    if (unresolvedRenewalContradiction(db, serviceId, previousEndsAt)) throw new WalletError("UNRESOLVED_CONFLICT");
    const live = purchasedService(db, serviceId);
    if (!live.purchased || live.ownerId !== integer(op.user_id)) {
      return markConflict(db, op, "service no longer the paid owned resource", at);
    }
    if (serviceManagementClosed(db, serviceId)) {
      return markConflict(db, op, "service management-closed after dispatch", at);
    }
    /* Semantic expiry equality is what matters (normalized parse), while the
       conditional write below must match the raw stored string — the two are
       deliberately kept separate so a non-canonical stored format can never
       deadlock the operation. */
    if (live.endsAt !== previousEndsAt) {
      return markConflict(db, op, "service expiry moved outside this operation", at);
    }
    if (one(db, "SELECT id FROM wallet_renewal_cycles WHERE service_id=? AND previous_ends_at=?",
      serviceId, previousEndsAt) !== null) {
      return markConflict(db, op, "period already settled by another cycle", at);
    }
    const rawService = one(db, "SELECT ends_at FROM services WHERE id=?", serviceId);
    if (rawService === null) throw new WalletError("INVARIANT_FAILED");
    const captured = db.prepare(`UPDATE wallet_renewal_holds
      SET state='CAPTURED', resolved_at=? WHERE operation_id=? AND state='ACTIVE'`)
      .run(timestamp(at), operationId);
    if (captured.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    const debited = db.prepare("UPDATE wallet_accounts SET balance_fen=balance_fen-? WHERE user_id=? AND balance_fen>=?")
      .run(integer(op.amount_fen), integer(op.user_id), integer(op.amount_fen));
    if (debited.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    ledger(db, integer(op.user_id), "RENEWAL_DEBIT", -integer(op.amount_fen), `renewal-op:${operationId}`, at);
    db.prepare(`INSERT INTO wallet_renewal_cycles
      (service_id,previous_ends_at,new_ends_at,user_id,amount_fen,quote_key,created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(op.service_id, op.intended_previous_ends_at, op.intended_new_ends_at, op.user_id,
        op.amount_fen, op.quote_key, timestamp(at));
    const cycleId = lastId(db);
    const advanced = db.prepare("UPDATE services SET ends_at=? WHERE id=? AND ends_at=?")
      .run(op.intended_new_ends_at, serviceId, rawService.ends_at);
    if (advanced.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    db.prepare("UPDATE wallet_renewal_operations SET state='COMPLETED', cycle_id=?, resolved_at=? WHERE id=?")
      .run(cycleId, timestamp(at), operationId);
    return "COMPLETED";
  });
}

/* Release is permitted exactly once, and only on a trusted definitive
   no-effect/no-later-effect outcome recorded as evidence. Timeout, error,
   ambiguity or plain absence of evidence is never a release reason. Release
   lowers H only — it never credits B (no refund semantics) and replay is
   idempotent. */
export function releaseRenewalOperation(
  db: DatabaseConnection, mode: "TEST_ONLY", operationId: number, at: string,
): "RELEASED" | "REPLAY" | "CONFLICT" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const op = operation(db, operationId);
    if (op === null) throw new WalletError("NOT_FOUND");
    if (op.state === "RELEASED") return "REPLAY";
    if (op.state !== "EVIDENCE_RECORDED") throw new WalletError("INVALID_STATE");
    const ev = one(db, "SELECT outcome FROM wallet_renewal_evidence WHERE operation_id=?", operationId);
    if (ev === null) throw new WalletError("INVARIANT_FAILED");
    /* Wrong-route refusal only: an APPLIED claim is not releasable here — the
       operation keeps EVIDENCE_RECORDED and settlement stays reachable. */
    if (ev.outcome !== "NO_EFFECT" && ev.outcome !== "REJECTED") throw new WalletError("INVALID_STATE");
    const released = db.prepare(`UPDATE wallet_renewal_holds
      SET state='RELEASED', resolved_at=? WHERE operation_id=? AND state='ACTIVE'`)
      .run(timestamp(at), operationId);
    if (released.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    db.prepare("UPDATE wallet_renewal_operations SET state='RELEASED', resolved_at=? WHERE id=?")
      .run(timestamp(at), operationId);
    return "RELEASED";
  });
}

/* Persisted DUE escalation marker for external-unknown operations whose
   earliest-possible-dispatch anchor is older than 24h. The marker is durable
   evidence that personal handling is required — it is NOT a delivered
   notification, not hold expiry, and not retry/release authority. Once written
   it is never reset; the anchor itself is never touched. */
export function evaluateRenewalEscalations(db: DatabaseConnection, mode: "TEST_ONLY", nowIso: string): readonly number[] {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const cutoff = new Date(Date.parse(timestamp(nowIso)) - ESCALATION_WINDOW_MS).toISOString();
    const rows = db.prepare(`SELECT id FROM wallet_renewal_operations
      WHERE state='DISPATCH_AUTHORIZED' AND dispatch_anchor_at IS NOT NULL
        AND dispatch_anchor_at <= ? AND escalation_due_at IS NULL`).all(cutoff) as Row[];
    const due: number[] = [];
    for (const row of rows) {
      const id = integer(row.id);
      db.prepare("UPDATE wallet_renewal_operations SET escalation_due_at=? WHERE id=? AND escalation_due_at IS NULL")
        .run(timestamp(nowIso), id);
      due.push(id);
    }
    return due;
  });
}
