import type { DatabaseConnection } from "../db.js";
import type { MonitorPrivateStatus } from "./private-client.js";

/* 买家节点在线状态（NSP-NODE-STATUS-05）。
   - 只读买家本人 open 服务的交付行与 active+open 赠送的交付行；
   - monitor_target_key 只在服务端用于查询私有监控，不进入任何响应；
   - 赠送交付行（Migration 023）没有监控目标列，统一为 unbound；
   - 每个目标单独降级：私有接口失败 / 超时 / 超出并发上限 → unknown，不让整页失败。 */

export const NODE_STATUS_MAX_TARGETS = 20;

export type NodeLineStatus = "online" | "offline" | "stale" | "unbound" | "unknown";

export type NodeStatusItem =
  | { readonly kind: "service"; readonly ref: string; readonly position: number; readonly label: string; readonly status: NodeLineStatus }
  | { readonly kind: "grant"; readonly ref: number; readonly position: number; readonly label: string; readonly status: NodeLineStatus };

interface NodeLine {
  readonly kind: "service" | "grant";
  readonly ref: string | number;
  readonly position: number;
  readonly label: string;
  /** Server-only; never serialized. */
  readonly targetKey: string | null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Node status database invariant failed");
  }
  return value as Record<string, unknown>;
}

function text(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error("Node status database invariant failed");
  return value;
}

function integer(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Node status database invariant failed");
  return value;
}

export function listMyNodeLines(database: DatabaseConnection, userId: number): NodeLine[] {
  const services = database
    .prepare(
      `SELECT orders.order_ref, items.position, items.label, items.monitor_target_key
       FROM service_delivery_items AS items
       JOIN services ON services.id = items.service_id
       JOIN payments ON payments.id = services.payment_id
       JOIN orders ON orders.id = payments.order_id
       WHERE orders.user_id = ? AND services.status = 'open'
       ORDER BY services.id DESC, items.position ASC`,
    )
    .all(userId)
    .map((value): NodeLine => {
      const row = record(value);
      const key = row.monitor_target_key;
      return {
        kind: "service",
        ref: text(row, "order_ref"),
        position: integer(row, "position"),
        label: text(row, "label"),
        targetKey: typeof key === "string" && key !== "" ? key : null,
      };
    });
  const grants = database
    .prepare(
      `SELECT items.grant_id, items.position, items.label, items.monitor_target
       FROM admin_grant_delivery_items AS items
       JOIN admin_grants AS grants ON grants.id = items.grant_id
       WHERE grants.user_id = ? AND grants.status = 'active' AND grants.delivery_status = 'open'
       ORDER BY items.grant_id DESC, items.position ASC`,
    )
    .all(userId)
    .map((value): NodeLine => {
      const row = record(value);
      const key = row.monitor_target;
      return {
        kind: "grant",
        ref: integer(row, "grant_id"),
        position: integer(row, "position"),
        label: text(row, "label"),
        targetKey: typeof key === "string" && key !== "" ? key : null,
      };
    });
  return [...services, ...grants];
}

/** Resolve each distinct target once; any failure only marks that target's lines unknown. */
export async function resolveNodeStatuses(
  lines: readonly NodeLine[],
  status: (target: string, signal?: AbortSignal) => Promise<MonitorPrivateStatus>,
  signal?: AbortSignal,
): Promise<NodeStatusItem[]> {
  const targets = [...new Set(lines.flatMap((line) => (line.targetKey === null ? [] : [line.targetKey])))];
  const queried = targets.slice(0, NODE_STATUS_MAX_TARGETS);
  const settled = await Promise.allSettled(queried.map((target) => status(target, signal)));
  const byTarget = new Map<string, NodeLineStatus>();
  queried.forEach((target, index) => {
    const result = settled[index];
    byTarget.set(target, result?.status === "fulfilled" ? result.value.status : "unknown");
  });
  return lines.map((line) => {
    const lineStatus: NodeLineStatus = line.targetKey === null ? "unbound" : (byTarget.get(line.targetKey) ?? "unknown");
    return line.kind === "service"
      ? { kind: "service", ref: String(line.ref), position: line.position, label: line.label, status: lineStatus }
      : { kind: "grant", ref: Number(line.ref), position: line.position, label: line.label, status: lineStatus };
  });
}
