import type { DatabaseConnection } from "../db.js";

export type PaymentTransitionResult =
  | "finalized"
  | "idempotent_replay"
  | "accepted_pending"
  | "ignored_paid"
  | "rejected";

export interface PaymentEventInput {
  readonly outTradeNo: string;
  readonly tradeNo: string;
  readonly tradeStatus: string;
  readonly totalAmount: string;
  readonly totalAmountFen: number;
  readonly appId: string;
  readonly sellerId: string;
  readonly notification?: {
    readonly notifyId: string;
    readonly payloadHash: string | null;
  };
}

export interface PaymentStateDependencies {
  readonly database: DatabaseConnection;
  readonly appId: string;
  readonly sellerId: string;
  readonly now?: () => Date;
}

interface PaymentRow {
  readonly id: number;
  readonly order_id: number;
  readonly amount_fen: number;
  readonly app_id: string;
  readonly status: "pending" | "paid" | "closed";
  readonly trade_no: string | null;
  readonly close_reason: string | null;
  readonly paid_at: string | null;
  readonly closed_at: string | null;
}

interface NotificationRow {
  readonly payment_id: number;
  readonly out_trade_no: string;
  readonly trade_no: string;
  readonly trade_status: string;
  readonly total_amount: string;
  readonly payload_hash: string | null;
}

function oneRow(rows: unknown[]): Record<string, unknown> | null {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error("Payment database invariant failed");
  }
  return rows[0] as Record<string, unknown>;
}

function readPayment(
  database: DatabaseConnection,
  outTradeNo: string,
): PaymentRow | null {
  const row = oneRow(
    database
      .prepare(
        `SELECT id, order_id, amount_fen, app_id, status, trade_no,
                close_reason, paid_at, closed_at
         FROM payments WHERE out_trade_no = ?`,
      )
      .all(outTradeNo),
  );
  if (row === null) {
    return null;
  }
  if (
    typeof row.id !== "number" ||
    typeof row.order_id !== "number" ||
    typeof row.amount_fen !== "number" ||
    typeof row.app_id !== "string" ||
    (row.status !== "pending" && row.status !== "paid" && row.status !== "closed") ||
    (row.trade_no !== null && typeof row.trade_no !== "string") ||
    (row.close_reason !== null && typeof row.close_reason !== "string") ||
    (row.paid_at !== null && typeof row.paid_at !== "string") ||
    (row.closed_at !== null && typeof row.closed_at !== "string")
  ) {
    throw new Error("Payment database invariant failed");
  }
  return row as unknown as PaymentRow;
}

function readNotification(
  database: DatabaseConnection,
  notifyId: string,
): NotificationRow | null {
  const row = oneRow(
    database
      .prepare(
        `SELECT payment_id, out_trade_no, trade_no, trade_status,
                total_amount, payload_hash
         FROM payment_notifications WHERE notify_id = ?`,
      )
      .all(notifyId),
  );
  if (row === null) {
    return null;
  }
  if (
    typeof row.payment_id !== "number" ||
    typeof row.out_trade_no !== "string" ||
    typeof row.trade_no !== "string" ||
    typeof row.trade_status !== "string" ||
    typeof row.total_amount !== "string" ||
    (row.payload_hash !== null && typeof row.payload_hash !== "string")
  ) {
    throw new Error("Payment notification invariant failed");
  }
  return row as unknown as NotificationRow;
}

