import { randomBytes } from "node:crypto";

import type { DatabaseConnection } from "../db.js";
import { TicketDomainError } from "./tickets.js";

/* 工单图片附件：字节校验只信内容（签名 + 基本结构），不认文件名或声明 MIME；
   全部存储在 SQLite BLOB 内，不落地文件系统。 */

export const TICKET_ATTACHMENT_REF_PATTERN = /^TA[0-9A-F]{16}$/;
export const TICKET_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const TICKET_MESSAGE_ATTACHMENTS_MAX = 3;
export const TICKET_ATTACHMENT_TICKET_MAX_BYTES = 30 * 1024 * 1024;
export const TICKET_ATTACHMENT_ACCOUNT_MAX_BYTES = 100 * 1024 * 1024;
export const TICKET_ATTACHMENT_GLOBAL_MAX_BYTES = 1024 * 1024 * 1024;

export type TicketImageContentType = "image/jpeg" | "image/png" | "image/webp";

export interface PreparedAttachment {
  readonly contentType: TicketImageContentType;
  readonly content: Buffer;
}

export interface TicketAttachmentMeta {
  readonly ref: string;
  readonly contentType: TicketImageContentType;
  readonly byteSize: number;
  readonly url: string;
}

function attachmentError(code: string): TicketDomainError {
  return new TicketDomainError(400, code);
}

/* ---------------- image structure validation ---------------- */

// CRC-32 (PNG chunk integrity), reflected polynomial 0xEDB88320.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

// SOI, at least one real SOF marker segment, and a trailing EOI.
function isJpeg(content: Buffer): boolean {
  const size = content.length;
  if (size < 4 || content[0] !== 0xff || content[1] !== 0xd8) return false;
  if (content[size - 2] !== 0xff || content[size - 1] !== 0xd9) return false;
  let position = 2;
  while (position + 1 < size) {
    if (content[position] !== 0xff) return false;
    const marker = content[position + 1]!;
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      position += 2;
      continue;
    }
    if (position + 3 >= size) return false;
    const length = content.readUInt16BE(position + 2);
    if (length < 2 || position + 2 + length > size) return false;
    if (JPEG_SOF_MARKERS.has(marker)) return true;
    if (marker === 0xda) return false; // SOS before any SOF
    position += 2 + length;
  }
  return false;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BIT_DEPTHS = new Set([1, 2, 4, 8, 16]);
const PNG_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);

// Signature + every chunk CRC verified, IHDR first, IDAT present, IEND last.
function isPng(content: Buffer): boolean {
  const size = content.length;
  if (size < PNG_SIGNATURE.length + 12 || !content.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }
  let position = 8;
  let sawIhdr = false;
  let sawIdat = false;
  while (position + 12 <= size) {
    const length = content.readUInt32BE(position);
    if (length > 0x7fffffff || position + 12 + length > size) return false;
    const type = content.subarray(position + 4, position + 8).toString("latin1");
    const dataEnd = position + 8 + length;
    if (content.readUInt32BE(dataEnd) !== crc32(content, position + 4, dataEnd)) return false;
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) return false;
      const data = position + 8;
      const width = content.readUInt32BE(data);
      const height = content.readUInt32BE(data + 4);
      if (width === 0 || height === 0) return false;
      if (!PNG_BIT_DEPTHS.has(content[data + 8]!)) return false;
      if (!PNG_COLOR_TYPES.has(content[data + 9]!)) return false;
      if (content[data + 10] !== 0 || content[data + 11] !== 0) return false;
      if (content[data + 12]! > 1) return false;
      sawIhdr = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT") sawIdat = true;
    position = dataEnd + 4;
    if (type === "IEND") return sawIdat && position === size;
  }
  return false;
}

const WEBP_CHUNK_TYPES = new Set(["VP8 ", "VP8L", "VP8X"]);

