/* 客户工单 MVP 客户端。所有请求同源携带 Session Cookie；写操作携带
   /api/auth/me 下发的 Session 绑定 CSRF 令牌。服务端返回的正文只作纯文本渲染。 */

export type TicketStatus = "open" | "answered" | "closed";
export type TicketAuthorRole = "customer" | "admin";

export type TicketImageContentType = "image/jpeg" | "image/png" | "image/webp";

/** 已保存的工单图片：url 由前端按工单号 + 附件号重建，并要求与服务端返回一致。 */
export interface TicketAttachment {
  readonly ref: string;
  readonly contentType: TicketImageContentType;
  readonly byteSize: number;
  readonly url: string;
}

/** 待发送的图片：contentType 取浏览器识别的类型，服务端会按真实字节复核。 */
export interface TicketAttachmentUpload {
  readonly contentType: TicketImageContentType;
  readonly dataBase64: string;
}

export interface TicketMessage {
  readonly role: TicketAuthorRole;
  readonly body: string;
  readonly createdAt: string;
  readonly attachments: readonly TicketAttachment[];
}

export interface TicketSummary {
  readonly ref: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly serviceOrderRef: string | null;
  /** 关联的赠送套餐；与 serviceOrderRef 互斥。解析结果总是给出 number | null；
      可选只是为了兼容按字段重建摘要的管理端代码（缺省视为未关联）。 */
  readonly serviceGrantId?: number | null;
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
/* 与服务端 tickets/attachments.ts 一致：每条消息最多 3 张，单张 ≤ 5MiB，仅 JPEG/PNG/WebP。 */
export const TICKET_IMAGES_PER_MESSAGE = 3;
export const TICKET_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TICKET_IMAGE_TYPES: readonly TicketImageContentType[] = ["image/jpeg", "image/png", "image/webp"];
const TICKET_REF_PATTERN = /^TK[0-9A-F]{16}$/;
const ATTACHMENT_REF_PATTERN = /^TA[0-9A-F]{16}$/;

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
    !isGrantLink(value.serviceGrantId) ||
    (value.serviceOrderRef !== null && value.serviceGrantId !== undefined && value.serviceGrantId !== null) ||
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
    serviceGrantId: (value.serviceGrantId ?? null) as number | null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt as string | null,
    messageCount: value.messageCount,
    lastMessageRole: value.lastMessageRole,
  };
}

// 旧服务端（Migration 025 之前）不返回 serviceGrantId，按未关联处理。
function isGrantLink(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function isImageType(value: unknown): value is TicketImageContentType {
  return TICKET_IMAGE_TYPES.includes(value as TicketImageContentType);
}

/* 附件地址只认同源工单接口：前端按工单号 + 附件号重建，服务端返回的 url 必须与之完全一致，
   否则整条响应按无效处理，避免把任意地址放进 <img src>。 */
function parseAttachments(value: unknown, ticketRef: string, scope: "me" | "admin"): TicketAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TicketApiError("invalid_response");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.ref !== "string" ||
      !ATTACHMENT_REF_PATTERN.test(item.ref) ||
      !isImageType(item.contentType) ||
      typeof item.byteSize !== "number" ||
      !Number.isSafeInteger(item.byteSize) ||
      item.byteSize < 1 ||
      item.byteSize > TICKET_IMAGE_MAX_BYTES
    ) {
      throw new TicketApiError("invalid_response");
    }
    const url = `/api/${scope}/tickets/${ticketRef}/attachments/${item.ref}`;
    if (item.url !== url) throw new TicketApiError("invalid_response");
    return { ref: item.ref, contentType: item.contentType, byteSize: item.byteSize, url };
  });
}

function parseMessages(value: unknown, ticketRef: string, scope: "me" | "admin"): TicketMessage[] {
  if (!Array.isArray(value)) throw new TicketApiError("invalid_response");
  return value.map((item) => {
    if (!isRecord(item) || !isRole(item.role) || typeof item.body !== "string" || !isInstant(item.createdAt)) {
      throw new TicketApiError("invalid_response");
    }
    return { role: item.role, body: item.body, createdAt: item.createdAt, attachments: parseAttachments(item.attachments, ticketRef, scope) };
  });
}

