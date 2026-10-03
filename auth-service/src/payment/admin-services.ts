import type { DatabaseConnection } from "../db.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import { findSellablePlan, PaymentDomainError } from "./commerce.js";
import { decryptGrantDeliveryItem, type EncryptedGrantDeliveryItem } from "./delivery-crypto.js";

/* 管理员管理买家服务（Migration 022）。
   - services.ends_at / plan_override / admin_note 只由这里写入；plan_override 固定为 {"label": string}。
   - admin_grants 是不经订单 / 支付的赠送记录，不伪造订单或支付行。
   - admin_note 与 grants.reason 只出现在管理员视图；买家视图（listMyGrants 与
     orders.ts 的 listMyServices）从 SQL 层就不读取这两列。
   - 每次写入都在同一事务内追加一条 audit_log（actor = 管理员邮箱）。 */

export const ADMIN_LABEL_MAX_LENGTH = 80;
export const ADMIN_NOTE_MAX_LENGTH = 500;
export const ADMIN_USER_QUERY_MAX_LENGTH = 100;
export const ADMIN_USER_SEARCH_LIMIT = 20;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
// Labels are single-line; notes may contain line breaks but no other control characters.
const LABEL_CONTROL = /[\u0000-\u001F\u007F]/;
const NOTE_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/;

export type ParsedField<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false };

/** Strict UTC instant (as produced by Date#toISOString) or null for "long-term". */
export function parseEndsAt(value: unknown): ParsedField<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return { ok: false };
  const date = new Date(value);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 2000 || year > 2100) return { ok: false };
  const normalized = date.toISOString();
  // Reject calendar overflow such as 2026-02-30 that Date would silently roll over.
  if (normalized.slice(0, 19) !== value.slice(0, 19)) return { ok: false };
  return { ok: true, value: normalized };
}

export function parseLabel(value: unknown): ParsedField<string> {
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > ADMIN_LABEL_MAX_LENGTH || LABEL_CONTROL.test(trimmed)) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

/** Optional internal note: null or blank clears it. */
export function parseNote(value: unknown): ParsedField<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length > ADMIN_NOTE_MAX_LENGTH || NOTE_CONTROL.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

/** plan_override is written only as {"label": string}; anything else reads as "no override". */
export function planOverrideLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const label = (parsed as Record<string, unknown>).label;
      return typeof label === "string" && label.trim() !== "" ? label : null;
    }
  } catch {
    // fall through
  }
  return null;
}

function asRow(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} database invariant failed`);
  }
  return value as Record<string, unknown>;
}

function text(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error("Admin service database invariant failed");
  return value;
}

function nullableText(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Admin service database invariant failed");
  return value;
}

function integer(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Admin service database invariant failed");
  }
  return value;
}

function nowIso(now: (() => Date) | undefined): string {
  const date = (now ?? (() => new Date()))();
  if (!Number.isFinite(date.getTime())) throw new Error("Admin service time source is invalid");
  return date.toISOString();
}

function audit(database: DatabaseConnection, actor: string, action: string, targetRef: string, at: string): void {
  database
    .prepare("INSERT INTO audit_log (actor, action, target_ref, created_at) VALUES (?, ?, ?, ?)")
    .run(actor, action, targetRef, at);
}

export interface AdminUserSummary {
  readonly id: number;
  readonly email: string;
  readonly role: "user" | "admin";
  readonly status: "active" | "disabled";
  readonly createdAt: string;
}

/** Case-insensitive email substring search; LIKE wildcards in the query are matched literally. */
export function searchUsersForAdmin(database: DatabaseConnection, query: string): AdminUserSummary[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > ADMIN_USER_QUERY_MAX_LENGTH || LABEL_CONTROL.test(trimmed)) {
    throw new PaymentDomainError(400, "invalid_query");
  }
  const pattern = `%${trimmed.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return database
    .prepare(
      `SELECT id, email, role, status, created_at FROM users
       WHERE lower(email) LIKE ? ESCAPE '\\'
       ORDER BY email ASC
       LIMIT ?`,
    )
    .all(pattern, ADMIN_USER_SEARCH_LIMIT)
    .map((value) => {
      const row = asRow(value, "Admin user");
      const role = text(row, "role");
      const status = text(row, "status");
      if ((role !== "user" && role !== "admin") || (status !== "active" && status !== "disabled")) {
        throw new Error("Admin user database invariant failed");
      }
      return { id: integer(row, "id"), email: text(row, "email"), role, status, createdAt: text(row, "created_at") };
    });
}

