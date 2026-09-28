import { randomBytes } from "node:crypto";

import type { DatabaseConnection } from "../db.js";

/* 客户工单 MVP。归属只取服务端 Session 用户；客户读写只按 (ticket_ref, user_id)
   查询，他人工单与不存在的工单返回同一个 404。状态：新建 open；管理员回复
   answered；客户在未关闭时回复回到 open；只有管理员可关闭，关闭后不可回复或重开。 */

export type TicketStatus = "open" | "answered" | "closed";
export type TicketAuthorRole = "customer" | "admin";

export const TICKET_REF_PATTERN = /^TK[0-9A-F]{16}$/;
export const TICKET_SUBJECT_MAX = 120;
export const TICKET_BODY_MAX = 4000;
export const TICKET_MESSAGES_MAX = 200;
export const TICKET_PAGE_SIZE = 20;
export const TICKET_PAGE_MAX = 500;

export class TicketDomainError extends Error {
  readonly statusCode: 400 | 404 | 409;
  readonly code: string;

  constructor(statusCode: 400 | 404 | 409, code: string) {
    super(code);
    this.name = "TicketDomainError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface TicketMessage {
  readonly role: TicketAuthorRole;
  readonly body: string;
  readonly createdAt: string;
}

export interface TicketSummary {
  readonly ref: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly serviceOrderRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly messageCount: number;
  readonly lastMessageRole: TicketAuthorRole;
}

export interface TicketDetail extends TicketSummary {
  readonly messages: readonly TicketMessage[];
}

export interface AdminTicketSummary extends TicketSummary {
  readonly customerEmail: string;
}

export interface AdminTicketDetail extends TicketDetail {
  readonly customerEmail: string;
}

export interface TicketPage<Item> {
  readonly items: readonly Item[];
  readonly page: number;
  readonly hasMore: boolean;
}

interface Clock {
  readonly now?: () => Date;
}

function nowIso(clock: Clock): string {
  const value = (clock.now ?? (() => new Date()))();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Ticket time source is invalid");
  }
  return value.toISOString();
}

// 仅接受纯文本：统一换行，去首尾空白；拒绝除换行/制表符以外的控制字符。
// 长度按 UTF-16 计，严于 SQLite 的字符计数，保证数据库 CHECK 不会被触发。
function normalizeText(
  value: unknown,
  max: number,
  multiline: boolean,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0 || normalized.length > max) return null;
  const forbidden = multiline
    ? /[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/
    : /[\u0000-\u001F\u007F\u2028\u2029]/;
  return forbidden.test(normalized) ? null : normalized;
}

export function normalizeTicketSubject(value: unknown): string | null {
  return normalizeText(value, TICKET_SUBJECT_MAX, false);
}

export function normalizeTicketBody(value: unknown): string | null {
  return normalizeText(value, TICKET_BODY_MAX, true);
}

export function parseTicketPage(value: unknown): number | null {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,3}$/.test(value)) return null;
  const page = Number(value);
  return page <= TICKET_PAGE_MAX ? page : null;
}

function asRow(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null) {
    throw new Error("Ticket database invariant failed");
  }
  return row as Record<string, unknown>;
}

function text(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error("Ticket database invariant failed");
  return value;
}

function nullableText(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Ticket database invariant failed");
  return value;
}

function integer(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Ticket database invariant failed");
  }
  return value;
}

function status(row: Record<string, unknown>): TicketStatus {
  const value = row.status;
  if (value !== "open" && value !== "answered" && value !== "closed") {
    throw new Error("Ticket database invariant failed");
  }
  return value;
}

function role(value: unknown): TicketAuthorRole {
  if (value !== "customer" && value !== "admin") {
    throw new Error("Ticket database invariant failed");
  }
  return value;
}

const SUMMARY_COLUMNS = `
  tickets.id AS id, tickets.ticket_ref AS ref, tickets.subject AS subject,
  tickets.status AS status, tickets.created_at AS created_at,
  tickets.updated_at AS updated_at, tickets.closed_at AS closed_at,
  (SELECT orders.order_ref FROM services
     JOIN payments ON payments.id = services.payment_id
     JOIN orders ON orders.id = payments.order_id
    WHERE services.id = tickets.service_id) AS service_order_ref,
  (SELECT COUNT(*) FROM ticket_messages WHERE ticket_messages.ticket_id = tickets.id) AS message_count,
  (SELECT author_role FROM ticket_messages WHERE ticket_messages.ticket_id = tickets.id
    ORDER BY ticket_messages.id DESC LIMIT 1) AS last_role`;