function audit(
  database: DatabaseConnection,
  action: string,
  targetRef: string,
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO audit_log (actor, action, target_ref, created_at)
       VALUES ('alipay', ?, ?, ?)`,
    )
    .run(action, targetRef, now);
}

function serviceExists(database: DatabaseConnection, paymentId: number): boolean {
  return (
    database.prepare("SELECT id FROM services WHERE payment_id = ?").all(paymentId)
      .length === 1
  );
}

function duplicateNotificationResult(
  database: DatabaseConnection,
  payment: PaymentRow,
  input: PaymentEventInput,
  existing: NotificationRow,
  now: string,
): PaymentTransitionResult {
  const matches =
    existing.payment_id === payment.id &&
    existing.out_trade_no === input.outTradeNo &&
    existing.trade_no === input.tradeNo &&
    existing.trade_status === input.tradeStatus &&
    existing.total_amount === input.totalAmount &&
    existing.payload_hash === (input.notification?.payloadHash ?? null);
  if (!matches) {
    audit(database, "payment.notification_mismatch", input.outTradeNo, now);
    return "rejected";
  }

  const stateConsistent =
    input.tradeStatus === "WAIT_BUYER_PAY" ||
    (input.tradeStatus === "TRADE_CLOSED" &&
      (payment.status === "closed" || payment.status === "paid")) ||
    ((input.tradeStatus === "TRADE_SUCCESS" ||
      input.tradeStatus === "TRADE_FINISHED") &&
      payment.status === "paid" &&
      serviceExists(database, payment.id));
  if (!stateConsistent) {
    audit(database, "payment.notification_state_mismatch", input.outTradeNo, now);
    return "rejected";
  }
  return "idempotent_replay";
}

function validateEvent(
  database: DatabaseConnection,
  dependencies: PaymentStateDependencies,
  payment: PaymentRow | null,
  input: PaymentEventInput,
  now: string,
): payment is PaymentRow {
  const matches =
    payment !== null &&
    input.appId === dependencies.appId &&
    input.sellerId === dependencies.sellerId &&
    payment.app_id === dependencies.appId &&
    input.totalAmountFen === payment.amount_fen &&
    (payment.trade_no === null || payment.trade_no === input.tradeNo);
  if (!matches) {
    audit(database, "payment.event_rejected", input.outTradeNo, now);
  }
  return matches;
}

function insertNotification(
  database: DatabaseConnection,
  paymentId: number,
  input: PaymentEventInput,
  now: string,
): void {
  if (input.notification === undefined) {
    return;
  }
  database
    .prepare(
      `INSERT INTO payment_notifications (
         notify_id, payment_id, out_trade_no, trade_no, trade_status,
         total_amount, payload_hash, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.notification.notifyId,
      paymentId,
      input.outTradeNo,
      input.tradeNo,
      input.tradeStatus,
      input.totalAmount,
      input.notification.payloadHash,
      now,
    );
}

function beginEvent(
  database: DatabaseConnection,
  dependencies: PaymentStateDependencies,
  input: PaymentEventInput,
  now: string,
): { readonly payment: PaymentRow; readonly duplicate: PaymentTransitionResult | null } | null {
  const payment = readPayment(database, input.outTradeNo);
  if (!validateEvent(database, dependencies, payment, input, now)) {
    return null;
  }
  if (input.notification !== undefined) {
    const existing = readNotification(database, input.notification.notifyId);
    if (existing !== null) {
      return {
        payment,
        duplicate: duplicateNotificationResult(database, payment, input, existing, now),
      };
    }
  }
  return { payment, duplicate: null };
}

function nowIso(dependencies: PaymentStateDependencies): string {
  const value = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Payment time source is invalid");
  }
  return value.toISOString();
}