export interface AdminServiceView {
  readonly id: number;
  readonly orderRef: string;
  readonly amountFen: number;
  readonly orderStatus: string;
  readonly serviceStatus: "pending_open" | "open";
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly createdAt: string;
  readonly openedAt: string | null;
  readonly endsAt: string | null;
  readonly planLabel: string | null;
  readonly adminNote: string | null;
  /** Delivered lines with their VPS binding (null = opened while monitoring was unavailable). */
  readonly deliveryLines: ReadonlyArray<{ readonly position: number; readonly label: string; readonly monitorTargetKey: string | null }>;
}

export interface AdminGrantView {
  readonly id: number;
  readonly userId: number;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly status: "active" | "revoked";
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Catalog selection and nominal value (Migration 023); NULL on gifts created before it. */
  readonly typeId: string | null;
  readonly regionId: string | null;
  readonly ispId: string | null;
  readonly specId: string | null;
  readonly durationId: string | null;
  readonly months: number | null;
  readonly valueFen: number | null;
  readonly deliveryStatus: "pending_open" | "open";
  readonly openedAt: string | null;
  /** Public line names only; subscription URLs are never returned to the admin list. */
  readonly deliveryLines: ReadonlyArray<{ readonly position: number; readonly label: string }>;
}

function nullableInteger(row: Record<string, unknown>, name: string): number | null {
  return row[name] === null ? null : integer(row, name);
}

const ADMIN_SERVICE_COLUMNS = `services.id AS service_id, orders.order_ref, orders.amount_fen,
  orders.status AS order_status, services.status AS service_status,
  orders.type_id, orders.region_id, orders.isp_id, orders.spec_id, orders.duration_id,
  services.created_at, services.opened_at, services.ends_at, services.plan_override, services.admin_note`;

function serviceDeliveryLines(
  database: DatabaseConnection,
  serviceId: number,
): Array<{ position: number; label: string; monitorTargetKey: string | null }> {
  return database
    .prepare("SELECT position, label, monitor_target_key FROM service_delivery_items WHERE service_id = ? ORDER BY position ASC")
    .all(serviceId)
    .map((value) => {
      const row = asRow(value, "Service delivery");
      return { position: integer(row, "position"), label: text(row, "label"), monitorTargetKey: nullableText(row, "monitor_target_key") };
    });
}

function adminServiceView(value: unknown, database?: DatabaseConnection): AdminServiceView {
  const row = asRow(value, "Admin service");
  const serviceStatus = text(row, "service_status");
  if (serviceStatus !== "pending_open" && serviceStatus !== "open") {
    throw new Error("Admin service database invariant failed");
  }
  return {
    id: integer(row, "service_id"),
    orderRef: text(row, "order_ref"),
    amountFen: integer(row, "amount_fen"),
    orderStatus: text(row, "order_status"),
    serviceStatus,
    typeId: text(row, "type_id"),
    regionId: text(row, "region_id"),
    ispId: text(row, "isp_id"),
    specId: nullableText(row, "spec_id"),
    durationId: text(row, "duration_id"),
    createdAt: text(row, "created_at"),
    openedAt: nullableText(row, "opened_at"),
    endsAt: nullableText(row, "ends_at"),
    planLabel: planOverrideLabel(row.plan_override),
    adminNote: nullableText(row, "admin_note"),
    deliveryLines: database === undefined ? [] : serviceDeliveryLines(database, integer(row, "service_id")),
  };
}

