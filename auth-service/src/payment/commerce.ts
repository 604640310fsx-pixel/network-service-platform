import type { DatabaseConnection } from "../db.js";
import { PAYMENT_MAX_SINGLE_FEN } from "./pricing.js";

export class PaymentDomainError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Readonly<Record<string, number>>;

  constructor(
    statusCode: number,
    code: string,
    details: Readonly<Record<string, number>> = {},
  ) {
    super(code);
    this.name = "PaymentDomainError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface PlanSelection {
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
}

export interface SellablePlanRow {
  readonly id: number;
  readonly priceFen: number;
  readonly isActive: boolean;
  readonly totalSlots: number | null;
  readonly occupiedSlots: number;
}

export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function rowRecord(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Commerce database invariant failed");
  }
  return row as Record<string, unknown>;
}

/* 5 元组套餐查找对 spec_id 用 IS 而非 =，与 idx_sellable_plans_unique_combo 的
   COALESCE 表达式索引语义一致，对固定套餐（spec_id 恒为 NULL）安全。
   不在这里过滤 is_active/库存——调用方（报价 vs 释放）各自决定要不要检查。 */
export function findSellablePlan(
  database: DatabaseConnection,
  selection: PlanSelection,
): SellablePlanRow | null {
  const rows = database
    .prepare(
      `SELECT id, price_fen, is_active, total_slots, occupied_slots
       FROM sellable_plans
       WHERE type_id = ? AND region_id = ? AND isp_id = ?
         AND spec_id IS ? AND duration_id = ?`,
    )
    .all(
      selection.typeId,
      selection.regionId,
      selection.ispId,
      selection.specId,
      selection.durationId,
    );
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error("Commerce database invariant failed");
  }
  const value = rowRecord(rows[0]);
  if (
    typeof value.id !== "number" ||
    typeof value.price_fen !== "number" ||
    (value.is_active !== 0 && value.is_active !== 1) ||
    (value.total_slots !== null && typeof value.total_slots !== "number") ||
    typeof value.occupied_slots !== "number"
  ) {
    throw new Error("Commerce database invariant failed");
  }
  return {
    id: value.id,
    priceFen: value.price_fen,
    isActive: value.is_active === 1,
    totalSlots: value.total_slots,
    occupiedSlots: value.occupied_slots,
  };
}

interface CouponRow {
  readonly id: number;
  readonly kind: "fixed" | "percent";
  readonly amountOffFen: number | null;
  readonly percentOff: number | null;
  readonly minAmountFen: number | null;
  readonly scope: "all" | "plans";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly maxRedemptions: number | null;
  readonly redeemedCount: number;
  readonly isActive: boolean;
}

function findCouponByNormalizedCode(
  database: DatabaseConnection,
  normalizedCode: string,
): CouponRow | null {
  const rows = database
    .prepare(
      `SELECT id, kind, amount_off_fen, percent_off, min_amount_fen, scope,
              starts_at, ends_at, max_redemptions, redeemed_count, is_active
       FROM coupons WHERE code = ?`,
    )
    .all(normalizedCode);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error("Commerce database invariant failed");
  }
  const value = rowRecord(rows[0]);
  if (
    typeof value.id !== "number" ||
    (value.kind !== "fixed" && value.kind !== "percent") ||
    (value.amount_off_fen !== null && typeof value.amount_off_fen !== "number") ||
    (value.percent_off !== null && typeof value.percent_off !== "number") ||
    (value.min_amount_fen !== null && typeof value.min_amount_fen !== "number") ||
    (value.scope !== "all" && value.scope !== "plans") ||
    typeof value.starts_at !== "string" ||
    typeof value.ends_at !== "string" ||
    (value.max_redemptions !== null && typeof value.max_redemptions !== "number") ||
    typeof value.redeemed_count !== "number" ||
    (value.is_active !== 0 && value.is_active !== 1)
  ) {
    throw new Error("Commerce database invariant failed");
  }
  return {
    id: value.id,
    kind: value.kind,
    amountOffFen: value.amount_off_fen,
    percentOff: value.percent_off,
    minAmountFen: value.min_amount_fen,
    scope: value.scope,
    startsAt: value.starts_at,
    endsAt: value.ends_at,
    maxRedemptions: value.max_redemptions,
    redeemedCount: value.redeemed_count,
    isActive: value.is_active === 1,
  };
}