function parseDetail(value: unknown, scope: "me" | "admin" = "me"): TicketDetail {
  if (!isRecord(value)) throw new TicketApiError("invalid_response");
  const summary = parseSummary(value);
  return { ...summary, messages: parseMessages(value.messages, summary.ref, scope) };
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

function attachmentPayload(attachments: readonly TicketAttachmentUpload[] | undefined): TicketAttachmentUpload[] | null {
  if (attachments === undefined || attachments.length === 0) return null;
  if (attachments.length > TICKET_IMAGES_PER_MESSAGE) throw new TicketApiError("invalid_attachments");
  return attachments.map(({ contentType, dataBase64 }) => ({ contentType, dataBase64 }));
}

/** 关联已购服务（orderRef）或赠送套餐（grantId），二者互斥；都不传即不关联。 */
export type TicketServiceLink =
  | { readonly kind: "purchase"; readonly orderRef: string }
  | { readonly kind: "grant"; readonly grantId: number }
  | null;

export async function createMyTicket(
  csrfToken: string,
  input: {
    readonly subject: string;
    readonly body: string;
    readonly link: TicketServiceLink;
    readonly attachments?: readonly TicketAttachmentUpload[];
  },
): Promise<TicketDetail> {
  const payload: JsonRecord = { subject: input.subject, body: input.body };
  if (input.link?.kind === "purchase") payload.serviceOrderRef = input.link.orderRef;
  if (input.link?.kind === "grant") payload.serviceGrantId = input.link.grantId;
  const attachments = attachmentPayload(input.attachments);
  if (attachments !== null) payload.attachments = attachments;
  return parseDetail(ticketFrom(await requestJson("/api/me/tickets", writeInit(csrfToken, payload))));
}

export async function replyToMyTicket(
  csrfToken: string,
  ref: string,
  body: string,
  attachments?: readonly TicketAttachmentUpload[],
): Promise<TicketDetail> {
  const payload: JsonRecord = { body };
  const images = attachmentPayload(attachments);
  if (images !== null) payload.attachments = images;
  return parseDetail(ticketFrom(await requestJson(`/api/me/tickets/${refPath(ref)}/messages`, writeInit(csrfToken, payload))));
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
  return { ...parseDetail(value, "admin"), customerEmail: customerEmail(value) };
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

/** 错误文案集合；客户工单页按当前界面语言传入（i18n `tickets.errors`），
    未传入时（管理端，仍为中文界面）使用下方中文默认文案。 */
export interface TicketErrorMessages {
  readonly unavailable: string;
  readonly unauthorized: string;
  readonly csrfInvalid: string;
  readonly forbidden: string;
  readonly notFound: string;
  readonly ticketClosed: string;
  readonly messageLimit: string;
  readonly invalidService: string;
  readonly invalidGrant: string;
  readonly invalidImage: string;
  readonly imageTooLarge: string;
  readonly invalidAttachments: (max: number) => string;
  readonly storageFull: string;
  readonly rateLimited: string;
  readonly invalidRequest: (subjectMax: number, bodyMax: number) => string;
  readonly network: string;
}

const DEFAULT_TICKET_ERRORS: TicketErrorMessages = {
  unavailable: "工单服务暂时不可用，请稍后重试。",
  unauthorized: "登录状态已失效，请重新登录后查看工单。",
  csrfInvalid: "登录状态已变化，请刷新页面后重试。",
  forbidden: "当前账户无权执行此操作。",
  notFound: "未找到该工单。",
  ticketClosed: "该工单已关闭，无法继续回复。",
  messageLimit: "该工单消息已达上限，请新建工单继续沟通。",
  invalidService: "所选服务无效，请重新选择或不关联服务。",
  invalidGrant: "所选赠送套餐无效或已失效，请重新选择或不关联服务。",
  invalidImage: "图片无法识别，请上传 JPEG、PNG 或 WebP 图片。",
  imageTooLarge: "单张图片不能超过 5MB。",
  invalidAttachments: (max) => `每条消息最多附 ${max} 张图片。`,
  storageFull: "图片存储空间已满，请减少图片后重试。",
  rateLimited: "图片发送过于频繁，请稍后重试。",
  invalidRequest: (subjectMax, bodyMax) => `请检查填写内容：主题 1-${subjectMax} 字且为单行，内容 1-${bodyMax} 字。`,
  network: "网络连接失败，请稍后重试。",
};

export function ticketErrorMessage(error: unknown, messages: TicketErrorMessages = DEFAULT_TICKET_ERRORS): string {
  if (!(error instanceof TicketApiError)) return messages.unavailable;
  switch (error.code) {
    case "unauthorized":
      return messages.unauthorized;
    case "csrf_invalid":
      return messages.csrfInvalid;
    case "forbidden":
      return messages.forbidden;
    case "not_found":
      return messages.notFound;
    case "ticket_closed":
      return messages.ticketClosed;
    case "message_limit_reached":
      return messages.messageLimit;
    case "invalid_service":
    case "invalid_link":
      return messages.invalidService;
    case "invalid_grant":
      return messages.invalidGrant;
    case "unsupported_image_type":
    case "invalid_image":
    case "image_type_mismatch":
      return messages.invalidImage;
    case "image_too_large":
      return messages.imageTooLarge;
    case "invalid_attachments":
      return messages.invalidAttachments(TICKET_IMAGES_PER_MESSAGE);
    case "ticket_storage_exceeded":
    case "account_storage_exceeded":
    case "storage_limit_exceeded":
      return messages.storageFull;
    case "rate_limited":
      return messages.rateLimited;
    case "invalid_request":
      return messages.invalidRequest(TICKET_SUBJECT_MAX, TICKET_BODY_MAX);
    case "network_error":
      return messages.network;
    default:
      return messages.unavailable;
  }
}
