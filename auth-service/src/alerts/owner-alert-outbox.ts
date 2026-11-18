import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes,
} from "node:crypto";
import type { DatabaseConnection } from "../db.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  WalletError, integer, one, text, timestamp, write,
} from "../wallet/candidate.js";
import type {
  OwnerAlertConfig, OwnerAlertPolicy, OwnerAlertReason,
} from "./owner-alert-runtime.js";
import { ownerAlertCaseRef } from "./owner-alert-runtime.js";

/* TEST_ONLY owner-alert notice storage and lifecycle, modeled on the
   registration mail_outbox pattern (deterministic idempotency key, leased
   claims, bounded retries, HMAC'd recipient audit) but a separate purpose and
   storage: the events/episodes and the unresolved business case outlive any
   single notice. No plaintext recipient address is stored — rows bind a
   logical role ref + config version; the encrypted payload is redacted to
   { case_ref, reason, anchor_at, due_at } only — never episode or
   reminder_ordinal as payload keys. The AAD authenticates idempotency_key,
   event_key and key_version; reminder_ordinal is bound indirectly through
   the ':rem:N' idempotency-key suffix, but the numeric episode column and
   other row fields are NOT individually tamper-proof — row integrity relies
   on the database itself, not on the AAD.
   Nothing here can move money, touch supplier state, or mutate the operation
   beyond its own alert bookkeeping. */

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

const OWNER_ALERT_RECIPIENT_AUDIT_INFO = Buffer.from(
  "network-service-platform/owner-alert-recipient-audit/v1", "ascii",
);

type Row = Record<string, unknown>;

function decodeAlertKey(keyring: TokenHmacKeyring, version: number): Buffer {
  const encoded = keyring.keys[String(version)];
  if (
    !Number.isSafeInteger(version) || version < 0 || encoded === undefined ||
    !/^[A-Za-z0-9+/]{43}=$/.test(encoded)
  ) {
    throw new WalletError("ALERT_KEY_INVALID");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new WalletError("ALERT_KEY_INVALID");
  }
  return decoded;
}

/* HKDF'd from the payload key so the audit trail binds the intended recipient
   binding without ever storing the address. */
export function ownerAlertRecipientHmac(
  recipientRef: string,
  configVersion: number,
  keyring: TokenHmacKeyring,
): string {
  const encryptionKey = decodeAlertKey(keyring, keyring.version);
  const auditKey = Buffer.from(
    hkdfSync("sha256", encryptionKey, Buffer.alloc(0), OWNER_ALERT_RECIPIENT_AUDIT_INFO, 32),
  );
  const digest = createHmac("sha256", auditKey)
    .update(`${recipientRef}@cfg${integer(configVersion)}`, "utf8")
    .digest("base64url");
  return `v${keyring.version}.${digest}`;
}

/* Fixed redacted payload contract — this is the ONLY shape a notice may
   carry; any extra or malformed field refuses before encrypt/decrypt.
   Episode and reminder ordinal are validated internal row metadata — never
   payload keys; the ordinal is bound via the ':rem:N' idempotency-key
   suffix inside the AAD, the numeric episode itself is not AAD-covered. */
export interface OwnerAlertPayload {
  readonly case_ref: string;
  readonly reason: OwnerAlertReason;
  readonly anchor_at: string;
  readonly due_at: string;
}

function assertOwnerAlertPayload(value: unknown): asserts value is OwnerAlertPayload {
  if (typeof value !== "object" || value === null) throw new WalletError("ALERT_PAYLOAD_INVALID");
  const v = value as Row;
  if (Object.keys(v).sort().join(",") !== "anchor_at,case_ref,due_at,reason") {
    throw new WalletError("ALERT_PAYLOAD_INVALID");
  }
  if (typeof v.case_ref !== "string" || !/^renewal-op:\d{1,15}$/.test(v.case_ref)) {
    throw new WalletError("ALERT_PAYLOAD_INVALID");
  }
  if (v.reason !== "DISPATCH_UNKNOWN" && v.reason !== "CONTRADICTION") {
    throw new WalletError("ALERT_PAYLOAD_INVALID");
  }
  timestamp(text(v.anchor_at)); timestamp(text(v.due_at));
}

