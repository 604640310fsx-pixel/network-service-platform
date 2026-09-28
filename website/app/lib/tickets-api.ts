/* 客户工单 MVP 客户端。所有请求同源携带 Session Cookie；写操作携带
   /api/auth/me 下发的 Session 绑定 CSRF 令牌。服务端返回的正文只作纯文本渲染。 */

export type TicketStatus = "open" | "answered" | "closed";
export type TicketAuthorRole = "customer" | "admin";

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

export const TICKET_SUBJECT_MAX = 120;
export const TICKET_BODY_MAX = 4000;
const TICKET_REF_PATTERN = /^TK[0-9A-F]{16}$/;

type JsonRecord = Record<string, unknown>;

export class TicketApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "TicketApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isStatus(value: unknown): value is TicketStatus {
  return value === "open" || value === "answered" || value === "closed";
}

function isRole(value: unknown): value is TicketAuthorRole {
  return value === "customer" || value === "admin";
}

function parseSummary(value: unknown): TicketSummary {
  if (
    !isRecord(value) ||
    typeof value.ref !== "string" ||
    !TICKET_REF_PATTERN.test(value.ref) ||
    typeof value.subject !== "string" ||
    !isStatus(value.status) ||
    (value.serviceOrderRef !== null && typeof value.serviceOrderRef !== "string") ||
    !isInstant(value.createdAt) ||
    !isInstant(value.updatedAt) ||
    (value.closedAt !== null && !isInstant(value.closedAt)) ||
    typeof value.messageCount !== "number" ||
    !Number.isSafeInteger(value.messageCount) ||
    value.messageCount < 1 ||
    !isRole(value.lastMessageRole)
  ) {
    throw new TicketApiError("invalid_response");
  }
  return {
    ref: value.ref,
    subject: value.subject,
    status: value.status,
    serviceOrderRef: value.serviceOrderRef as string | null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt as string | null,
    messageCount: value.messageCount,
    lastMessageRole: value.lastMessageRole,
  };
}

function parseMessages(value: unknown): TicketMessage[] {
  if (!Array.isArray(value)) throw new TicketApiError("invalid_response");
  return value.map((item) => {
    if (!isRecord(item) || !isRole(item.role) || typeof item.body !== "string" || !isInstant(item.createdAt)) {
      throw new TicketApiError("invalid_response");
    }
    return { role: item.role, body: item.body, createdAt: item.createdAt };
  });
}

function parseDetail(value: unknown): TicketDetail {
  if (!isRecord(value)) throw new TicketApiError("invalid_response");
  return { ...parseSummary(value), messages: parseMessages(value.messages) };
}

function customerEmail(value: unknown): string {
  if (!isRecord(value) || typeof value.customerEmail !== "string" || !value.customerEmail.includes("@")) {
    throw new TicketApiError("invalid_response");
  }
  return value.customerEmail;
}

function parsePage<Item>(value: unknown, parseItem: (item: unknown) => Item): TicketPage<Item> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.page !== "number" ||
    !Number.isSafeInteger(value.page) ||
    value.page < 1 ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new TicketApiError("invalid_response");
  }
  return { items: value.items.map(parseItem), page: value.page, hasMore: value.hasMore };
}

function ticketFrom(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.ticket)) throw new TicketApiError("invalid_response");
  return value.ticket;
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return null;
  return value.error.code;
}

async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new TicketApiError("network_error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new TicketApiError("invalid_response", response.status);
  }
  if (!response.ok) throw new TicketApiError(errorCode(value) ?? "request_failed", response.status);
  return value;
}

function writeInit(csrfToken: string, body: JsonRecord): RequestInit {
  return {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
  };
}

function refPath(ref: string): string {
  if (!TICKET_REF_PATTERN.test(ref)) throw new TicketApiError("not_found", 404);
  return encodeURIComponent(ref);
}