// RIFF/WEBP container: exact size, known first chunk, minimal payload checks.
function isWebp(content: Buffer): boolean {
  const size = content.length;
  if (
    size < 20 ||
    content.subarray(0, 4).toString("latin1") !== "RIFF" ||
    content.subarray(8, 12).toString("latin1") !== "WEBP"
  ) {
    return false;
  }
  if (content.readUInt32LE(4) + 8 !== size) return false;
  const type = content.subarray(12, 16).toString("latin1");
  if (!WEBP_CHUNK_TYPES.has(type)) return false;
  const chunkSize = content.readUInt32LE(16);
  if (20 + chunkSize > size) return false;
  const payload = 20;
  if (type === "VP8X") return chunkSize === 10;
  if (type === "VP8L") return chunkSize >= 1 && content[payload] === 0x2f;
  // VP8: the first frame must be a keyframe with the 9d012a start code.
  return (
    chunkSize >= 10 &&
    (content[payload]! & 0x01) === 0 &&
    content[payload + 3] === 0x9d &&
    content[payload + 4] === 0x01 &&
    content[payload + 5] === 0x2a
  );
}

const IMAGE_CHECKS: ReadonlyArray<readonly [TicketImageContentType, (content: Buffer) => boolean]> = [
  ["image/jpeg", isJpeg],
  ["image/png", isPng],
  ["image/webp", isWebp],
];

function decodeStrictBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 ? decoded : null;
}

/* 请求形状与逐张校验都在事务外完成；配额检查在写事务内做。 */
export function prepareTicketAttachments(value: unknown): PreparedAttachment[] {
  if (!Array.isArray(value) || value.length > TICKET_MESSAGE_ATTACHMENTS_MAX) {
    throw attachmentError("invalid_attachments");
  }
  if (value.length === 0) return [];
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw attachmentError("invalid_attachments");
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes("contentType") || !keys.includes("dataBase64")) {
      throw attachmentError("invalid_attachments");
    }
    const contentType = record.contentType;
    const dataBase64 = record.dataBase64;
    if (typeof contentType !== "string" || typeof dataBase64 !== "string") {
      throw attachmentError("invalid_attachments");
    }
    if (!IMAGE_CHECKS.some(([type]) => type === contentType)) {
      throw attachmentError("unsupported_image_type");
    }
    const content = decodeStrictBase64(dataBase64);
    if (content === null) throw attachmentError("invalid_attachments");
    if (content.length > TICKET_ATTACHMENT_MAX_BYTES) throw attachmentError("image_too_large");
    const actual = IMAGE_CHECKS.find(([, check]) => check(content));
    if (actual === undefined) throw attachmentError("invalid_image");
    if (actual[0] !== contentType) throw attachmentError("image_type_mismatch");
    return { contentType: contentType as TicketImageContentType, content };
  });
}

/* ---------------- storage ---------------- */

function sumColumn(
  database: DatabaseConnection,
  query: string,
  ...parameters: readonly unknown[]
): number {
  const row = database.prepare(query).all(...parameters)[0] as { readonly total: unknown } | undefined;
  const total = row?.total;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error("Attachment quota invariant failed");
  }
  return total;
}

function newAttachmentRef(generate: () => Buffer): string {
  return `TA${generate().toString("hex").toUpperCase()}`;
}

