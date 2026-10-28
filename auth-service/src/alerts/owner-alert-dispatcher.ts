import { randomBytes } from "node:crypto";
import type { DatabaseConnection } from "../db.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import type { OwnerAlertConfig, OwnerAlertPolicy } from "./owner-alert-runtime.js";
import {
  claimOwnerAlert, decryptOwnerAlertPayload, finalizeOwnerAlert,
  quarantineClaimedOwnerAlert, scheduleOwnerAlertRetry,
} from "./owner-alert-outbox.js";
import type {
  OwnerAlertDelivery, OwnerAlertSendOutcome, OwnerAlertTransport,
} from "./owner-alert-transport.js";

/* TEST_ONLY owner-alert dispatcher — claim a leased notice, decrypt its
   redacted payload, call the injected synthetic transport, then finalize or
   schedule the next attempt inside the fixed 6-attempt budget (gaps
   5m/15m/1h/4h/8h). It is an injected-tick loop primitive only: no interval,
   scheduler or server wiring exists. Nothing dispatched here can cause
   supplier, money, service, redispatch, release, refund or compensation
   effects — the delivery record is notification bookkeeping only. */

export interface OwnerAlertDispatcherDependencies {
  readonly database: DatabaseConnection;
  readonly keyring: TokenHmacKeyring;
  readonly transport: OwnerAlertTransport;
  readonly policy: OwnerAlertPolicy;
  readonly config: OwnerAlertConfig;
  readonly now?: () => string;
  readonly randomBytes?: (size: number) => Buffer;
}

export type OwnerAlertDispatchResult =
  { readonly outcome: "idle" } |
  {
    readonly outcome:
      "sent" | "retry_scheduled" | "dead_letter" | "stale" | "lease_lost" | "quarantined";
    readonly attempts: number;
  };

export async function dispatchNextOwnerAlert(
  deps: OwnerAlertDispatcherDependencies,
): Promise<OwnerAlertDispatchResult> {
  const nowSource = deps.now ?? (() => new Date().toISOString());
  const randomSource = deps.randomBytes ?? ((size: number) => randomBytes(size));
  const db = deps.database;

  const claimed = claimOwnerAlert(
    db, deps.policy, deps.config, deps.keyring, nowSource(), randomSource,
  );
  if (claimed === null) return { outcome: "idle" };

  /* An abandoned send reclaimed at the attempt ceiling: the sixth send's
     result is unknowable, the budget is spent — close as dead_letter
     WITHOUT a seventh transport call. */
  if (claimed.budgetExhausted) {
    return finalizeOwnerAlert(db, claimed, "dead_letter", "send_unknown", nowSource())
      ? { outcome: "dead_letter", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }

  /* The stored key_version is absent from this keyring — a configuration
     fault. Quarantine for explicit handling: zero attempt budget spent, no
     transport call, no recipient fallback, never silently retried away. */
  if (!claimed.keyAvailable) {
    return quarantineClaimedOwnerAlert(db, claimed, "key_unavailable", nowSource())
      ? { outcome: "quarantined", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }

  /* The event resolved or was ACKed after enqueue — drop the notice without
     spending an attempt and without calling the transport. */
  if (!claimed.shouldAttemptDelivery) {
    return finalizeOwnerAlert(db, claimed, "failed", "stale", nowSource())
      ? { outcome: "stale", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }

  /* Decrypt/build/send failures all collapse to UNKNOWN: a corrupt stored
     payload is un-sendable like an un-answerable transport — bounded by the
     same attempt budget instead of wedging the row in 'sending'. */
  let sendOutcome: OwnerAlertSendOutcome;
  try {
    const payload = decryptOwnerAlertPayload({
      idempotencyKey: claimed.row.idempotencyKey,
      eventKey: claimed.row.eventKey,
      keyVersion: claimed.row.keyVersion,
      nonce: claimed.row.nonce,
      ciphertext: claimed.row.ciphertext,
      tag: claimed.row.tag,
    }, deps.keyring);
    const delivery: OwnerAlertDelivery = {
      idempotencyKey: claimed.row.idempotencyKey,
      eventKey: claimed.row.eventKey,
      caseRef: payload.case_ref,
      reason: payload.reason,
      episode: claimed.row.episode,
      reminderOrdinal: claimed.row.reminderOrdinal,
      anchorAt: payload.anchor_at,
      dueAt: payload.due_at,
      recipientRef: claimed.row.recipientRef,
      recipient: deps.config.toEmail,
    };
    const result = await deps.transport.send(delivery);
    sendOutcome =
      result === "ACCEPTED" || result === "FAILED" || result === "UNKNOWN"
        ? result
        : "UNKNOWN";
  } catch {
    sendOutcome = "UNKNOWN";
  }

  const at = nowSource();
  if (sendOutcome === "ACCEPTED") {
    return finalizeOwnerAlert(db, claimed, "sent", null, at)
      ? { outcome: "sent", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }
  const detail = sendOutcome === "FAILED" ? "transport_failed" : "send_unknown";
  if (claimed.attempts >= deps.policy.maxAttempts) {
    return finalizeOwnerAlert(db, claimed, "dead_letter", detail, at)
      ? { outcome: "dead_letter", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }
  return scheduleOwnerAlertRetry(db, claimed, deps.policy, at)
    ? { outcome: "retry_scheduled", attempts: claimed.attempts }
    : { outcome: "lease_lost", attempts: claimed.attempts };
}