export function isTicketRef(value: string | null): value is string {
  return value !== null && TICKET_REF_PATTERN.test(value);
}

// ---------- customer ----------
export async function listMyTickets(page: number, signal?: AbortSignal): Promise<TicketPage<TicketSummary>> {
  return parsePage(await requestJson(`/api/me/tickets?page=${page}`, { method: "GET" }, signal), parseSummary);
}

export async function getMyTicket(ref: string, signal?: AbortSignal): Promise<TicketDetail> {
  return parseDetail(ticketFrom(await requestJson(`/api/me/tickets/${refPath(ref)}`, { method: "GET" }, signal)));
}

export async function createMyTicket(
  csrfToken: string,
  input: { readonly subject: string; readonly body: string; readonly serviceOrderRef: string | null },
): Promise<TicketDetail> {
  const payload: JsonRecord = { subject: input.subject, body: input.body };
  if (input.serviceOrderRef !== null) payload.serviceOrderRef = input.serviceOrderRef;
  return parseDetail(ticketFrom(await requestJson("/api/me/tickets", writeInit(csrfToken, payload))));
}

export async function replyToMyTicket(csrfToken: string, ref: string, body: string): Promise<TicketDetail> {
  return parseDetail(ticketFrom(await requestJson(`/api/me/tickets/${refPath(ref)}/messages`, writeInit(csrfToken, { body }))));
}

// ---------- admin ----------
export async function listAdminTickets(
  filter: TicketStatus | "all",
  page: number,
  signal?: AbortSignal,
): Promise<TicketPage<AdminTicketSummary>> {
  const value = await requestJson(`/api/admin/tickets?status=${filter}&page=${page}`, { method: "GET" }, signal);
  return parsePage(value, (item) => ({ ...parseSummary(item), customerEmail: customerEmail(item) }));
}

function parseAdminDetail(value: unknown): AdminTicketDetail {
  return { ...parseDetail(value), customerEmail: customerEmail(value) };
}

export async function getAdminTicket(ref: string, signal?: AbortSignal): Promise<AdminTicketDetail> {
  return parseAdminDetail(ticketFrom(await requestJson(`/api/admin/tickets/${refPath(ref)}`, { method: "GET" }, signal)));
}

export async function replyToAdminTicket(csrfToken: string, ref: string, body: string): Promise<AdminTicketDetail> {
  return parseAdminDetail(
    ticketFrom(await requestJson(`/api/admin/tickets/${refPath(ref)}/messages`, writeInit(csrfToken, { body }))),
  );
}

export async function closeAdminTicket(csrfToken: string, ref: string): Promise<AdminTicketDetail> {
  return parseAdminDetail(
    ticketFrom(await requestJson(`/api/admin/tickets/${refPath(ref)}/status`, writeInit(csrfToken, { status: "closed" }))),
  );
}

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "待回复",
  answered: "已回复",
  closed: "已关闭",
};

export function ticketErrorMessage(error: unknown): string {
  if (!(error instanceof TicketApiError)) return "工单服务暂时不可用，请稍后重试。";
  switch (error.code) {
    case "unauthorized":
      return "登录状态已失效，请重新登录后查看工单。";
    case "csrf_invalid":
      return "登录状态已变化，请刷新页面后重试。";
    case "forbidden":
      return "当前账户无权执行此操作。";
    case "not_found":
      return "未找到该工单。";
    case "ticket_closed":
      return "该工单已关闭，无法继续回复。";
    case "message_limit_reached":
      return "该工单消息已达上限，请新建工单继续沟通。";
    case "invalid_service":
      return "所选服务无效，请重新选择或不关联服务。";
    case "invalid_request":
      return `请检查填写内容：主题 1-${TICKET_SUBJECT_MAX} 字且为单行，内容 1-${TICKET_BODY_MAX} 字。`;
    case "network_error":
      return "网络连接失败，请稍后重试。";
    default:
      return "工单服务暂时不可用，请稍后重试。";
  }
}
