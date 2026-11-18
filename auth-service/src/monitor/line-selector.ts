import type { DatabaseConnection } from "../db.js";
import { listMyNodeLines, type NodeLine } from "./node-status.js";

/* 买家交付线路选择器 `kind:ref:position`（NSP-LINE-STATUS-08，NSP-SUB-TRAFFIC-09 共用）：
   - service:<orderRef>:<position>   已购服务的交付行；
   - grant:<grantId>:<position>      赠送的交付行。
   只做语法解析；所有权（服务 open / 赠送 active+open、属于当前买家）由 findOwnedLine 判定，
   不存在、越权与语法错误在调用方统一表现为同一个 not-found，不泄露其他买家的线路是否存在。 */

export type LineSelector =
  | { readonly kind: "service"; readonly ref: string; readonly position: number }
  | { readonly kind: "grant"; readonly ref: number; readonly position: number };

const ORDER_REF = /^DL[A-Za-z0-9]{8,64}$/;
const POSITIVE = /^[1-9][0-9]{0,8}$/;

export function parseLineSelector(value: unknown): LineSelector | null {
  if (typeof value !== "string" || value.length > 96) return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const [kind, ref, position] = parts as [string, string, string];
  if (!POSITIVE.test(position)) return null;
  if (kind === "service" && ORDER_REF.test(ref)) return { kind, ref, position: Number(position) };
  if (kind === "grant" && POSITIVE.test(ref)) return { kind, ref: Number(ref), position: Number(position) };
  return null;
}

/** The query string of a line-scoped request: none, or exactly one `line` parameter (any other
    or repeated parameter is malformed). `line` is the selector, or "invalid" when it does not parse,
    which callers answer exactly like a line the buyer does not own. */
export function parseLineQuery(
  rawUrl: string | undefined,
): { readonly ok: true; readonly line: LineSelector | "invalid" | null } | { readonly ok: false } {
  const index = rawUrl?.indexOf("?") ?? -1;
  if (rawUrl === undefined || index < 0) return { ok: true, line: null };
  const params = new URLSearchParams(rawUrl.slice(index + 1));
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== "line") return { ok: false };
  return { ok: true, line: parseLineSelector(params.get("line")) ?? "invalid" };
}

export function formatLineSelector(line: LineSelector): string {
  return `${line.kind}:${line.ref}:${line.position}`;
}

/** The buyer's own delivered line (open service / active+open gift), or null. Server-only target key. */
export function findOwnedLine(database: DatabaseConnection, userId: number, line: LineSelector): NodeLine | null {
  return (
    listMyNodeLines(database, userId).find(
      (candidate) => candidate.kind === line.kind && candidate.ref === line.ref && candidate.position === line.position,
    ) ?? null
  );
}
