import type { DatabaseConnection } from "../db.js";
import { WalletError, integer, text } from "../wallet/candidate.js";

/* TEST_ONLY modeled owner-alert notification (LOCAL synthetic). Every entry
   point is inert unless called with mode "TEST_ONLY": no server registration,
   real mail transport, interval/scheduler, webhook, admin/public API, Auth or
   live config is implied. The recipient is a privately configured HUMAN OWNER
   role — never the service customer, never an address derived from accounts
   or chats; the address itself is injected only for synthetic transport. */

export type OwnerAlertReason = "DISPATCH_UNKNOWN" | "CONTRADICTION";

export const OWNER_ALERT_MAX_ATTEMPTS = 6;
/* Six total attempts => five gaps: 5m, 15m, 1h, 4h, 8h. */
export const OWNER_ALERT_RETRY_DELAYS_MS: readonly number[] = [
  5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000, 8 * 60 * 60 * 1000,
];
export const OWNER_ALERT_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;
export const OWNER_ALERT_MAX_REMINDER_ORDINAL = 1;
export const OWNER_ALERT_DEFAULT_LEASE_MS = 60 * 1000;

export interface OwnerAlertConfig {
  /** Logical role ref such as "HUMAN_OWNER" — never an address. */
  readonly recipientRef: string;
  readonly recipientConfigVersion: number;
  /** Synthetic recipient injected for the fake transport only. */
  readonly toEmail: string;
  readonly maxAttempts: number;
  /** Exactly maxAttempts - 1 gaps between attempts. */
  readonly retryDelaysMs: readonly number[];
  readonly leaseMs: number;
  readonly reminderDelayMs: number;
}

export interface OwnerAlertPolicy {
  readonly leaseMs: number;
  readonly maxAttempts: number;
  retryDelayMs(attempts: number): number;
}

export function validateOwnerAlertConfig(config: OwnerAlertConfig): OwnerAlertConfig {
  if (
    typeof config.recipientRef !== "string" || config.recipientRef.length === 0 ||
    config.recipientRef.includes("@")
  ) {
    throw new WalletError("ALERT_CONFIG_INVALID");
  }
  if (!Number.isSafeInteger(config.recipientConfigVersion) || config.recipientConfigVersion < 0) {
    throw new WalletError("ALERT_CONFIG_INVALID");
  }
  if (typeof config.toEmail !== "string" || config.toEmail.length === 0) {
    throw new WalletError("ALERT_CONFIG_INVALID");
  }
  if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1) {
    throw new WalletError("ALERT_CONFIG_INVALID");
  }
  if (!Number.isSafeInteger(config.leaseMs) || config.leaseMs <= 0) {
    throw new WalletError("ALERT_CONFIG_INVALID");
  }
  if (!Number.isSafeInteger(config.reminderDelayMs) || config.reminderDelayMs <= 0) {
    throw new WalletError("ALERT_CONFIG_INVALID");
  }
  if (
    !Array.isArray(config.retryDelaysMs) ||
    config.retryDelaysMs.length !== config.maxAttempts - 1 ||
    config.retryDelaysMs.some((d) => !Number.isSafeInteger(d) || d < 0)
  ) {
    throw new WalletError("ALERT_CONFIG_INVALID");
  }
  return config;
}

export function defaultOwnerAlertConfig(
  toEmail: string,
  overrides: Partial<OwnerAlertConfig> = {},
): OwnerAlertConfig {
  return validateOwnerAlertConfig({
    recipientRef: "HUMAN_OWNER",
    recipientConfigVersion: 1,
    toEmail,
    maxAttempts: OWNER_ALERT_MAX_ATTEMPTS,
    retryDelaysMs: OWNER_ALERT_RETRY_DELAYS_MS,
    leaseMs: OWNER_ALERT_DEFAULT_LEASE_MS,
    reminderDelayMs: OWNER_ALERT_REMINDER_DELAY_MS,
    ...overrides,
  });
}

/* attempt n (1-based, just failed) -> delay before attempt n+1. */
export function createOwnerAlertPolicy(config: OwnerAlertConfig): OwnerAlertPolicy {
  const delays = config.retryDelaysMs;
  return {
    leaseMs: config.leaseMs,
    maxAttempts: config.maxAttempts,
    retryDelayMs: (attempts: number): number =>
      delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)] ?? 0,
  };
}

type Row = Record<string, unknown>;

/** Opaque case locator inside the redacted payload — internal id only. */
export function ownerAlertCaseRef(operationId: number): string {
  return `renewal-op:${integer(operationId)}`;
}

export interface OwnerAlertCaseView {
  readonly eventKey: string;
  readonly operationId: number;
  readonly reason: OwnerAlertReason;
  readonly episode: number;
  readonly anchorAt: string;
  readonly dueAt: string;
  readonly firstNoticeAcceptedAt: string | null;
  readonly ownerAckAt: string | null;
  readonly recipientRef: string;
  readonly recipientConfigVersion: number;
  readonly unresolved: boolean;
  readonly noticesInFlight: number;
  readonly noticesQuarantined: number;
  readonly noticesAccepted: number;
  readonly noticesDelivered: number;
  readonly deadLetters: number;
  readonly lastAuditAt: string | null;
}

/* Persistent LOCAL read-only case projection over owner_alert_case_view. */
export function readOwnerAlertCases(db: DatabaseConnection): readonly OwnerAlertCaseView[] {
  const rows = db
    .prepare("SELECT * FROM owner_alert_case_view ORDER BY due_at ASC, event_key ASC")
    .all() as Row[];
  return rows.map((r) => ({
    eventKey: text(r.event_key),
    operationId: integer(r.operation_id),
    reason: text(r.reason) as OwnerAlertReason,
    episode: integer(r.episode),
    anchorAt: text(r.anchor_at),
    dueAt: text(r.due_at),
    firstNoticeAcceptedAt: r.first_notice_accepted_at === null ? null : text(r.first_notice_accepted_at),
    ownerAckAt: r.owner_ack_at === null ? null : text(r.owner_ack_at),
    recipientRef: text(r.recipient_ref),
    recipientConfigVersion: integer(r.recipient_config_version),
    unresolved: integer(r.unresolved) === 1,
    noticesInFlight: integer(r.notices_in_flight),
    noticesQuarantined: integer(r.notices_quarantined),
    noticesAccepted: integer(r.notices_accepted),
    noticesDelivered: integer(r.notices_delivered),
    deadLetters: integer(r.dead_letters),
    lastAuditAt: r.last_audit_at === null ? null : text(r.last_audit_at),
  }));
}
