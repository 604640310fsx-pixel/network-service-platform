import type { DatabaseConnection } from "../db.js";

export class CatalogDirectoryNotFound extends Error {}

export interface RegionDirectoryItem {
  readonly typeId: string;
  readonly regionId: string;
  readonly isActive: boolean;
}

export interface OperatorDirectoryItem extends RegionDirectoryItem {
  readonly ispId: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Catalog directory invariant failed");
  return value as Record<string, unknown>;
}

function readStatus(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new Error("Catalog directory status invariant failed");
  return value === 1;
}

export function listCatalogDirectory(database: DatabaseConnection): {
  readonly regions: RegionDirectoryItem[];
  readonly operators: OperatorDirectoryItem[];
} {
  const regions = database.prepare(`SELECT plans.type_id, plans.region_id, status.is_active
    FROM (SELECT DISTINCT type_id, region_id FROM sellable_plans) plans
    LEFT JOIN sellable_regions status ON status.type_id = plans.type_id AND status.region_id = plans.region_id
    ORDER BY plans.type_id, plans.region_id`)
    .all().map((value) => {
      const row = record(value);
      if (typeof row.type_id !== "string" || typeof row.region_id !== "string") throw new Error("Catalog directory key invariant failed");
      return { typeId: row.type_id, regionId: row.region_id, isActive: row.is_active === null ? false : readStatus(row.is_active) };
    });
  const operators = database.prepare(`SELECT plans.type_id, plans.region_id, plans.isp_id, status.is_active
    FROM (SELECT DISTINCT type_id, region_id, isp_id FROM sellable_plans) plans
    LEFT JOIN sellable_operators status ON status.type_id = plans.type_id AND status.region_id = plans.region_id AND status.isp_id = plans.isp_id
    ORDER BY plans.type_id, plans.region_id, plans.isp_id`)
    .all().map((value) => {
      const row = record(value);
      if (typeof row.type_id !== "string" || typeof row.region_id !== "string" || typeof row.isp_id !== "string")
        throw new Error("Catalog directory key invariant failed");
      return { typeId: row.type_id, regionId: row.region_id, ispId: row.isp_id,
        isActive: row.is_active === null ? false : readStatus(row.is_active) };
    });
  return { regions, operators };
}

export function isDirectoryEnabled(database: DatabaseConnection, typeId: string, regionId: string, ispId: string): boolean {
  const rows = database.prepare(
    `SELECT r.is_active AS region_active, o.is_active AS operator_active
     FROM sellable_regions r
     JOIN sellable_operators o ON o.type_id = r.type_id AND o.region_id = r.region_id
     WHERE r.type_id = ? AND r.region_id = ? AND o.isp_id = ?`,
  ).all(typeId, regionId, ispId);
  if (rows.length === 0) return false;
  if (rows.length !== 1) throw new Error("Catalog directory key invariant failed");
  const row = record(rows[0]);
  return readStatus(row.region_active) && readStatus(row.operator_active);
}

export function isPlanDirectoryEnabled(database: DatabaseConnection, planId: number): boolean {
  const rows = database.prepare("SELECT type_id, region_id, isp_id FROM sellable_plans WHERE id = ?").all(planId);
  if (rows.length !== 1) return false;
  const row = record(rows[0]);
  if (typeof row.type_id !== "string" || typeof row.region_id !== "string" || typeof row.isp_id !== "string")
    throw new Error("Catalog plan key invariant failed");
  return isDirectoryEnabled(database, row.type_id, row.region_id, row.isp_id);
}

export function updateCatalogDirectoryStatus(database: DatabaseConnection, input: {
  readonly kind: "region" | "operator";
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId?: string;
  readonly isActive: boolean;
  readonly adminUserId: number;
  readonly now: () => Date;
}): RegionDirectoryItem | OperatorDirectoryItem {
  const table = input.kind === "region" ? "sellable_regions" : "sellable_operators";
  const keys = input.kind === "region" ? "type_id = ? AND region_id = ?" : "type_id = ? AND region_id = ? AND isp_id = ?";
  const params = input.kind === "region" ? [input.typeId, input.regionId] : [input.typeId, input.regionId, input.ispId];
  const operation = database.transaction(() => {
    const managedKey = database.prepare(`SELECT 1 FROM sellable_plans WHERE ${keys} LIMIT 1`).all(...params);
    if (managedKey.length !== 1) throw new CatalogDirectoryNotFound("not_found");
    const rows = database.prepare(`SELECT is_active FROM ${table} WHERE ${keys}`).all(...params);
    if (rows.length > 1) throw new Error("Catalog directory key invariant failed");
    const current = rows.length === 0 ? false : readStatus(record(rows[0]).is_active);
    if (current !== input.isActive) {
      const now = input.now().toISOString();
      if (rows.length === 0) {
        if (input.kind === "operator") {
          database.prepare(`INSERT OR IGNORE INTO sellable_regions (type_id, region_id, is_active, updated_at)
            VALUES (?, ?, 0, ?)`).run(input.typeId, input.regionId, now);
        }
        const columns = input.kind === "region" ? "type_id, region_id" : "type_id, region_id, isp_id";
        const placeholders = input.kind === "region" ? "?, ?" : "?, ?, ?";
        database.prepare(`INSERT INTO ${table} (${columns}, is_active, updated_at) VALUES (${placeholders}, 1, ?)`)
          .run(...params, now);
      } else {
        database.prepare(`UPDATE ${table} SET is_active = ?, updated_at = ? WHERE ${keys}`)
          .run(input.isActive ? 1 : 0, now, ...params);
      }
      database.prepare("INSERT INTO audit_log (actor, action, target_ref, created_at) VALUES (?, ?, ?, ?)")
        .run(`admin:${input.adminUserId}`, input.kind === "region" ? "catalog_region_status_updated" : "catalog_operator_status_updated",
          JSON.stringify(params), now);
    }
    return input.kind === "region"
      ? { typeId: input.typeId, regionId: input.regionId, isActive: input.isActive }
      : { typeId: input.typeId, regionId: input.regionId, ispId: input.ispId!, isActive: input.isActive };
  });
  return operation.immediate();
}