function couponAppliesToPlan(
  database: DatabaseConnection,
  couponId: number,
  planId: number,
): boolean {
  return (
    database
      .prepare("SELECT 1 FROM coupon_plans WHERE coupon_id = ? AND plan_id = ?")
      .all(couponId, planId).length === 1
  );
}

function couponDiscountFen(coupon: CouponRow, listPriceFen: number): number {
  if (coupon.kind === "fixed") {
    if (coupon.amountOffFen === null) {
      throw new Error("Commerce database invariant failed");
    }
    return coupon.amountOffFen;
  }
  if (coupon.percentOff === null) {
    throw new Error("Commerce database invariant failed");
  }
  return Math.floor((listPriceFen * coupon.percentOff) / 100);
}

export interface QuoteResult {
  readonly planId: number;
  readonly listPriceFen: number;
  readonly discountFen: number;
  readonly amountFen: number;
  readonly couponId: number | null;
  readonly couponCode: string | null;
}

export interface QuoteInput {
  readonly selection: PlanSelection;
  readonly couponCode: string | null;
  readonly now: () => Date;
}

/* 唯一报价/核价入口：POST /api/pay/quote 与创建订单都调用同一份逻辑，
   保证"服务器重新计算"永远只有一处实现。不占用库存、不占用优惠券——
   只读校验 + 计算，调用方（订单创建）需要在同一事务内另行调用
   occupyPlanAndCoupon 完成原子占用。 */
export function resolveQuote(
  database: DatabaseConnection,
  input: QuoteInput,
): QuoteResult {
  const plan = findSellablePlan(database, input.selection);
  if (plan === null || !plan.isActive) {
    throw new PaymentDomainError(409, "plan_unavailable");
  }
  if (plan.totalSlots !== null && plan.occupiedSlots >= plan.totalSlots) {
    throw new PaymentDomainError(409, "sold_out");
  }
  const listPriceFen = plan.priceFen;

  let couponId: number | null = null;
  let couponCode: string | null = null;
  let discountFen = 0;

  if (input.couponCode !== null) {
    const normalized = normalizeCouponCode(input.couponCode);
    if (!COUPON_CODE_PATTERN.test(normalized)) {
      throw new PaymentDomainError(409, "coupon_invalid");
    }
    const coupon = findCouponByNormalizedCode(database, normalized);
    const nowIso = input.now().toISOString();
    if (
      coupon === null ||
      !coupon.isActive ||
      nowIso < coupon.startsAt ||
      nowIso > coupon.endsAt ||
      (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) ||
      (coupon.minAmountFen !== null && listPriceFen < coupon.minAmountFen) ||
      (coupon.scope === "plans" && !couponAppliesToPlan(database, coupon.id, plan.id))
    ) {
      throw new PaymentDomainError(409, "coupon_invalid");
    }
    discountFen = couponDiscountFen(coupon, listPriceFen);
    if (discountFen <= 0) {
      throw new PaymentDomainError(409, "coupon_invalid");
    }
    couponId = coupon.id;
    couponCode = normalized;
  }

  const amountFen = listPriceFen - discountFen;
  // 折后金额必须大于 0；不允许静默钳制成 ¥0.01——直接拒绝，不生成任何订单。
  if (amountFen <= 0) {
    throw new PaymentDomainError(409, "coupon_invalid");
  }
  if (amountFen > PAYMENT_MAX_SINGLE_FEN) {
    throw new PaymentDomainError(409, "amount_limit_exceeded", {
      maxSingleFen: PAYMENT_MAX_SINGLE_FEN,
    });
  }

  return { planId: plan.id, listPriceFen, discountFen, amountFen, couponId, couponCode };
}

export interface OccupyInput {
  readonly planId: number;
  readonly couponId: number | null;
  readonly orderId: number;
  readonly userId: number | null;
  readonly discountFen: number;
  readonly now: () => Date;
}

/* 必须在与订单/支付插入相同的 IMMEDIATE 事务内调用。原子条件 UPDATE
   （WHERE 里带容量/次数判定）是唯一真源；由于 better-sqlite3 同步事务不会
   与其它调用交叉执行，这里的两条 UPDATE 天然不会与并发请求竞争。 */