function summaryFrom(row: Record<string, unknown>): TicketSummary {
  return {
    ref: text(row, "ref"),
    subject: text(row, "subject"),
    status: status(row),
    serviceOrderRef: nullableText(row, "service_order_ref"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    closedAt: nullableText(row, "closed_at"),
    messageCount: integer(row, "message_count"),
    lastMessageRole: role(row.last_role),
  };
}

function messagesFor(database: DatabaseConnection, ticketId: number): TicketMessage[] {
  return database
    .prepare(
      `SELECT author_role, body, created_at FROM ticket_messages
        WHERE ticket_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(ticketId, TICKET_MESSAGES_MAX)
    .map((raw) => {
      const row = asRow(raw);
      return { role: role(row.author_role), body: text(row, "body"), createdAt: text(row, "created_at") };
    });
}

function page<Item>(rows: Item[], pageNumber: number): TicketPage<Item> {
  return {
    items: rows.slice(0, TICKET_PAGE_SIZE),
    page: pageNumber,
    hasMore: rows.length > TICKET_PAGE_SIZE,
  };
}

function findOwned(
  database: DatabaseConnection,
  userId: number,
  ref: string,
): Record<string, unknown> | null {
  if (!TICKET_REF_PATTERN.test(ref)) return null;
  const rows = database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM tickets WHERE tickets.ticket_ref = ? AND tickets.user_id = ?`)
    .all(ref, userId);
  return rows.length === 1 ? asRow(rows[0]) : null;
}

function findAny(database: DatabaseConnection, ref: string): Record<string, unknown> | null {
  if (!TICKET_REF_PATTERN.test(ref)) return null;
  const rows = database
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, users.email AS customer_email
         FROM tickets JOIN users ON users.id = tickets.user_id
        WHERE tickets.ticket_ref = ?`,
    )
    .all(ref);
  return rows.length === 1 ? asRow(rows[0]) : null;
}

function ownedDetail(database: DatabaseConnection, userId: number, ref: string): TicketDetail {
  const row = findOwned(database, userId, ref);
  if (row === null) throw new TicketDomainError(404, "not_found");
  return { ...summaryFrom(row), messages: messagesFor(database, integer(row, "id")) };
}

function adminDetail(database: DatabaseConnection, ref: string): AdminTicketDetail {
  const row = findAny(database, ref);
  if (row === null) throw new TicketDomainError(404, "not_found");
  return {
    ...summaryFrom(row),
    customerEmail: text(row, "customer_email"),
    messages: messagesFor(database, integer(row, "id")),
  };
}

function newTicketRef(generate: () => Buffer): string {
  return `TK${generate().toString("hex").toUpperCase()}`;
}

function insertMessage(
  database: DatabaseConnection,
  ticketId: number,
  authorRole: TicketAuthorRole,
  authorUserId: number,
  body: string,
  createdAt: string,
): void {
  const count = integer(
    asRow(database.prepare("SELECT COUNT(*) AS count FROM ticket_messages WHERE ticket_id = ?").all(ticketId)[0]),
    "count",
  );
  if (count >= TICKET_MESSAGES_MAX) throw new TicketDomainError(409, "message_limit_reached");
  database
    .prepare(
      `INSERT INTO ticket_messages (ticket_id, author_role, author_user_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ticketId, authorRole, authorUserId, body, createdAt);
}

export interface CreateTicketInput extends Clock {
  readonly userId: number;
  readonly subject: string;
  readonly body: string;
  readonly serviceOrderRef: string | null;
  readonly randomRef?: () => Buffer;
}

export function createTicket(database: DatabaseConnection, input: CreateTicketInput): TicketDetail {
  const operation = database.transaction(() => {
    let serviceId: number | null = null;
    if (input.serviceOrderRef !== null) {
      // 只有属于该客户的服务可以关联；他人或不存在的服务给同一个错误。
      const rows = database
        .prepare(
          `SELECT services.id AS id FROM services
             JOIN payments ON payments.id = services.payment_id
             JOIN orders ON orders.id = payments.order_id
            WHERE orders.order_ref = ? AND orders.user_id = ?`,
        )
        .all(input.serviceOrderRef, input.userId);
      if (rows.length !== 1) throw new TicketDomainError(400, "invalid_service");
      serviceId = integer(asRow(rows[0]), "id");
    }
    const createdAt = nowIso(input);
    const generate = input.randomRef ?? (() => randomBytes(8));
    let ref = "";
    for (let attempt = 0; attempt < 3 && ref === ""; attempt += 1) {
      const candidate = newTicketRef(generate);
      const exists = database.prepare("SELECT 1 FROM tickets WHERE ticket_ref = ?").all(candidate).length > 0;
      if (!exists) ref = candidate;
    }
    if (ref === "") throw new Error("Ticket reference generation failed");
    database
      .prepare(
        `INSERT INTO tickets (ticket_ref, user_id, service_id, subject, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(ref, input.userId, serviceId, input.subject, createdAt, createdAt);
    const ticketId = integer(asRow(database.prepare("SELECT id FROM tickets WHERE ticket_ref = ?").all(ref)[0]), "id");
    insertMessage(database, ticketId, "customer", input.userId, input.body, createdAt);
    return ownedDetail(database, input.userId, ref);
  });
  return operation.immediate();
}

export function listOwnTickets(
  database: DatabaseConnection,
  userId: number,
  pageNumber: number,
): TicketPage<TicketSummary> {
  const rows = database
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM tickets WHERE tickets.user_id = ?
        ORDER BY tickets.updated_at DESC, tickets.id DESC LIMIT ? OFFSET ?`,
    )
    .all(userId, TICKET_PAGE_SIZE + 1, (pageNumber - 1) * TICKET_PAGE_SIZE)
    .map((raw) => summaryFrom(asRow(raw)));
  return page(rows, pageNumber);
}

export function getOwnTicket(database: DatabaseConnection, userId: number, ref: string): TicketDetail {
  return ownedDetail(database, userId, ref);
}

export function replyAsCustomer(
  database: DatabaseConnection,
  input: Clock & { readonly userId: number; readonly ref: string; readonly body: string },
): TicketDetail {
  const operation = database.transaction(() => {
    const row = findOwned(database, input.userId, input.ref);
    if (row === null) throw new TicketDomainError(404, "not_found");
    if (status(row) === "closed") throw new TicketDomainError(409, "ticket_closed");
    const ticketId = integer(row, "id");
    const createdAt = nowIso(input);
    insertMessage(database, ticketId, "customer", input.userId, input.body, createdAt);
    database
      .prepare("UPDATE tickets SET status = 'open', updated_at = ? WHERE id = ? AND status <> 'closed'")
      .run(createdAt, ticketId);
    return ownedDetail(database, input.userId, input.ref);
  });
  return operation.immediate();
}

export function listTicketsForAdmin(
  database: DatabaseConnection,
  filter: TicketStatus | "all",
  pageNumber: number,
): TicketPage<AdminTicketSummary> {
  const where = filter === "all" ? "" : "WHERE tickets.status = ?";
  const parameters: unknown[] = filter === "all" ? [] : [filter];
  const rows = database
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, users.email AS customer_email
         FROM tickets JOIN users ON users.id = tickets.user_id ${where}
        ORDER BY tickets.updated_at DESC, tickets.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...parameters, TICKET_PAGE_SIZE + 1, (pageNumber - 1) * TICKET_PAGE_SIZE)
    .map((raw) => {
      const row = asRow(raw);
      return { ...summaryFrom(row), customerEmail: text(row, "customer_email") };
    });
  return page(rows, pageNumber);
}

export function getTicketForAdmin(database: DatabaseConnection, ref: string): AdminTicketDetail {
  return adminDetail(database, ref);
}

export interface AdminActor extends Clock {
  readonly adminUserId: number;
  readonly adminEmail: string;
  readonly ref: string;
}

function audit(database: DatabaseConnection, actor: string, action: string, ref: string, at: string): void {
  database
    .prepare("INSERT INTO audit_log (actor, action, target_ref, created_at) VALUES (?, ?, ?, ?)")
    .run(actor, action, ref, at);
}

export function replyAsAdmin(
  database: DatabaseConnection,
  input: AdminActor & { readonly body: string },
): AdminTicketDetail {
  const operation = database.transaction(() => {
    const row = findAny(database, input.ref);
    if (row === null) throw new TicketDomainError(404, "not_found");
    if (status(row) === "closed") throw new TicketDomainError(409, "ticket_closed");
    const ticketId = integer(row, "id");
    const createdAt = nowIso(input);
    insertMessage(database, ticketId, "admin", input.adminUserId, input.body, createdAt);
    database
      .prepare("UPDATE tickets SET status = 'answered', updated_at = ? WHERE id = ? AND status <> 'closed'")
      .run(createdAt, ticketId);
    audit(database, input.adminEmail, "ticket.reply", input.ref, createdAt);
    return adminDetail(database, input.ref);
  });
  return operation.immediate();
}

export function closeTicketAsAdmin(database: DatabaseConnection, input: AdminActor): AdminTicketDetail {
  const operation = database.transaction(() => {
    const row = findAny(database, input.ref);
    if (row === null) throw new TicketDomainError(404, "not_found");
    if (status(row) === "closed") throw new TicketDomainError(409, "ticket_closed");
    const closedAt = nowIso(input);
    const changed = database
      .prepare(
        `UPDATE tickets SET status = 'closed', closed_at = ?, closed_by_admin_id = ?, updated_at = ?
          WHERE id = ? AND status <> 'closed'`,
      )
      .run(closedAt, input.adminUserId, closedAt, integer(row, "id")).changes;
    if (changed !== 1) throw new TicketDomainError(409, "ticket_closed");
    audit(database, input.adminEmail, "ticket.close", input.ref, closedAt);
    return adminDetail(database, input.ref);
  });
  return operation.immediate();
}