/* 工单/账户/全局配额与行插入都在调用方的事务里，任一失败整体回滚。 */
export function insertTicketAttachments(
  database: DatabaseConnection,
  options: {
    readonly ticketId: number;
    readonly ownerUserId: number;
    readonly messageId: number;
    readonly attachments: readonly PreparedAttachment[];
    readonly createdAt: string;
    readonly randomRef?: () => Buffer;
  },
): void {
  if (options.attachments.length === 0) return;
  const incoming = options.attachments.reduce((total, entry) => total + entry.content.length, 0);
  const ticketTotal = sumColumn(
    database,
    `SELECT COALESCE(SUM(a.byte_size), 0) AS total FROM ticket_attachments a
       JOIN ticket_messages m ON m.id = a.message_id WHERE m.ticket_id = ?`,
    options.ticketId,
  );
  if (ticketTotal + incoming > TICKET_ATTACHMENT_TICKET_MAX_BYTES) {
    throw new TicketDomainError(409, "ticket_storage_exceeded");
  }
  const accountTotal = sumColumn(
    database,
    `SELECT COALESCE(SUM(a.byte_size), 0) AS total FROM ticket_attachments a
       JOIN ticket_messages m ON m.id = a.message_id
       JOIN tickets t ON t.id = m.ticket_id WHERE t.user_id = ?`,
    options.ownerUserId,
  );
  if (accountTotal + incoming > TICKET_ATTACHMENT_ACCOUNT_MAX_BYTES) {
    throw new TicketDomainError(409, "account_storage_exceeded");
  }
  const globalTotal = sumColumn(
    database,
    "SELECT COALESCE(SUM(byte_size), 0) AS total FROM ticket_attachments",
  );
  if (globalTotal + incoming > TICKET_ATTACHMENT_GLOBAL_MAX_BYTES) {
    throw new TicketDomainError(409, "storage_limit_exceeded");
  }

  const generate = options.randomRef ?? (() => randomBytes(8));
  const exists = database.prepare("SELECT 1 FROM ticket_attachments WHERE attachment_ref = ?");
  const insert = database.prepare(
    `INSERT INTO ticket_attachments (attachment_ref, message_id, content_type, byte_size, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const attachment of options.attachments) {
    let ref = "";
    for (let attempt = 0; attempt < 3 && ref === ""; attempt += 1) {
      const candidate = newAttachmentRef(generate);
      if (exists.all(candidate).length === 0) ref = candidate;
    }
    if (ref === "") throw new Error("Attachment reference generation failed");
    insert.run(ref, options.messageId, attachment.contentType, attachment.content.length, attachment.content, options.createdAt);
  }
}

export function attachmentUrl(ticketRef: string, attachmentRef: string, admin: boolean): string {
  return `/api/${admin ? "admin" : "me"}/tickets/${ticketRef}/attachments/${attachmentRef}`;
}

export function attachmentsForTicket(
  database: DatabaseConnection,
  ticketId: number,
  ticketRef: string,
  admin: boolean,
): Map<number, TicketAttachmentMeta[]> {
  const rows = database
    .prepare(
      `SELECT a.message_id AS message_id, a.attachment_ref AS ref, a.content_type AS content_type, a.byte_size AS byte_size
         FROM ticket_attachments a
         JOIN ticket_messages m ON m.id = a.message_id
        WHERE m.ticket_id = ? ORDER BY a.id ASC`,
    )
    .all(ticketId) as Array<Record<string, unknown>>;
  const grouped = new Map<number, TicketAttachmentMeta[]>();
  for (const row of rows) {
    const messageId = row.message_id;
    const ref = row.ref;
    const contentType = row.content_type;
    const byteSize = row.byte_size;
    if (
      typeof messageId !== "number" || typeof ref !== "string" ||
      typeof byteSize !== "number" ||
      (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp")
    ) {
      throw new Error("Ticket database invariant failed");
    }
    const meta: TicketAttachmentMeta = {
      ref,
      contentType,
      byteSize,
      url: attachmentUrl(ticketRef, ref, admin),
    };
    const bucket = grouped.get(messageId);
    if (bucket === undefined) grouped.set(messageId, [meta]);
    else bucket.push(meta);
  }
  return grouped;
}

export interface StoredAttachment {
  readonly contentType: TicketImageContentType;
  readonly content: Buffer;
}

/* 归属必须同时命中附件 → 消息 → 工单链；客户路径再按 owner 过滤，
   他人或不存在统一返回 null，由路由给同一个 404。 */
export function loadStoredAttachment(
  database: DatabaseConnection,
  options: {
    readonly ticketRef: string;
    readonly attachmentRef: string;
    readonly ownerUserId?: number;
  },
): StoredAttachment | null {
  if (!TICKET_ATTACHMENT_REF_PATTERN.test(options.attachmentRef)) return null;
  const clauses = ["a.attachment_ref = ?", "t.ticket_ref = ?"];
  const parameters: unknown[] = [options.attachmentRef, options.ticketRef];
  if (options.ownerUserId !== undefined) {
    clauses.push("t.user_id = ?");
    parameters.push(options.ownerUserId);
  }
  const rows = database
    .prepare(
      `SELECT a.content_type AS content_type, a.content AS content
         FROM ticket_attachments a
         JOIN ticket_messages m ON m.id = a.message_id
         JOIN tickets t ON t.id = m.ticket_id
        WHERE ${clauses.join(" AND ")}`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  if (rows.length !== 1) return null;
  const contentType = rows[0]!.content_type;
  const content = rows[0]!.content;
  if (
    !Buffer.isBuffer(content) ||
    (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp")
  ) {
    throw new Error("Ticket database invariant failed");
  }
  return { contentType, content };
}