export function occupyPlanAndCoupon(
  database: DatabaseConnection,
  input: OccupyInput,
): void {
  const nowIso = input.now().toISOString();
  const planResult = database
    .prepare(
      `UPDATE sellable_plans SET occupied_slots = occupied_slots + 1, updated_at = ?
       WHERE id = ? AND is_active = 1 AND (total_slots IS NULL OR occupied_slots < total_slots)`,
    )
    .run(nowIso, input.planId);
  if (planResult.changes !== 1) {
    throw new PaymentDomainError(409, "sold_out");
  }

  if (input.couponId !== null) {
    const couponResult = database
      .prepare(
        `UPDATE coupons SET redeemed_count = redeemed_count + 1, updated_at = ?
         WHERE id = ? AND is_active = 1
           AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)`,
      )
      .run(nowIso, input.couponId);
    if (couponResult.changes !== 1) {
      throw new PaymentDomainError(409, "coupon_invalid");
    }
    database
      .prepare(
        `INSERT INTO coupon_redemptions (coupon_id, order_id, user_id, discount_fen, redeemed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.couponId, input.orderId, input.userId, input.discountFen, nowIso);
  }
}

/* 从原订单的 coupon_redemptions 关联读取优惠码（供 retry 复用，不接受客户端
   临时更换）。找不到有效兑换记录时返回 null——表示原订单当时无券，retry 也无券。 */
export function findRedeemedCouponCode(
  database: DatabaseConnection,
  orderId: number,
): string | null {
  const rows = database
    .prepare(
      `SELECT coupons.code AS code
       FROM coupon_redemptions
       JOIN coupons ON coupons.id = coupon_redemptions.coupon_id
       WHERE coupon_redemptions.order_id = ?`,
    )
    .all(orderId);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error("Commerce database invariant failed");
  }
  const value = rowRecord(rows[0]);
  if (typeof value.code !== "string") {
    throw new Error("Commerce database invariant failed");
  }
  return value.code;
}

/* 关闭未付款订单时的唯一释放入口：只按 orders 表已有的 5 元组重新定位套餐
   （不管当前 is_active，套餐可能已被停售，但占用计数必须能回退），
   以及未释放的优惠券兑换记录。调用方（finalizeClosed）必须只在
   pending→closed 分支调用一次；此函数自身的 WHERE occupied_slots > 0 /
   released_at IS NULL 守卫保证重复调用是幂等的。 */
export function releasePlanAndCouponForOrder(
  database: DatabaseConnection,
  orderId: number,
  now: () => Date,
): void {
  const nowIso = now().toISOString();
  const orderRows = database
    .prepare(
      `SELECT type_id, region_id, isp_id, spec_id, duration_id
       FROM orders WHERE id = ?`,
    )
    .all(orderId);
  if (orderRows.length === 1) {
    const value = rowRecord(orderRows[0]);
    if (
      typeof value.type_id !== "string" ||
      typeof value.region_id !== "string" ||
      typeof value.isp_id !== "string" ||
      (value.spec_id !== null && typeof value.spec_id !== "string") ||
      typeof value.duration_id !== "string"
    ) {
      throw new Error("Commerce database invariant failed");
    }
    const plan = findSellablePlan(database, {
      typeId: value.type_id,
      regionId: value.region_id,
      ispId: value.isp_id,
      specId: value.spec_id,
      durationId: value.duration_id,
    });
    if (plan !== null) {
      database
        .prepare(
          `UPDATE sellable_plans SET occupied_slots = occupied_slots - 1, updated_at = ?
           WHERE id = ? AND occupied_slots > 0`,
        )
        .run(nowIso, plan.id);
    }
  }

  const redemptionRows = database
    .prepare(
      "SELECT coupon_id FROM coupon_redemptions WHERE order_id = ? AND released_at IS NULL",
    )
    .all(orderId);
  if (redemptionRows.length === 1) {
    const value = rowRecord(redemptionRows[0]);
    if (typeof value.coupon_id !== "number") {
      throw new Error("Commerce database invariant failed");
    }
    database
      .prepare(
        `UPDATE coupons SET redeemed_count = redeemed_count - 1, updated_at = ?
         WHERE id = ? AND redeemed_count > 0`,
      )
      .run(nowIso, value.coupon_id);
    database
      .prepare(
        "UPDATE coupon_redemptions SET released_at = ? WHERE order_id = ? AND released_at IS NULL",
      )
      .run(nowIso, orderId);
  }
}

/* ---- 管理端：套餐与库存 ---- */

export interface AdminPlanItem {
  readonly id: number;
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly priceFen: number;
  readonly isActive: boolean;
  readonly totalSlots: number | null;
  readonly occupiedSlots: number;
}

function parseAdminPlanRow(row: unknown): AdminPlanItem {
  const value = rowRecord(row);
  if (
    typeof value.id !== "number" ||
    typeof value.type_id !== "string" ||
    typeof value.region_id !== "string" ||
    typeof value.isp_id !== "string" ||
    (value.spec_id !== null && typeof value.spec_id !== "string") ||
    typeof value.duration_id !== "string" ||
    typeof value.price_fen !== "number" ||
    (value.is_active !== 0 && value.is_active !== 1) ||
    (value.total_slots !== null && typeof value.total_slots !== "number") ||
    typeof value.occupied_slots !== "number"
  ) {
    throw new Error("Commerce database invariant failed");
  }
  return {
    id: value.id,
    typeId: value.type_id,
    regionId: value.region_id,
    ispId: value.isp_id,
    specId: value.spec_id,
    durationId: value.duration_id,
    priceFen: value.price_fen,
    isActive: value.is_active === 1,
    totalSlots: value.total_slots,
    occupiedSlots: value.occupied_slots,
  };
}

const ADMIN_PLAN_COLUMNS = `
  id, type_id, region_id, isp_id, spec_id, duration_id,
  price_fen, is_active, total_slots, occupied_slots
`;

export function listSellablePlans(database: DatabaseConnection): AdminPlanItem[] {
  return database
    .prepare(
      `SELECT ${ADMIN_PLAN_COLUMNS} FROM sellable_plans
       ORDER BY type_id, region_id, isp_id, spec_id, duration_id`,
    )
    .all()
    .map(parseAdminPlanRow);
}

export interface UpdateSellablePlanInput {
  readonly planId: number;
  readonly priceFen?: number;
  readonly isActive?: boolean;
  readonly totalSlots?: number | null;
  readonly adminUserId: number;
  readonly now: () => Date;
}

/* 调价只影响新订单：这里只改 sellable_plans 当前行，历史订单的 orders.amount_fen
   本就是创建时的不可变快照，不受影响。priceFen 变化时额外写一条历史记录。 */
export function updateSellablePlan(
  database: DatabaseConnection,
  input: UpdateSellablePlanInput,
): AdminPlanItem {
  const nowIso = input.now().toISOString();
  const operation = database.transaction(() => {
    const rows = database
      .prepare(`SELECT ${ADMIN_PLAN_COLUMNS} FROM sellable_plans WHERE id = ?`)
      .all(input.planId);
    if (rows.length !== 1) {
      throw new PaymentDomainError(404, "not_found");
    }
    const current = parseAdminPlanRow(rows[0]);

    if (input.totalSlots !== undefined && input.totalSlots !== null) {
      if (input.totalSlots < current.occupiedSlots) {
        throw new PaymentDomainError(409, "invalid_slots");
      }
    }

    const nextPriceFen = input.priceFen ?? current.priceFen;
    const nextIsActive = input.isActive ?? current.isActive;
    const nextTotalSlots = input.totalSlots === undefined ? current.totalSlots : input.totalSlots;

    database
      .prepare(
        `UPDATE sellable_plans
         SET price_fen = ?, is_active = ?, total_slots = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextPriceFen, nextIsActive ? 1 : 0, nextTotalSlots, nowIso, input.planId);

    if (input.priceFen !== undefined && input.priceFen !== current.priceFen) {
      database
        .prepare(
          `INSERT INTO sellable_plan_price_history (
             plan_id, old_price_fen, new_price_fen, changed_by_admin_id, changed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.planId, current.priceFen, input.priceFen, input.adminUserId, nowIso);
    }

    const updatedRows = database
      .prepare(`SELECT ${ADMIN_PLAN_COLUMNS} FROM sellable_plans WHERE id = ?`)
      .all(input.planId);
    if (updatedRows.length !== 1) {
      throw new Error("Commerce database invariant failed");
    }
    return parseAdminPlanRow(updatedRows[0]);
  });
  return operation.immediate();
}

/* ---- 管理端：优惠券 ---- */

export interface AdminCouponItem {
  readonly id: number;
  readonly code: string;
  readonly kind: "fixed" | "percent";
  readonly amountOffFen: number | null;
  readonly percentOff: number | null;
  readonly minAmountFen: number | null;
  readonly scope: "all" | "plans";
  readonly planIds: readonly number[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly maxRedemptions: number | null;
  readonly redeemedCount: number;
  readonly isActive: boolean;
  readonly createdAt: string;
}

const ADMIN_COUPON_COLUMNS = `
  id, code, kind, amount_off_fen, percent_off, min_amount_fen, scope,
  starts_at, ends_at, max_redemptions, redeemed_count, is_active, created_at
`;

function parseAdminCouponRow(
  database: DatabaseConnection,
  row: unknown,
): AdminCouponItem {
  const value = rowRecord(row);
  if (
    typeof value.id !== "number" ||
    typeof value.code !== "string" ||
    (value.kind !== "fixed" && value.kind !== "percent") ||
    (value.amount_off_fen !== null && typeof value.amount_off_fen !== "number") ||
    (value.percent_off !== null && typeof value.percent_off !== "number") ||
    (value.min_amount_fen !== null && typeof value.min_amount_fen !== "number") ||
    (value.scope !== "all" && value.scope !== "plans") ||
    typeof value.starts_at !== "string" ||
    typeof value.ends_at !== "string" ||
    (value.max_redemptions !== null && typeof value.max_redemptions !== "number") ||
    typeof value.redeemed_count !== "number" ||
    (value.is_active !== 0 && value.is_active !== 1) ||
    typeof value.created_at !== "string"
  ) {
    throw new Error("Commerce database invariant failed");
  }
  const planIdRows = database
    .prepare("SELECT plan_id FROM coupon_plans WHERE coupon_id = ? ORDER BY plan_id")
    .all(value.id);
  const planIds = planIdRows.map((planRow) => {
    const planValue = rowRecord(planRow);
    if (typeof planValue.plan_id !== "number") {
      throw new Error("Commerce database invariant failed");
    }
    return planValue.plan_id;
  });
  return {
    id: value.id,
    code: value.code,
    kind: value.kind,
    amountOffFen: value.amount_off_fen,
    percentOff: value.percent_off,
    minAmountFen: value.min_amount_fen,
    scope: value.scope,
    planIds,
    startsAt: value.starts_at,
    endsAt: value.ends_at,
    maxRedemptions: value.max_redemptions,
    redeemedCount: value.redeemed_count,
    isActive: value.is_active === 1,
    createdAt: value.created_at,
  };
}

export function listCoupons(database: DatabaseConnection): AdminCouponItem[] {
  return database
    .prepare(`SELECT ${ADMIN_COUPON_COLUMNS} FROM coupons ORDER BY id DESC`)
    .all()
    .map((row) => parseAdminCouponRow(database, row));
}

export interface CreateCouponInput {
  readonly code: string;
  readonly kind: "fixed" | "percent";
  readonly amountOffFen: number | null;
  readonly percentOff: number | null;
  readonly minAmountFen: number | null;
  readonly scope: "all" | "plans";
  readonly planIds: readonly number[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly maxRedemptions: number | null;
  readonly adminUserId: number;
  readonly now: () => Date;
}

export function createCoupon(
  database: DatabaseConnection,
  input: CreateCouponInput,
): AdminCouponItem {
  const normalizedCode = normalizeCouponCode(input.code);
  if (!COUPON_CODE_PATTERN.test(normalizedCode)) {
    throw new PaymentDomainError(400, "invalid_coupon_code");
  }
  if (input.kind === "fixed" && (input.amountOffFen === null || input.amountOffFen <= 0)) {
    throw new PaymentDomainError(400, "invalid_coupon_amount");
  }
  if (
    input.kind === "percent" &&
    (input.percentOff === null || input.percentOff < 1 || input.percentOff > 99)
  ) {
    throw new PaymentDomainError(400, "invalid_coupon_amount");
  }
  if (input.scope === "plans" && input.planIds.length === 0) {
    throw new PaymentDomainError(400, "invalid_coupon_scope");
  }
  if (!(input.endsAt > input.startsAt)) {
    throw new PaymentDomainError(400, "invalid_coupon_window");
  }
  const nowIso = input.now().toISOString();
  const operation = database.transaction(() => {
    if (
      database.prepare("SELECT id FROM coupons WHERE code = ?").all(normalizedCode).length !== 0
    ) {
      throw new PaymentDomainError(409, "coupon_code_taken");
    }
    database
      .prepare(
        `INSERT INTO coupons (
           code, kind, amount_off_fen, percent_off, min_amount_fen, scope,
           starts_at, ends_at, max_redemptions, redeemed_count, is_active,
           created_by_admin_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
      )
      .run(
        normalizedCode,
        input.kind,
        input.kind === "fixed" ? input.amountOffFen : null,
        input.kind === "percent" ? input.percentOff : null,
        input.minAmountFen,
        input.scope,
        input.startsAt,
        input.endsAt,
        input.maxRedemptions,
        input.adminUserId,
        nowIso,
        nowIso,
      );
    const idRows = database
      .prepare("SELECT id FROM coupons WHERE code = ?")
      .all(normalizedCode);
    const idValue = rowRecord(idRows[0]);
    if (typeof idValue.id !== "number") {
      throw new Error("Commerce database invariant failed");
    }
    const couponId = idValue.id;
    if (input.scope === "plans") {
      const insertLink = database.prepare(
        "INSERT INTO coupon_plans (coupon_id, plan_id) VALUES (?, ?)",
      );
      for (const planId of input.planIds) {
        insertLink.run(couponId, planId);
      }
    }
    const rows = database
      .prepare(`SELECT ${ADMIN_COUPON_COLUMNS} FROM coupons WHERE id = ?`)
      .all(couponId);
    return parseAdminCouponRow(database, rows[0]);
  });
  return operation.immediate();
}

export interface UpdateCouponInput {
  readonly couponId: number;
  readonly isActive?: boolean;
  readonly endsAt?: string;
  readonly maxRedemptions?: number | null;
  readonly now: () => Date;
}

/* 创建后不可回改 code/kind/amountOffFen/percentOff/minAmountFen/scope/planIds/
   startsAt——只允许 isActive/endsAt/maxRedemptions，且 maxRedemptions 不得
   调低到已占用次数以下。 */
export function updateCoupon(
  database: DatabaseConnection,
  input: UpdateCouponInput,
): AdminCouponItem {
  const nowIso = input.now().toISOString();
  const operation = database.transaction(() => {
    const rows = database
      .prepare(`SELECT ${ADMIN_COUPON_COLUMNS} FROM coupons WHERE id = ?`)
      .all(input.couponId);
    if (rows.length !== 1) {
      throw new PaymentDomainError(404, "not_found");
    }
    const current = parseAdminCouponRow(database, rows[0]);
    if (
      input.maxRedemptions !== undefined &&
      input.maxRedemptions !== null &&
      input.maxRedemptions < current.redeemedCount
    ) {
      throw new PaymentDomainError(409, "invalid_max_redemptions");
    }
    if (input.endsAt !== undefined && !(input.endsAt > current.startsAt)) {
      throw new PaymentDomainError(400, "invalid_coupon_window");
    }
    const nextIsActive = input.isActive ?? current.isActive;
    const nextEndsAt = input.endsAt ?? current.endsAt;
    const nextMaxRedemptions =
      input.maxRedemptions === undefined ? current.maxRedemptions : input.maxRedemptions;
    database
      .prepare(
        `UPDATE coupons SET is_active = ?, ends_at = ?, max_redemptions = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextIsActive ? 1 : 0, nextEndsAt, nextMaxRedemptions, nowIso, input.couponId);
    const updatedRows = database
      .prepare(`SELECT ${ADMIN_COUPON_COLUMNS} FROM coupons WHERE id = ?`)
      .all(input.couponId);
    return parseAdminCouponRow(database, updatedRows[0]);
  });
  return operation.immediate();
}

export interface CouponRedemptionItem {
  readonly orderRef: string;
  readonly discountFen: number;
  readonly redeemedAt: string;
  readonly releasedAt: string | null;
}

export function listCouponRedemptions(
  database: DatabaseConnection,
  couponId: number,
): CouponRedemptionItem[] {
  return database
    .prepare(
      `SELECT orders.order_ref AS order_ref, coupon_redemptions.discount_fen AS discount_fen,
              coupon_redemptions.redeemed_at AS redeemed_at, coupon_redemptions.released_at AS released_at
       FROM coupon_redemptions
       JOIN orders ON orders.id = coupon_redemptions.order_id
       WHERE coupon_redemptions.coupon_id = ?
       ORDER BY coupon_redemptions.id DESC`,
    )
    .all(couponId)
    .map((row) => {
      const value = rowRecord(row);
      if (
        typeof value.order_ref !== "string" ||
        typeof value.discount_fen !== "number" ||
        typeof value.redeemed_at !== "string" ||
        (value.released_at !== null && typeof value.released_at !== "string")
      ) {
        throw new Error("Commerce database invariant failed");
      }
      return {
        orderRef: value.order_ref,
        discountFen: value.discount_fen,
        redeemedAt: value.redeemed_at,
        releasedAt: value.released_at,
      };
    });
}
