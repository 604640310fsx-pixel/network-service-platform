import type { DatabaseConnection } from "../db.js";
import {
  refreshExpiredPendingPayment,
  type PaymentRefreshDependencies,
} from "./payment-refresh.js";

/* "过期两分钟后处理"：绝对期限（payments.reserved_until，创建时 = created_at
   + 30 分钟）再加 2 分钟宽限，两者都过去才进入主动关单/本地关闭的判定。 */
export const ORDER_EXPIRY_GRACE_MS = 2 * 60 * 1_000;
export const ORDER_EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

export type OrderExpirySweepDependencies = PaymentRefreshDependencies;

interface ExpiredPaymentRow {
  readonly paymentId: number;
  readonly outTradeNo: string;
  readonly amountFen: number;
}

function findExpiredPendingPayments(
  database: DatabaseConnection,
  cutoffIso: string,
): ExpiredPaymentRow[] {
  return database
    .prepare(
      `SELECT id, out_trade_no, amount_fen FROM payments
       WHERE status = 'pending' AND reserved_until IS NOT NULL AND reserved_until < ?
       ORDER BY id ASC`,
    )
    .all(cutoffIso)
    .map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("Order expiry database invariant failed");
      }
      const value = row as Record<string, unknown>;
      if (
        typeof value.id !== "number" ||
        typeof value.out_trade_no !== "string" ||
        typeof value.amount_fen !== "number"
      ) {
        throw new Error("Order expiry database invariant failed");
      }
      return { paymentId: value.id, outTradeNo: value.out_trade_no, amountFen: value.amount_fen };
    });
}

/* 扫描所有到期两分钟宽限都已过去、仍是 pending 的支付，逐一走
   refreshExpiredPendingPayment——与 GET 路由共用同一份支付宝权威判定，
   永不本地自行宣布已付款订单关闭。返回值仅供测试/可观测性使用。 */
export async function sweepExpiredPendingPayments(
  dependencies: OrderExpirySweepDependencies,
): Promise<{ readonly scanned: number }> {
  const now = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Order expiry time source is invalid");
  }
  const cutoffIso = new Date(now.getTime() - ORDER_EXPIRY_GRACE_MS).toISOString();
  const targets = findExpiredPendingPayments(dependencies.database, cutoffIso);
  for (const target of targets) {
    await refreshExpiredPendingPayment(dependencies, target);
  }
  return { scanned: targets.length };
}

export interface OrderExpiryScheduler {
  readonly stop: () => void;
}

/* 进程内 setInterval 调度器（不依赖 cron/systemd）。running 标记禁止任务
   重叠：若上一轮 sweep 尚未完成，下一次 tick 直接跳过，不并发触发第二轮。
   timer.unref() 避免这个定时器单独维持进程存活（与测试套件无关——测试
   从不调用这个函数，只有 server.ts 的真实启动路径会）。 */
export function startOrderExpirySweep(
  dependencies: OrderExpirySweepDependencies,
  intervalMs: number = ORDER_EXPIRY_SWEEP_INTERVAL_MS,
): OrderExpiryScheduler {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepExpiredPendingPayments(dependencies)
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