function adminGrantView(
  value: unknown,
  deliveryLines: ReadonlyArray<{ readonly position: number; readonly label: string }> = [],
): AdminGrantView {
  const row = asRow(value, "Admin grant");
  const status = text(row, "status");
  const deliveryStatus = text(row, "delivery_status");
  if ((status !== "active" && status !== "revoked") || (deliveryStatus !== "pending_open" && deliveryStatus !== "open")) {
    throw new Error("Admin grant database invariant failed");
  }
  return {
    id: integer(row, "id"),
    userId: integer(row, "user_id"),
    label: text(row, "label"),
    startsAt: text(row, "starts_at"),
    endsAt: nullableText(row, "ends_at"),
    status,
    reason: nullableText(row, "reason"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    typeId: nullableText(row, "type_id"),
    regionId: nullableText(row, "region_id"),
    ispId: nullableText(row, "isp_id"),
    specId: nullableText(row, "spec_id"),
    durationId: nullableText(row, "duration_id"),
    months: nullableInteger(row, "months"),
    valueFen: nullableInteger(row, "value_fen"),
    deliveryStatus,
    openedAt: nullableText(row, "opened_at"),
    deliveryLines,
  };
}

function grantDeliveryLines(database: DatabaseConnection, grantId: number): Array<{ position: number; label: string }> {
  return database
    .prepare("SELECT position, label FROM admin_grant_delivery_items WHERE grant_id = ? ORDER BY position ASC")
    .all(grantId)
    .map((value) => {
      const row = asRow(value, "Grant delivery");
      return { position: integer(row, "position"), label: text(row, "label") };
    });
}

function readAdminService(database: DatabaseConnection, serviceId: number): AdminServiceView | null {
  const rows = database
    .prepare(
      `SELECT ${ADMIN_SERVICE_COLUMNS}
       FROM services
       JOIN payments ON payments.id = services.payment_id
       JOIN orders ON orders.id = payments.order_id
       WHERE services.id = ?`,
    )
    .all(serviceId);
  return rows.length === 1 ? adminServiceView(rows[0], database) : null;
}

function readAdminGrant(database: DatabaseConnection, grantId: number): AdminGrantView | null {
  const rows = database.prepare("SELECT * FROM admin_grants WHERE id = ?").all(grantId);
  return rows.length === 1 ? adminGrantView(rows[0], grantDeliveryLines(database, grantId)) : null;
}

function userExists(database: DatabaseConnection, userId: number): boolean {
  return database.prepare("SELECT 1 FROM users WHERE id = ?").all(userId).length === 1;
}

export function listUserServicesForAdmin(
  database: DatabaseConnection,
  userId: number,
): { readonly services: AdminServiceView[]; readonly grants: AdminGrantView[] } {
  if (!userExists(database, userId)) throw new PaymentDomainError(404, "not_found");
  const services = database
    .prepare(
      `SELECT ${ADMIN_SERVICE_COLUMNS}
       FROM services
       JOIN payments ON payments.id = services.payment_id
       JOIN orders ON orders.id = payments.order_id
       WHERE orders.user_id = ?
       ORDER BY services.id DESC`,
    )
    .all(userId)
    .map((value) => adminServiceView(value, database));
  const grants = database
    .prepare("SELECT * FROM admin_grants WHERE user_id = ? ORDER BY id DESC")
    .all(userId)
    .map((value) => adminGrantView(value, grantDeliveryLines(database, integer(asRow(value, "Admin grant"), "id"))));
  return { services, grants };
}

export interface ServicePatch {
  readonly endsAt?: string | null;
  readonly planLabel?: string | null;
  readonly note?: string | null;
}

export function updateServiceForAdmin(
  database: DatabaseConnection,
  input: { readonly serviceId: number; readonly patch: ServicePatch; readonly adminEmail: string; readonly now?: () => Date },
): AdminServiceView {
  const operation = database.transaction(() => {
    if (readAdminService(database, input.serviceId) === null) throw new PaymentDomainError(404, "not_found");
    const at = nowIso(input.now);
    const assignments: string[] = [];
    const values: Array<string | null> = [];
    if (input.patch.endsAt !== undefined) {
      assignments.push("ends_at = ?");
      values.push(input.patch.endsAt);
    }
    if (input.patch.planLabel !== undefined) {
      assignments.push("plan_override = ?");
      values.push(input.patch.planLabel === null ? null : JSON.stringify({ label: input.patch.planLabel }));
    }
    if (input.patch.note !== undefined) {
      assignments.push("admin_note = ?");
      values.push(input.patch.note);
    }
    if (assignments.length === 0) throw new PaymentDomainError(400, "invalid_service_patch");
    const updated = database
      .prepare(`UPDATE services SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...values, at, input.serviceId);
    if (updated.changes !== 1) throw new PaymentDomainError(404, "not_found");
    audit(database, input.adminEmail, "admin.service.update", `service:${input.serviceId}`, at);
    const service = readAdminService(database, input.serviceId);
    if (service === null) throw new Error("Admin service database invariant failed");
    return service;
  });
  return operation.immediate();
}

export interface GrantPlanSelection {
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
}

/** The selection must name an existing sellable_plans row (exact 5-tuple, spec matched with IS).
    Inactive plans may still be gifted; only unknown combinations fail. */
function assertCatalogSelection(database: DatabaseConnection, selection: GrantPlanSelection): void {
  if (findSellablePlan(database, selection) === null) throw new PaymentDomainError(400, "invalid_plan");
}

/** startsAt + N calendar months in UTC, clamped to the target month's last day. */
export function addUtcMonths(startsAt: string, months: number): string {
  const start = new Date(startsAt);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target.toISOString();
}

/** Server-side fallback name when the admin leaves the label empty (the panel pre-fills a
    translated catalog name, so this is rarely shown): catalog ids plus the month count. */
export function defaultGrantLabel(selection: GrantPlanSelection, months: number): string {
  const parts = [selection.regionId.toUpperCase(), selection.ispId, selection.typeId];
  if (selection.specId !== null) parts.push(selection.specId);
  return `${parts.join(" ")} · ${months}M`.slice(0, ADMIN_LABEL_MAX_LENGTH);
}

export function createGrantForAdmin(
  database: DatabaseConnection,
  input: {
    readonly userId: number;
    readonly selection: GrantPlanSelection;
    readonly months: number;
    readonly valueFen: number;
    readonly label: string | null;
    readonly endsAt: string | null;
    readonly reason: string | null;
    readonly adminUserId: number;
    readonly adminEmail: string;
    readonly now?: () => Date;
  },
): AdminGrantView {
  const operation = database.transaction(() => {
    if (!userExists(database, input.userId)) throw new PaymentDomainError(404, "user_not_found");
    assertCatalogSelection(database, input.selection);
    const at = nowIso(input.now);
    // An explicit end date wins; otherwise the gift runs for `months` from now.
    const endsAt = input.endsAt ?? addUtcMonths(at, input.months);
    if (endsAt <= at) throw new PaymentDomainError(400, "invalid_ends_at");
    const label = input.label ?? defaultGrantLabel(input.selection, input.months);
    database
      .prepare(
        `INSERT INTO admin_grants (
           user_id, granted_by_admin_id, label, starts_at, ends_at, status, reason, created_at, updated_at,
           type_id, region_id, isp_id, spec_id, duration_id, months, value_fen, delivery_status, opened_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_open', NULL)`,
      )
      .run(
        input.userId, input.adminUserId, label, at, endsAt, input.reason, at, at,
        input.selection.typeId, input.selection.regionId, input.selection.ispId, input.selection.specId,
        input.selection.durationId, input.months, input.valueFen,
      );
    const grantId = integer(asRow(database.prepare("SELECT last_insert_rowid() AS id").all()[0], "Admin grant"), "id");
    audit(database, input.adminEmail, "admin.grant.create", `grant:${grantId}`, at);
    const grant = readAdminGrant(database, grantId);
    if (grant === null) throw new Error("Admin grant database invariant failed");
    return grant;
  });
  return operation.immediate();
}

export interface GrantPatch {
  readonly endsAt?: string | null;
  readonly label?: string;
  readonly status?: "revoked";
  /** Catalog fields are replaced together and validated as one selection. */
  readonly selection?: GrantPlanSelection;
  readonly months?: number;
  readonly valueFen?: number;
}

export function updateGrantForAdmin(
  database: DatabaseConnection,
  input: { readonly grantId: number; readonly patch: GrantPatch; readonly adminEmail: string; readonly now?: () => Date },
): AdminGrantView {
  const operation = database.transaction(() => {
    const current = readAdminGrant(database, input.grantId);
    if (current === null) throw new PaymentDomainError(404, "not_found");
    // A revoked grant is final: it is never edited or reactivated.
    if (current.status === "revoked") throw new PaymentDomainError(409, "grant_revoked");
    const at = nowIso(input.now);
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (input.patch.endsAt !== undefined) {
      assignments.push("ends_at = ?");
      values.push(input.patch.endsAt);
    }
    if (input.patch.label !== undefined) {
      assignments.push("label = ?");
      values.push(input.patch.label);
    }
    if (input.patch.status !== undefined) {
      assignments.push("status = 'revoked'");
    }
    if (input.patch.selection !== undefined) {
      assertCatalogSelection(database, input.patch.selection);
      assignments.push("type_id = ?", "region_id = ?", "isp_id = ?", "spec_id = ?", "duration_id = ?");
      values.push(
        input.patch.selection.typeId, input.patch.selection.regionId, input.patch.selection.ispId,
        input.patch.selection.specId, input.patch.selection.durationId,
      );
    }
    if (input.patch.months !== undefined) {
      assignments.push("months = ?");
      values.push(input.patch.months);
    }
    if (input.patch.valueFen !== undefined) {
      assignments.push("value_fen = ?");
      values.push(input.patch.valueFen);
    }
    if (assignments.length === 0) throw new PaymentDomainError(400, "invalid_grant_patch");
    database
      .prepare(`UPDATE admin_grants SET ${assignments.join(", ")}, updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(...values, at, input.grantId);
    audit(
      database,
      input.adminEmail,
      input.patch.status === "revoked" ? "admin.grant.revoke" : "admin.grant.update",
      `grant:${input.grantId}`,
      at,
    );
    const grant = readAdminGrant(database, input.grantId);
    if (grant === null) throw new Error("Admin grant database invariant failed");
    return grant;
  });
  return operation.immediate();
}

/** Delivery for a gift: same open semantics as services (pending_open -> open once, with lines). */
export function openGrantForAdmin(
  database: DatabaseConnection,
  input: {
    readonly grantId: number;
    readonly items: readonly EncryptedGrantDeliveryItem[];
    readonly adminEmail: string;
    readonly now?: () => Date;
  },
): AdminGrantView {
  if (input.items.length < 1 || input.items.some((item, index) => item.position !== index + 1 || item.label.trim() === "")) {
    throw new PaymentDomainError(400, "invalid_item");
  }
  const operation = database.transaction(() => {
    const current = readAdminGrant(database, input.grantId);
    if (current === null) throw new PaymentDomainError(404, "not_found");
    if (current.status === "revoked") throw new PaymentDomainError(409, "grant_revoked");
    if (current.deliveryStatus !== "pending_open") throw new PaymentDomainError(409, "invalid_transition");
    const at = nowIso(input.now);
    const updated = database
      .prepare(
        `UPDATE admin_grants SET delivery_status = 'open', opened_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND delivery_status = 'pending_open'`,
      )
      .run(at, at, input.grantId);
    if (updated.changes !== 1) throw new PaymentDomainError(409, "invalid_transition");
    const insert = database.prepare(
      `INSERT INTO admin_grant_delivery_items (
         grant_id, position, label, key_version, nonce, ciphertext, tag, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of input.items) {
      insert.run(input.grantId, item.position, item.label, item.keyVersion, item.nonce, item.ciphertext, item.tag, at, at);
    }
    audit(database, input.adminEmail, "admin.grant.open", `grant:${input.grantId}`, at);
    const grant = readAdminGrant(database, input.grantId);
    if (grant === null) throw new Error("Admin grant database invariant failed");
    return grant;
  });
  return operation.immediate();
}

export interface MyGrantItem {
  readonly source: "grant";
  readonly grantId: number;
  readonly label: string;
  readonly planLabel: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly status: "active";
  readonly typeId: string | null;
  readonly regionId: string | null;
  readonly ispId: string | null;
  readonly specId: string | null;
  readonly durationId: string | null;
  readonly months: number | null;
  readonly valueFen: number | null;
  readonly deliveryStatus: "pending_open" | "open";
}

/** Buyer view of gifts: active grants only, never the internal reason. */
export function listMyGrants(database: DatabaseConnection, userId: number): MyGrantItem[] {
  return database
    .prepare(
      `SELECT id, label, starts_at, ends_at, type_id, region_id, isp_id, spec_id, duration_id,
              months, value_fen, delivery_status
       FROM admin_grants
       WHERE user_id = ? AND status = 'active'
       ORDER BY id DESC`,
    )
    .all(userId)
    .map((value) => {
      const row = asRow(value, "Grant");
      const label = text(row, "label");
      return {
        source: "grant" as const,
        grantId: integer(row, "id"),
        label,
        planLabel: label,
        startsAt: text(row, "starts_at"),
        endsAt: nullableText(row, "ends_at"),
        status: "active" as const,
        typeId: nullableText(row, "type_id"),
        regionId: nullableText(row, "region_id"),
        ispId: nullableText(row, "isp_id"),
        specId: nullableText(row, "spec_id"),
        durationId: nullableText(row, "duration_id"),
        months: nullableInteger(row, "months"),
        valueFen: nullableInteger(row, "value_fen"),
        deliveryStatus: text(row, "delivery_status") === "open" ? ("open" as const) : ("pending_open" as const),
      };
    });
}

export interface MyGrantDeliveryLine {
  readonly source: "grant";
  readonly grantId: number;
  readonly position: number;
  readonly label: string;
}

/** Buyer delivery-line names of active, opened gifts (names only, like service lines). */
export function listMyGrantDeliveryLines(database: DatabaseConnection, userId: number): MyGrantDeliveryLine[] {
  return database
    .prepare(
      `SELECT items.grant_id, items.position, items.label
       FROM admin_grant_delivery_items AS items
       JOIN admin_grants AS grants ON grants.id = items.grant_id
       WHERE grants.user_id = ? AND grants.status = 'active' AND grants.delivery_status = 'open'
       ORDER BY items.grant_id DESC, items.position ASC`,
    )
    .all(userId)
    .map((value) => {
      const row = asRow(value, "Grant delivery");
      return { source: "grant" as const, grantId: integer(row, "grant_id"), position: integer(row, "position"), label: text(row, "label") };
    });
}

/** Decrypted subscription lines of the buyer's own active, opened gift; otherwise not_found
    (no hint whether the gift exists for someone else, is revoked, or is still pending). */
export function readMyGrantDelivery(
  database: DatabaseConnection,
  input: { readonly userId: number; readonly grantId: number; readonly keyring: TokenHmacKeyring },
): { readonly grantId: number; readonly items: Array<{ position: number; label: string; subscriptionUrl: string }> } {
  const owned = database
    .prepare(
      `SELECT 1 FROM admin_grants
       WHERE id = ? AND user_id = ? AND status = 'active' AND delivery_status = 'open'`,
    )
    .all(input.grantId, input.userId);
  if (owned.length !== 1) throw new PaymentDomainError(404, "not_found");
  const items = database
    .prepare(
      `SELECT position, label, key_version, nonce, ciphertext, tag
       FROM admin_grant_delivery_items WHERE grant_id = ? ORDER BY position ASC`,
    )
    .all(input.grantId)
    .map((value) => {
      const row = asRow(value, "Grant delivery");
      const position = integer(row, "position");
      const label = text(row, "label");
      const buffer = (name: string): Buffer => {
        const field = row[name];
        if (!Buffer.isBuffer(field)) throw new Error("Grant delivery database invariant failed");
        return field;
      };
      return {
        position,
        label,
        subscriptionUrl: decryptGrantDeliveryItem(
          { grantId: input.grantId, position, label, keyVersion: integer(row, "key_version"), nonce: buffer("nonce"), ciphertext: buffer("ciphertext"), tag: buffer("tag") },
          input.keyring,
        ),
      };
    });
  return { grantId: input.grantId, items };
}

export function auditGrantDeliveryDecryptFailure(database: DatabaseConnection, grantId: number, now?: () => Date): void {
  audit(database, "system", "grant.delivery_decrypt_failed", `grant:${grantId}`, nowIso(now));
}

/** Bind (or rebind) one delivered line to a monitor target after opening. The route checks the
    target against the live catalog; this only enforces ownership of the line and the open state. */
export function bindServiceDeliveryForAdmin(
  database: DatabaseConnection,
  input: {
    readonly serviceId: number;
    readonly position: number;
    readonly monitorTargetKey: string;
    readonly adminEmail: string;
    readonly now?: () => Date;
  },
): AdminServiceView {
  const operation = database.transaction(() => {
    const service = readAdminService(database, input.serviceId);
    if (service === null || !service.deliveryLines.some((line) => line.position === input.position)) {
      throw new PaymentDomainError(404, "not_found");
    }
    if (service.serviceStatus !== "open") throw new PaymentDomainError(409, "invalid_transition");
    const at = nowIso(input.now);
    database
      .prepare("UPDATE service_delivery_items SET monitor_target_key = ?, updated_at = ? WHERE service_id = ? AND position = ?")
      .run(input.monitorTargetKey, at, input.serviceId, input.position);
    audit(database, input.adminEmail, "admin.service.delivery_bind", `service:${input.serviceId}#${input.position}`, at);
    const updated = readAdminService(database, input.serviceId);
    if (updated === null) throw new Error("Admin service database invariant failed");
    return updated;
  });
  return operation.immediate();
}
