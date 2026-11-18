import type { DatabaseConnection } from "../db.js";
import { normalizeMonitorTargetKey } from "./target-catalog.js";

export type AccountMonitorSelectionFailure =
  | "no_eligible_service"
  | "monitor_unbound";

export class AccountMonitorSelectionError extends Error {
  readonly code: AccountMonitorSelectionFailure;

  constructor(code: AccountMonitorSelectionFailure) {
    super(code);
    this.name = "AccountMonitorSelectionError";
    this.code = code;
  }
}

export interface AccountMonitorSelection {
  readonly key: string;
}

interface SelectionRow {
  readonly service_id: unknown;
  readonly position: unknown;
  readonly monitor_target_key: unknown;
}

/* The selector intentionally accepts only the authenticated principal's user ID
   and the database dependency. Ownership, paid/open state, and ordering remain
   inside the SQL statement; callers cannot provide or influence a target. */
export function selectAccountMonitorTarget(
  database: DatabaseConnection,
  userId: number,
): AccountMonitorSelection {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error("Account monitor principal is invalid");
  }

  const rows = database
    .prepare(
      `SELECT services.id AS service_id,
              service_delivery_items.position,
              service_delivery_items.monitor_target_key
       FROM services
       JOIN payments ON payments.id = services.payment_id
       JOIN orders ON orders.id = payments.order_id
       LEFT JOIN service_delivery_items
         ON service_delivery_items.service_id = services.id
       WHERE orders.user_id = ?
         AND orders.status = 'paid'
         AND payments.status = 'paid'
         AND services.status = 'open'
       ORDER BY services.id DESC, service_delivery_items.position ASC`,
    )
    .all(userId) as SelectionRow[];

  if (rows.length === 0) {
    throw new AccountMonitorSelectionError("no_eligible_service");
  }

  for (const row of rows) {
    if (
      typeof row.service_id !== "number" ||
      !Number.isSafeInteger(row.service_id) ||
      row.service_id < 1 ||
      !(
        row.position === null ||
        (typeof row.position === "number" &&
          Number.isSafeInteger(row.position) &&
          row.position > 0)
      )
    ) {
      throw new Error("Account monitor selection invariant failed");
    }
    if (row.monitor_target_key === null) continue;
    const key = normalizeMonitorTargetKey(row.monitor_target_key);
    if (key === null || row.position === null) {
      throw new Error("Account monitor selection invariant failed");
    }
    return Object.freeze({ key });
  }

  throw new AccountMonitorSelectionError("monitor_unbound");
}
