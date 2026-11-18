import { createHash } from "node:crypto";
import type { DatabaseConnection } from "../db.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  WalletError, integer, one, text, timestamp, write,
} from "../wallet/candidate.js";
import { ESCALATION_WINDOW_MS } from "../wallet/renewal-operations.js";
import type { OwnerAlertConfig, OwnerAlertReason } from "./owner-alert-runtime.js";
import { OWNER_ALERT_MAX_REMINDER_ORDINAL } from "./owner-alert-runtime.js";
import {
  alertCaseUnresolved, enqueueOwnerAlertNotice, quarantineStaleBindings,
} from "./owner-alert-outbox.js";

/* TEST_ONLY owner-alert event identity + evaluator. A semantic event is the
   canonical meaning of one cause, NOT one physical row: the fingerprint
   hashes (operation, reason, claim meaning) so repeated equivalent appended
   contradiction rows map to ONE event, while a genuinely new outcome/term/
   revision earns the next episode. All raw contradiction rows stay preserved;
   same-event retries reuse the same key; a bounded reminder is a separate
   ordinal, never a new event. The earliest dispatch anchor and the first
   persisted transport acceptance are never reset by re-runs. Notifications
   cause no supplier, money, service, redispatch, release, refund or
   compensation effects. */

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function dispatchUnknownCauseFingerprint(
  operationId: number,
  dispatchId: string,
): string {
  return sha256Hex(
    `owner-alert-cause-v1|DISPATCH_UNKNOWN|${integer(operationId)}|${dispatchId}`,
  );
}

export function contradictionCauseFingerprint(
  operationId: number,
  claim: { dispatchId: string; resourceKey: string; outcome: string; termEndsAt: string | null },
): string {
  return sha256Hex(
    `owner-alert-cause-v1|CONTRADICTION|${integer(operationId)}|${claim.dispatchId}` +
    `|${claim.resourceKey}|${claim.outcome}|${claim.termEndsAt ?? ""}`,
  );
}

export function ownerAlertEventKey(reason: OwnerAlertReason, fingerprint: string): string {
  return `owner-alert-v1:${reason}:${fingerprint.slice(0, 40)}`;
}

interface EnsureEventParams {
  readonly operationId: number;
  readonly reason: OwnerAlertReason;
  readonly fingerprint: string;
  readonly sourceRowId: number | null;
  readonly anchorAt: string;
  readonly dueAt: string;
  readonly config: OwnerAlertConfig;
  readonly at: string;
}

/* Idempotent inside the caller's write() scope: the same fingerprint keeps
   the same event; a new one takes the next (operation,reason) episode
   ordinal, deterministically ordered by source row id during the pass. */