function alertAad(idempotencyKey: string, eventKey: string, keyVersion: number): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 1, idempotency_key: idempotencyKey,
    event_key: eventKey, template: "owner_alert", key_version: keyVersion,
  }), "utf8");
}

interface AlertCiphertext {
  readonly keyVersion: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

function encryptOwnerAlertPayload(
  payload: OwnerAlertPayload,
  idempotencyKey: string,
  eventKey: string,
  keyring: TokenHmacKeyring,
): AlertCiphertext {
  assertOwnerAlertPayload(payload);
  const version = keyring.version;
  const key = decodeAlertKey(keyring, version);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(alertAad(idempotencyKey, eventKey, version));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { keyVersion: version, nonce, ciphertext, tag: cipher.getAuthTag() };
}

export interface EncryptedOwnerAlert {
  readonly idempotencyKey: string;
  readonly eventKey: string;
  readonly keyVersion: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export function decryptOwnerAlertPayload(
  encrypted: EncryptedOwnerAlert,
  keyring: TokenHmacKeyring,
): OwnerAlertPayload {
  const keyVersion = integer(encrypted.keyVersion);
  const key = decodeAlertKey(keyring, keyVersion);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce, { authTagLength: TAG_LENGTH });
  decipher.setAAD(alertAad(encrypted.idempotencyKey, encrypted.eventKey, keyVersion));
  decipher.setAuthTag(encrypted.tag);
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
  const payload: unknown = JSON.parse(plaintext);
  assertOwnerAlertPayload(payload);
  return payload;
}

/* Business truth for an alert case, derived from the operation itself.
   DISPATCH_UNKNOWN stays unresolved while the operation still waits on a
   dispatch result; CONTRADICTION stays unresolved while the append-only
   conflict detail remains — the contradiction fact is never deleted. */
export function alertCaseUnresolved(
  db: DatabaseConnection,
  operationId: number,
  reason: OwnerAlertReason,
): boolean {
  const op = one(
    db, "SELECT state,conflict_detail FROM wallet_renewal_operations WHERE id=?", operationId,
  );
  if (op === null) return false;
  if (reason === "DISPATCH_UNKNOWN") return text(op.state) === "DISPATCH_AUTHORIZED";
  return text(op.state) === "CONFLICT" || op.conflict_detail !== null;
}

function isCurrentAlert(db: DatabaseConnection, eventKey: string): boolean {
  const event = one(
    db,
    "SELECT operation_id,reason,owner_ack_at FROM owner_alert_events WHERE event_key=?",
    eventKey,
  );
  if (event === null || event.owner_ack_at !== null) return false;
  return alertCaseUnresolved(db, integer(event.operation_id), text(event.reason) as OwnerAlertReason);
}

export interface EnqueueOwnerAlertParams {
  readonly eventKey: string;
  readonly operationId: number;
  readonly reason: OwnerAlertReason;
  readonly episode: number;
  readonly reminderOrdinal: number;
  readonly anchorAt: string;
  readonly dueAt: string;
  readonly now: string;
}

/* Caller must already be inside the surrounding write() transaction — this
   keeps DUE mark + event + outbox insert atomic. Idempotent by
   idempotency_key: the initial notice reuses the event key, each reminder a
   separate bounded ordinal. */
export function enqueueOwnerAlertNotice(
  db: DatabaseConnection,
  params: EnqueueOwnerAlertParams,
  binding: Pick<OwnerAlertConfig, "recipientRef" | "recipientConfigVersion">,
  keyring: TokenHmacKeyring,
): boolean {
  const idempotencyKey = params.reminderOrdinal === 0
    ? params.eventKey
    : `${params.eventKey}:rem:${integer(params.reminderOrdinal)}`;
  const existing = one(
    db, "SELECT idempotency_key FROM owner_alert_outbox WHERE idempotency_key=?", idempotencyKey,
  );
  if (existing !== null) return false;
  /* A finalized notice (sent / failed / dead_letter / …) already consumed its
     slot: the durable audit row forbids resurrecting the same key. Retries
     reuse the live outbox row; a terminated notice is never re-enqueued. */
  const finished = db.prepare(
    "SELECT id FROM owner_alert_audit WHERE idempotency_key=? LIMIT 1",
  ).all(idempotencyKey)[0] as Row | undefined;
  if (finished !== undefined) return false;
  const payload: OwnerAlertPayload = {
    case_ref: ownerAlertCaseRef(params.operationId),
    reason: params.reason,
    anchor_at: timestamp(params.anchorAt),
    due_at: timestamp(params.dueAt),
  };
  const enc = encryptOwnerAlertPayload(payload, idempotencyKey, params.eventKey, keyring);
  const now = timestamp(params.now);
  db.prepare(
    `INSERT INTO owner_alert_outbox
      (idempotency_key,event_key,operation_id,reason,episode,reminder_ordinal,
       recipient_ref,recipient_config_version,key_version,nonce,ciphertext,tag,
       status,attempts,next_attempt_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?)`,
  ).run(
    idempotencyKey, params.eventKey, integer(params.operationId), params.reason,
    integer(params.episode), integer(params.reminderOrdinal), binding.recipientRef,
    integer(binding.recipientConfigVersion), enc.keyVersion, enc.nonce, enc.ciphertext,
    enc.tag, now, now, now,
  );
  return true;
}

/* Pending rows whose bound recipient no longer matches current config pause
   into 'quarantined' — never auto-rebound, never delivered to a fallback.
   Quarantined notices stay visible in the case projection and audit; any
   recipient retargeting is a future owner-approved contract, so no rebind
   path exists here. Caller must be inside the surrounding write() txn. */
export function quarantineStaleBindings(
  db: DatabaseConnection,
  config: OwnerAlertConfig,
  keyring: TokenHmacKeyring,
  nowIso: string,
): number {
  const rows = db.prepare(
    `SELECT idempotency_key,event_key,reminder_ordinal,recipient_ref,recipient_config_version,attempts
       FROM owner_alert_outbox
      WHERE (recipient_ref <> ? OR recipient_config_version <> ?)
        AND (status='pending'
          OR (status='sending' AND leased_until IS NOT NULL AND leased_until <= ?))`,
  ).all(config.recipientRef, integer(config.recipientConfigVersion), timestamp(nowIso)) as Row[];
  for (const row of rows) {
    /* An expired-lease 'sending' row is parked too — its old lease token is
       cleared so any stale finalizer loses; an active unexpired lease is
       left untouched. */
    const parked = db.prepare(
      `UPDATE owner_alert_outbox
          SET status='quarantined', leased_until=NULL, lease_token=NULL, updated_at=?
        WHERE idempotency_key=? AND (status='pending' OR status='sending')`,
    ).run(timestamp(nowIso), text(row.idempotency_key));
    if (parked.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    db.prepare(
      `INSERT INTO owner_alert_audit
         (idempotency_key,event_key,recipient_hmac,outcome,detail,final_attempts,reminder_ordinal,recorded_at)
       VALUES (?,?,?,'quarantined','recipient_binding_mismatch',?,?,?)`,
    ).run(
      text(row.idempotency_key), text(row.event_key),
      ownerAlertRecipientHmac(text(row.recipient_ref), integer(row.recipient_config_version), keyring),
      integer(row.attempts), integer(row.reminder_ordinal), timestamp(nowIso),
    );
  }
  return rows.length;
}

export interface ClaimedOwnerAlert {
  readonly row: {
    readonly idempotencyKey: string;
    readonly eventKey: string;
    readonly operationId: number;
    readonly reason: OwnerAlertReason;
    readonly episode: number;
    readonly reminderOrdinal: number;
    readonly recipientRef: string;
    readonly recipientConfigVersion: number;
    readonly keyVersion: number;
    readonly nonce: Buffer;
    readonly ciphertext: Buffer;
    readonly tag: Buffer;
  };
  readonly attempts: number;
  readonly leaseToken: string;
  readonly recipientHmac: string;
  readonly shouldAttemptDelivery: boolean;
  readonly keyAvailable: boolean;
  readonly budgetExhausted: boolean;
}

interface OutboxRow extends Row {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function bufferField(value: unknown): Buffer {
  if (!(value instanceof Buffer) || value.length === 0) {
    throw new WalletError("INVARIANT_FAILED");
  }
  return value;
}

/* Leased claim over due pending rows and sending rows whose lease expired —
   an abandoned send is always reclaimable. Rows whose binding mismatches the
   current config are invisible here (reconcile quarantines them). A notice
   whose event resolved or was ACKed claims stale: no attempt budget spent,
   no transport call. */
export function claimOwnerAlert(
  db: DatabaseConnection,
  policy: OwnerAlertPolicy,
  config: OwnerAlertConfig,
  keyring: TokenHmacKeyring,
  nowIso: string,
  randomSource: (size: number) => Buffer = (size) => randomBytes(size),
): ClaimedOwnerAlert | null {
  const now = timestamp(nowIso);
  const leaseUntil = new Date(Date.parse(now) + policy.leaseMs).toISOString();
  const claim = db.transaction(() => {
    const row = db.prepare(
      `SELECT idempotency_key,event_key,operation_id,reason,episode,reminder_ordinal,
              recipient_ref,recipient_config_version,key_version,nonce,ciphertext,tag,attempts,status
         FROM owner_alert_outbox
        WHERE ((status='pending' AND next_attempt_at <= ?)
            OR (status='sending' AND leased_until IS NOT NULL AND leased_until <= ?))
          AND recipient_ref = ? AND recipient_config_version = ?
        ORDER BY CASE WHEN status='pending' THEN next_attempt_at ELSE leased_until END,
                 created_at, idempotency_key
        LIMIT 1`,
    ).all(now, now, config.recipientRef, integer(config.recipientConfigVersion))[0] as
      OutboxRow | undefined;
    if (row === undefined) return null;
    const parsed = {
      idempotencyKey: text(row.idempotency_key),
      eventKey: text(row.event_key),
      operationId: integer(row.operation_id),
      reason: text(row.reason) as OwnerAlertReason,
      episode: integer(row.episode),
      reminderOrdinal: integer(row.reminder_ordinal),
      recipientRef: text(row.recipient_ref),
      recipientConfigVersion: integer(row.recipient_config_version),
      keyVersion: integer(row.key_version),
      nonce: bufferField(row.nonce),
      ciphertext: bufferField(row.ciphertext),
      tag: bufferField(row.tag),
    };
    const leaseToken = randomSource(24).toString("base64url");
    /* A row whose stored key_version is absent from this keyring is a config
       fault: it must pause for explicit handling, not spend attempt budget. */
    const keyAvailable = keyring.keys[String(parsed.keyVersion)] !== undefined;
    /* An abandoned 'sending' row whose lease expired at the attempt ceiling
       has already consumed its whole budget — reclaim it WITHOUT another
       increment so the dispatcher can close it as dead_letter (send result
       unknown) instead of issuing an over-budget send. */
    const budgetExhausted = text(row.status) === "sending"
      && integer(row.attempts) >= policy.maxAttempts;
    const shouldAttempt = isCurrentAlert(db, parsed.eventKey) && keyAvailable && !budgetExhausted;
    const result = db.prepare(
      `UPDATE owner_alert_outbox
          SET status='sending', attempts=attempts+?, leased_until=?, lease_token=?, updated_at=?
        WHERE idempotency_key=?
          AND ((status='pending' AND next_attempt_at <= ?)
            OR (status='sending' AND leased_until <= ?))`,
    ).run(shouldAttempt ? 1 : 0, leaseUntil, leaseToken, now,
      parsed.idempotencyKey, now, now);
    if (result.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    return {
      row: parsed,
      attempts: integer(row.attempts) + (shouldAttempt ? 1 : 0),
      leaseToken,
      recipientHmac: ownerAlertRecipientHmac(
        parsed.recipientRef, parsed.recipientConfigVersion, keyring,
      ),
      shouldAttemptDelivery: shouldAttempt,
      keyAvailable,
      budgetExhausted,
    };
  });
  return claim.immediate();
}

export type OwnerAlertAuditOutcome =
  "sent" | "failed" | "unknown" | "dead_letter";

/* Verifies lease ownership, records the audit row, removes the outbox slot.
   'sent' = transport accepted only — never delivered/read — and the FIRST
   persisted acceptance is the one and only reminder anchor. */
export function finalizeOwnerAlert(
  db: DatabaseConnection,
  claimed: ClaimedOwnerAlert,
  outcome: OwnerAlertAuditOutcome,
  detail: string | null,
  atIso: string,
): boolean {
  const finalize = db.transaction(() => {
    const owned = one(
      db,
      `SELECT idempotency_key FROM owner_alert_outbox
        WHERE idempotency_key=? AND status='sending' AND lease_token=? AND attempts=?`,
      claimed.row.idempotencyKey, claimed.leaseToken, claimed.attempts,
    );
    if (owned === null) return false;
    db.prepare(
      `INSERT INTO owner_alert_audit
         (idempotency_key,event_key,recipient_hmac,outcome,detail,final_attempts,reminder_ordinal,recorded_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      claimed.row.idempotencyKey, claimed.row.eventKey, claimed.recipientHmac,
      outcome, detail, claimed.attempts, claimed.row.reminderOrdinal, timestamp(atIso),
    );
    const deleted = db.prepare(
      `DELETE FROM owner_alert_outbox
        WHERE idempotency_key=? AND status='sending' AND lease_token=? AND attempts=?`,
    ).run(claimed.row.idempotencyKey, claimed.leaseToken, claimed.attempts);
    if (deleted.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    if (outcome === "sent") {
      db.prepare(
        "UPDATE owner_alert_events SET first_notice_accepted_at=COALESCE(first_notice_accepted_at,?) WHERE event_key=?",
      ).run(timestamp(atIso), claimed.row.eventKey);
    }
    return true;
  });
  return finalize.immediate();
}

/* Lease-verified quarantine for a claimed row that cannot proceed for a
   configuration reason (e.g. its key_version is absent from the keyring).
   The row is kept with status 'quarantined' — visible in the projection,
   never claimed again, never delivered to a fallback. */
export function quarantineClaimedOwnerAlert(
  db: DatabaseConnection,
  claimed: ClaimedOwnerAlert,
  detail: string,
  atIso: string,
): boolean {
  const txn = db.transaction(() => {
    const owned = one(
      db,
      `SELECT idempotency_key FROM owner_alert_outbox
        WHERE idempotency_key=? AND status='sending' AND lease_token=? AND attempts=?`,
      claimed.row.idempotencyKey, claimed.leaseToken, claimed.attempts,
    );
    if (owned === null) return false;
    db.prepare(
      `INSERT INTO owner_alert_audit
         (idempotency_key,event_key,recipient_hmac,outcome,detail,final_attempts,reminder_ordinal,recorded_at)
       VALUES (?,?,?,'quarantined',?,?,?,?)`,
    ).run(
      claimed.row.idempotencyKey, claimed.row.eventKey, claimed.recipientHmac,
      detail, claimed.attempts, claimed.row.reminderOrdinal, timestamp(atIso),
    );
    const parked = db.prepare(
      `UPDATE owner_alert_outbox
          SET status='quarantined', leased_until=NULL, lease_token=NULL, updated_at=?
        WHERE idempotency_key=? AND status='sending' AND lease_token=? AND attempts=?`,
    ).run(timestamp(atIso), claimed.row.idempotencyKey, claimed.leaseToken, claimed.attempts);
    if (parked.changes !== 1) throw new WalletError("INVARIANT_FAILED");
    return true;
  });
  return txn.immediate();
}

export function scheduleOwnerAlertRetry(
  db: DatabaseConnection,
  claimed: ClaimedOwnerAlert,
  policy: OwnerAlertPolicy,
  nowIso: string,
): boolean {
  const delay = policy.retryDelayMs(claimed.attempts);
  if (!Number.isSafeInteger(delay) || delay < 0) throw new WalletError("INVARIANT_FAILED");
  const now = timestamp(nowIso);
  const next = new Date(Date.parse(now) + delay).toISOString();
  const result = db.prepare(
    `UPDATE owner_alert_outbox
        SET status='pending', next_attempt_at=?, leased_until=NULL, lease_token=NULL, updated_at=?
      WHERE idempotency_key=? AND status='sending' AND lease_token=? AND attempts=?`,
  ).run(next, now, claimed.row.idempotencyKey, claimed.leaseToken, claimed.attempts);
  return result.changes === 1;
}

/* Independently supported delivery observation (provider receipt). Distinct
   from 'sent' (transport accepted) and from owner ACK; requires a prior
   accepted notice for this idempotency key, replay-safe. */
export function recordOwnerAlertDelivery(
  db: DatabaseConnection,
  mode: "TEST_ONLY",
  idempotencyKey: string,
  atIso: string,
): "DELIVERED" | "REPLAY" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const sent = db.prepare(
      `SELECT event_key,recipient_hmac,reminder_ordinal FROM owner_alert_audit
        WHERE idempotency_key=? AND outcome='sent' ORDER BY id DESC LIMIT 1`,
    ).all(idempotencyKey)[0] as Row | undefined;
    if (sent === undefined) throw new WalletError("INVALID_STATE");
    const dup = one(
      db,
      "SELECT id FROM owner_alert_audit WHERE idempotency_key=? AND outcome='delivered'",
      idempotencyKey,
    );
    if (dup !== null) return "REPLAY";
    db.prepare(
      `INSERT INTO owner_alert_audit
         (idempotency_key,event_key,recipient_hmac,outcome,detail,final_attempts,reminder_ordinal,recorded_at)
       VALUES (?,?,?,'delivered','provider_receipt',0,?,?)`,
    ).run(
      idempotencyKey, text(sent.event_key), text(sent.recipient_hmac),
      integer(sent.reminder_ordinal), timestamp(atIso),
    );
    return "DELIVERED";
  });
}

export interface OwnerAlertAckInput {
  readonly eventKey: string;
  readonly actorRole: string;
  readonly recipientRef: string;
  readonly recipientConfigVersion: number;
}

/* Guarded synthetic owner ACK: bound to the exact intended event (case +
   episode) and the recipient binding recorded on it. Wrong role, wrong
   version or wrong case refuses. ACK marks only owner handling — it is not a
   business resolution, fulfillment confirmation or funds disposition, and it
   can never hide a still-unresolved case (see the case view). */
export function recordOwnerAlertAck(
  db: DatabaseConnection,
  mode: "TEST_ONLY",
  ack: OwnerAlertAckInput,
  atIso: string,
): "ACKED" | "REPLAY" {
  return write(db, () => {
    if (mode !== "TEST_ONLY") throw new WalletError("EXECUTION_DISABLED");
    const event = one(
      db,
      `SELECT owner_ack_at,recipient_ref,recipient_config_version
         FROM owner_alert_events WHERE event_key=?`,
      ack.eventKey,
    );
    if (event === null) throw new WalletError("NOT_FOUND");
    if (ack.actorRole !== "HUMAN_OWNER") throw new WalletError("ACK_FORBIDDEN");
    if (
      ack.recipientRef !== text(event.recipient_ref) ||
      ack.recipientConfigVersion !== integer(event.recipient_config_version)
    ) {
      throw new WalletError("ACK_FORBIDDEN");
    }
    if (event.owner_ack_at !== null) return "REPLAY";
    db.prepare(
      "UPDATE owner_alert_events SET owner_ack_at=? WHERE event_key=? AND owner_ack_at IS NULL",
    ).run(timestamp(atIso), ack.eventKey);
    return "ACKED";
  });
}