export function finalizePaid(
  dependencies: PaymentStateDependencies,
  input: PaymentEventInput,
): PaymentTransitionResult {
  const operation = dependencies.database.transaction(() => {
    const now = nowIso(dependencies);
    if (
      input.tradeStatus !== "TRADE_SUCCESS" &&
      input.tradeStatus !== "TRADE_FINISHED"
    ) {
      audit(dependencies.database, "payment.invalid_paid_event", input.outTradeNo, now);
      return "rejected" as const;
    }
    const started = beginEvent(
      dependencies.database,
      dependencies,
      input,
      now,
    );
    if (started === null) {
      return "rejected" as const;
    }
    if (started.duplicate !== null) {
      return started.duplicate;
    }

    const { payment } = started;
    if (payment.status === "paid") {
      if (payment.trade_no !== input.tradeNo || !serviceExists(dependencies.database, payment.id)) {
        audit(dependencies.database, "payment.finalize_mismatch", input.outTradeNo, now);
        return "rejected" as const;
      }
      insertNotification(dependencies.database, payment.id, input, now);
      dependencies.database
        .prepare(
          `UPDATE payments SET alipay_trade_status = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.tradeStatus, now, payment.id);
      return "idempotent_replay" as const;
    }

    dependencies.database
      .prepare(
        `UPDATE payments
         SET status = 'paid', trade_no = ?, alipay_trade_status = ?,
             paid_at = ?, closed_at = NULL, close_reason = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.tradeNo, input.tradeStatus, now, now, payment.id);
    dependencies.database
      .prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?")
      .run(now, payment.order_id);
    dependencies.database
      .prepare(
        `INSERT INTO services (
           payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at
         ) VALUES (?, 'pending_open', NULL, NULL, ?, ?)`,
      )
      .run(payment.id, now, now);
    insertNotification(dependencies.database, payment.id, input, now);
    return "finalized" as const;
  });
  return operation.immediate();
}

export function finalizeClosed(
  dependencies: PaymentStateDependencies,
  input: PaymentEventInput,
): PaymentTransitionResult {
  const operation = dependencies.database.transaction(() => {
    const now = nowIso(dependencies);
    if (input.tradeStatus !== "TRADE_CLOSED") {
      audit(dependencies.database, "payment.invalid_closed_event", input.outTradeNo, now);
      return "rejected" as const;
    }
    const started = beginEvent(
      dependencies.database,
      dependencies,
      input,
      now,
    );
    if (started === null) {
      return "rejected" as const;
    }
    if (started.duplicate !== null) {
      return started.duplicate;
    }

    const { payment } = started;
    if (payment.status === "paid") {
      insertNotification(dependencies.database, payment.id, input, now);
      audit(dependencies.database, "payment.late_close_ignored", input.outTradeNo, now);
      return "ignored_paid" as const;
    }
    if (payment.status === "closed") {
      insertNotification(dependencies.database, payment.id, input, now);
      return "idempotent_replay" as const;
    }

    dependencies.database
      .prepare(
        `UPDATE payments
         SET status = 'closed', trade_no = ?, alipay_trade_status = 'TRADE_CLOSED',
             close_reason = 'alipay_trade_closed', closed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.tradeNo, now, now, payment.id);
    dependencies.database
      .prepare("UPDATE orders SET status = 'closed', updated_at = ? WHERE id = ?")
      .run(now, payment.order_id);
    insertNotification(dependencies.database, payment.id, input, now);
    return "finalized" as const;
  });
  return operation.immediate();
}

export function acceptPendingPaymentEvent(
  dependencies: PaymentStateDependencies,
  input: PaymentEventInput,
): PaymentTransitionResult {
  const operation = dependencies.database.transaction(() => {
    const now = nowIso(dependencies);
    if (input.tradeStatus !== "WAIT_BUYER_PAY") {
      audit(dependencies.database, "payment.invalid_pending_event", input.outTradeNo, now);
      return "rejected" as const;
    }
    const started = beginEvent(
      dependencies.database,
      dependencies,
      input,
      now,
    );
    if (started === null) {
      return "rejected" as const;
    }
    if (started.duplicate !== null) {
      return started.duplicate;
    }

    insertNotification(dependencies.database, started.payment.id, input, now);
    if (started.payment.status === "pending") {
      dependencies.database
        .prepare(
          `UPDATE payments
           SET trade_no = ?, alipay_trade_status = 'WAIT_BUYER_PAY', updated_at = ?
           WHERE id = ?`,
        )
        .run(input.tradeNo, now, started.payment.id);
    }
    return "accepted_pending" as const;
  });
  return operation.immediate();
}

export function auditPaymentFailure(
  dependencies: Pick<PaymentStateDependencies, "database" | "now">,
  action: string,
  targetRef: string,
): void {
  const operation = dependencies.database.transaction(() => {
    const now = nowIso({
      database: dependencies.database,
      appId: "",
      sellerId: "",
      now: dependencies.now,
    });
    audit(dependencies.database, action, targetRef, now);
  });
  operation.immediate();
}