function ensureOwnerAlertEvent(
  db: DatabaseConnection,
  params: EnsureEventParams,
): { eventKey: string; episode: number; created: boolean } {
  const eventKey = ownerAlertEventKey(params.reason, params.fingerprint);
  const existing = one(
    db, "SELECT episode FROM owner_alert_events WHERE event_key=?", eventKey,
  );
  if (existing !== null) {
    return { eventKey, episode: integer(existing.episode), created: false };
  }
  const prior = one(
    db,
    "SELECT MAX(episode) AS ep FROM owner_alert_events WHERE operation_id=? AND reason=?",
    params.operationId, params.reason,
  );
  const episode = prior === null || prior.ep === null ? 0 : integer(prior.ep) + 1;
  db.prepare(
    `INSERT INTO owner_alert_events
       (event_key,operation_id,reason,episode,cause_fingerprint,recipient_ref,
        recipient_config_version,first_source_row_id,anchor_at,due_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    eventKey, params.operationId, params.reason, episode, params.fingerprint,
    params.config.recipientRef, integer(params.config.recipientConfigVersion),
    params.sourceRowId, timestamp(params.anchorAt), timestamp(params.dueAt),
    timestamp(params.at),
  );
  return { eventKey, episode, created: true };
}

export interface OwnerAlertReconcileResult {
  readonly dueMarked: number;
  readonly eventsCreated: number;
  readonly noticesEnqueued: number;
  readonly remindersEnqueued: number;
  readonly quarantined: number;
}

type Row = Record<string, unknown>;

/* One atomic reconcile pass — mark DUE, associate semantic events and
   enqueue notices in the SAME write() transaction, so a crash can never
   leave a marked operation without its durable notice slot. Re-running the
   evaluator is idempotent and repairs all three catch-up classes:
   (a) overdue operations that never received DUE,
   (b) durable DUE rows missing their outbox entry,
   (c) pending/expired-lease notices the dispatcher claim still sees.
   The owned effects stay notification-only. */
export function reconcileOwnerAlerts(
  db: DatabaseConnection,
  mode: "TEST_ONLY",
  config: OwnerAlertConfig,
  keyring: TokenHmacKeyring,
  nowIso: string,
): OwnerAlertReconcileResult {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const now = timestamp(nowIso);
    let dueMarked = 0;
    let eventsCreated = 0;
    let noticesEnqueued = 0;
    let remindersEnqueued = 0;

    let quarantined = quarantineStaleBindings(db, config, keyring, now);

    // (a)+(b) overdue dispatch anchor: DUE mark + event + notice, atomically.
    const cutoff = new Date(Date.parse(now) - ESCALATION_WINDOW_MS).toISOString();
    const dueOps = db.prepare(
      `SELECT id,dispatch_id,dispatch_anchor_at,escalation_due_at
         FROM wallet_renewal_operations
        WHERE state='DISPATCH_AUTHORIZED' AND dispatch_anchor_at IS NOT NULL
          AND dispatch_anchor_at <= ?`,
    ).all(cutoff) as Row[];
    for (const op of dueOps) {
      const operationId = integer(op.id);
      let dueAt = op.escalation_due_at === null ? null : text(op.escalation_due_at);
      if (dueAt === null) {
        db.prepare(
          "UPDATE wallet_renewal_operations SET escalation_due_at=? WHERE id=? AND escalation_due_at IS NULL",
        ).run(now, operationId);
        dueAt = now;
        dueMarked++;
      }
      const fingerprint = dispatchUnknownCauseFingerprint(operationId, text(op.dispatch_id));
      const event = ensureOwnerAlertEvent(db, {
        operationId, reason: "DISPATCH_UNKNOWN", fingerprint, sourceRowId: null,
        anchorAt: text(op.dispatch_anchor_at), dueAt, config, at: now,
      });
      if (event.created) eventsCreated++;
      if (enqueueOwnerAlertNotice(db, {
        eventKey: event.eventKey, operationId, reason: "DISPATCH_UNKNOWN",
        episode: event.episode, reminderOrdinal: 0,
        anchorAt: text(op.dispatch_anchor_at), dueAt, now,
      }, config, keyring)) {
        noticesEnqueued++;
      }
    }

    /* Append-only contradiction claims: identical claim meaning dedups to the
       same event; a different claim is a preserved new episode. */
    const claims = db.prepare(
      "SELECT id,operation_id,dispatch_id,resource_key,outcome,term_ends_at,recorded_at FROM wallet_renewal_contradictions ORDER BY id ASC",
    ).all() as Row[];
    for (const claim of claims) {
      const operationId = integer(claim.operation_id);
      const fingerprint = contradictionCauseFingerprint(operationId, {
        dispatchId: text(claim.dispatch_id),
        resourceKey: text(claim.resource_key),
        outcome: text(claim.outcome),
        termEndsAt: claim.term_ends_at === null ? null : text(claim.term_ends_at),
      });
      const recordedAt = text(claim.recorded_at);
      const event = ensureOwnerAlertEvent(db, {
        operationId, reason: "CONTRADICTION", fingerprint,
        sourceRowId: integer(claim.id), anchorAt: recordedAt, dueAt: recordedAt,
        config, at: now,
      });
      if (event.created) eventsCreated++;
      if (enqueueOwnerAlertNotice(db, {
        eventKey: event.eventKey, operationId, reason: "CONTRADICTION",
        episode: event.episode, reminderOrdinal: 0,
        anchorAt: recordedAt, dueAt: recordedAt, now,
      }, config, keyring)) {
        noticesEnqueued++;
      }
    }

    /* Bounded reminder: only after a PERSISTED first acceptance older than the
       delay, still unresolved and never ACKed; at most ONE reminder ordinal.
       A never-accepted event follows the failure/budget path only. */
    const reminderCutoff = new Date(
      Date.parse(now) - config.reminderDelayMs,
    ).toISOString();
    const candidates = db.prepare(
      `SELECT event_key,operation_id,reason,episode,anchor_at,due_at,
              recipient_ref,recipient_config_version
         FROM owner_alert_events
        WHERE first_notice_accepted_at IS NOT NULL
          AND first_notice_accepted_at <= ? AND owner_ack_at IS NULL`,
    ).all(reminderCutoff) as Row[];
    for (const event of candidates) {
      const eventKey = text(event.event_key);
      const pending = one(
        db,
        "SELECT idempotency_key FROM owner_alert_outbox WHERE event_key=? AND reminder_ordinal >= 1",
        eventKey,
      );
      if (pending !== null) continue;
      const sentReminders = one(
        db,
        "SELECT COUNT(*) AS n FROM owner_alert_audit WHERE event_key=? AND reminder_ordinal >= 1",
        eventKey,
      );
      const reminderOrdinal = (sentReminders === null ? 0 : integer(sentReminders.n)) + 1;
      if (reminderOrdinal > OWNER_ALERT_MAX_REMINDER_ORDINAL) continue;
      if (!alertCaseUnresolved(
        db, integer(event.operation_id), text(event.reason) as OwnerAlertReason,
      )) continue;
      /* Reminders inherit the event's PINNED recipient binding — never the
         current config — so a drifted reminder can only ever be quarantined,
         never silently retargeted to a different recipient version. */
      if (enqueueOwnerAlertNotice(db, {
        eventKey, operationId: integer(event.operation_id),
        reason: text(event.reason) as OwnerAlertReason,
        episode: integer(event.episode), reminderOrdinal,
        anchorAt: text(event.anchor_at), dueAt: text(event.due_at), now,
      }, {
        recipientRef: text(event.recipient_ref),
        recipientConfigVersion: integer(event.recipient_config_version),
      }, keyring)) {
        remindersEnqueued++;
      }
    }

    /* Any notice enqueued under a binding that has since drifted (e.g. a
       reminder pinned to a stale recipient version) is parked visibly in
       the same transaction — never left claimable under the new config. */
    quarantined += quarantineStaleBindings(db, config, keyring, now);

    return { dueMarked, eventsCreated, noticesEnqueued, remindersEnqueued, quarantined };
  });
}
