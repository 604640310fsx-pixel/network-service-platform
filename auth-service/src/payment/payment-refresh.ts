import type { DatabaseConnection } from "../db.js";
import {
  closeAlipayTrade,
  formatFenAsYuan,
  isTradeNotExist,
  queryAlipayTrade,
  type AlipaySdkLike,
  type AlipayTradeQueryResult,
} from "./alipay.js";
import { claimAlipayQuery } from "./orders.js";
import {
  acceptPendingPaymentEvent,
  auditPaymentFailure,
  finalizeClosed,
  finalizePaid,
  type PaymentEventInput,
} from "./state-machine.js";

/* 支付域内的支付宝刷新逻辑，供 HTTP 路由（GET /api/pay/orders/:orderRef）
   与到期 sweep 共用同一份实现。只依赖 payment/ 内部类型，不 import 任何
   http/ 模块——避免 payment 反向依赖 HTTP 路由层。 */
export interface PaymentRefreshDependencies {
  readonly database: DatabaseConnection;
  readonly appId: string;
  readonly sellerId: string;
  readonly sdk: AlipaySdkLike;
  readonly now?: () => Date;
}

export interface RefreshTarget {
  readonly outTradeNo: string;
  readonly paymentId: number;
  readonly amountFen: number;
}

// Historical payments can belong to a different merchant app. Reject them
// before even claiming the query throttle; a provider miss is not evidence
// that such a payment is unpaid or may be closed by the current merchant.
function hasBoundPaymentTarget(
  dependencies: PaymentRefreshDependencies,
  target: RefreshTarget,
): boolean {
  if (!Number.isSafeInteger(target.paymentId) || target.paymentId <= 0 ||
      !Number.isSafeInteger(target.amountFen) || target.amountFen <= 0 ||
      typeof target.outTradeNo !== "string" || target.outTradeNo.length === 0 ||
      typeof dependencies.appId !== "string" || dependencies.appId.length === 0) return false;
  const rows = dependencies.database.prepare(`
    SELECT p.out_trade_no, p.amount_fen, p.currency, p.app_id, p.status,
           o.amount_fen AS order_amount_fen, o.currency AS order_currency,
           o.status AS order_status
    FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?
  `).all(target.paymentId);
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
  const payment = row as Record<string, unknown>;
  return payment.app_id === dependencies.appId &&
    payment.out_trade_no === target.outTradeNo &&
    payment.amount_fen === target.amountFen && payment.order_amount_fen === target.amountFen &&
    payment.currency === "CNY" && payment.order_currency === "CNY" &&
    (payment.status === "pending" || payment.status === "closed") &&
    payment.order_status === payment.status;
}

type ValidatedAlipayTradeQueryResult = AlipayTradeQueryResult & {
  readonly tradeNo: string;
  readonly tradeStatus: string;
  readonly totalAmount: string;
  readonly totalAmountFen: number;
};

type QueryDiagnosticSource =
  | "provider_response"
  | "provider_exception"
  | "local_validation";

type QueryRejectionReason =
  | "unrecognized_response"
  | "out_trade_mismatch"
  | "missing_trade_no"
  | "amount_mismatch"
  | "missing_status";

const SAFE_PROVIDER_CODE_PATTERN = /^[A-Z0-9_.-]{1,64}$/u;

function sanitizeProviderCode(value: string | null): string | null {
  return value !== null && SAFE_PROVIDER_CODE_PATTERN.test(value) ? value : null;
}

function logAlipayQueryDiagnostic(input: {
  readonly event: "query_rejected" | "query_failed";
  readonly source: QueryDiagnosticSource;
  readonly providerCode: string | null;
  readonly providerSubCode: string | null;
  readonly localRejectionReason: QueryRejectionReason | null;
}): void {
  console.warn(
    JSON.stringify({
      event: input.event,
      source: input.source,
      provider_code: sanitizeProviderCode(input.providerCode),
      provider_sub_code: sanitizeProviderCode(input.providerSubCode),
      local_rejection_reason: input.localRejectionReason,
    }),
  );
}

function getLocalRejectionReason(
  queried: AlipayTradeQueryResult,
  target: RefreshTarget,
): Exclude<QueryRejectionReason, "unrecognized_response"> | null {
  if (queried.outTradeNo !== target.outTradeNo) {
    return "out_trade_mismatch";
  }
  if (queried.tradeNo === null) {
    return "missing_trade_no";
  }
  if (
    queried.totalAmount === null ||
    queried.totalAmountFen === null ||
    queried.totalAmountFen !== target.amountFen
  ) {
    return "amount_mismatch";
  }
  if (queried.tradeStatus === null) {
    return "missing_status";
  }
  return null;
}

interface QueriedTrade {
  readonly queried: AlipayTradeQueryResult;
  /* Null whenever the provider answer failed provider-shape or local validation;
     the raw queried row is still returned so callers can inspect the raw status. */
  readonly event: PaymentEventInput | null;
}

async function queryTrade(
  dependencies: PaymentRefreshDependencies,
  target: RefreshTarget,
): Promise<QueriedTrade | null> {
  if (!hasBoundPaymentTarget(dependencies, target)) return null;
  try {
    const queried = await queryAlipayTrade(dependencies.sdk, target.outTradeNo);
    if (!hasBoundPaymentTarget(dependencies, target)) return null;
    if (!queried.recognized) {
      logAlipayQueryDiagnostic({
        event: "query_rejected",
        source: "provider_response",
        providerCode: queried.code,
        providerSubCode: queried.subCode,
        localRejectionReason: "unrecognized_response",
      });
      auditPaymentFailure(dependencies, "payment.query_rejected", target.outTradeNo);
      return { queried, event: null };
    }

    const localRejectionReason = getLocalRejectionReason(queried, target);
    if (localRejectionReason !== null) {
      logAlipayQueryDiagnostic({
        event: "query_rejected",
        source: "local_validation",
        providerCode: null,
        providerSubCode: null,
        localRejectionReason,
      });
      auditPaymentFailure(dependencies, "payment.query_rejected", target.outTradeNo);
      return { queried, event: null };
    }
    const validatedQuery = queried as ValidatedAlipayTradeQueryResult;
    return {
      queried,
      event: {
        outTradeNo: target.outTradeNo,
        tradeNo: validatedQuery.tradeNo,
        tradeStatus: validatedQuery.tradeStatus,
        totalAmount: validatedQuery.totalAmount,
        totalAmountFen: validatedQuery.totalAmountFen,
        appId: dependencies.appId,
        sellerId: dependencies.sellerId,
      },
    };
  } catch {
    if (!hasBoundPaymentTarget(dependencies, target)) return null;
    logAlipayQueryDiagnostic({
      event: "query_failed",
      source: "provider_exception",
      providerCode: null,
      providerSubCode: null,
      localRejectionReason: null,
    });
    auditPaymentFailure(dependencies, "payment.query_failed", target.outTradeNo);
    return null;
  }
}

async function queryAndDispatch(
  dependencies: PaymentRefreshDependencies,
  target: RefreshTarget,
): Promise<QueriedTrade | null> {
  const result = await queryTrade(dependencies, target);
  if (result === null) {
    return null;
  }
  const { event } = result;
  if (event !== null) {
    if (event.tradeStatus === "TRADE_SUCCESS" || event.tradeStatus === "TRADE_FINISHED") {
      finalizePaid(dependencies, event);
    } else if (event.tradeStatus === "TRADE_CLOSED") {
      finalizeClosed(dependencies, event);
    } else if (event.tradeStatus === "WAIT_BUYER_PAY") {
      acceptPendingPaymentEvent(dependencies, event);
    }
  }
  return result;
}

/* 关单观察结果：只把权威终态交还给调用方，由调用方在自己的事务里
   finalizePaid/finalizeClosed 并原子记录管理表。观察本身不写任何本地状态；
   未知/失败一律 unknown，绝不以推测充当已关闭。 */
export type PendingTradeObservation =
  | { readonly kind: "paid" | "closed"; readonly event: PaymentEventInput }
  | { readonly kind: "unknown" };

function observationFromEvent(event: PaymentEventInput | null): PendingTradeObservation | null {
  if (event === null) return null;
  if (event.tradeStatus === "TRADE_SUCCESS" || event.tradeStatus === "TRADE_FINISHED") {
    return { kind: "paid", event };
  }
  if (event.tradeStatus === "TRADE_CLOSED") return { kind: "closed", event };
  return null;
}

export async function observePendingTradeForCancel(
  dependencies: PaymentRefreshDependencies,
  target: RefreshTarget,
): Promise<PendingTradeObservation> {
  if (!hasBoundPaymentTarget(dependencies, target)) return { kind: "unknown" };
  // Same 15s provider throttle as the status refresh and the sweep: a retried
  // observation inside the window yields unknown (503), never a guessed close.
  if (!claimAlipayQuery(dependencies, target.paymentId)) {
    return { kind: "unknown" };
  }
  const syntheticClosed = (): PendingTradeObservation => ({
    kind: "closed",
    event: {
      outTradeNo: target.outTradeNo,
      tradeNo: `LOCAL-CANCEL-${target.outTradeNo}`,
      tradeStatus: "TRADE_CLOSED",
      totalAmount: formatFenAsYuan(target.amountFen),
      totalAmountFen: target.amountFen,
      appId: dependencies.appId,
      sellerId: dependencies.sellerId,
    },
  });
  const first = await queryTrade(dependencies, target);
  if (first === null) return { kind: "unknown" };
  const direct = observationFromEvent(first.event);
  if (direct !== null) return direct;
  if (first.event?.tradeStatus === "WAIT_BUYER_PAY") {
    if (!hasBoundPaymentTarget(dependencies, target)) return { kind: "unknown" };
    try {
      await closeAlipayTrade(dependencies.sdk, target.outTradeNo);
    } catch {
      if (!hasBoundPaymentTarget(dependencies, target)) return { kind: "unknown" };
      auditPaymentFailure(dependencies, "payment.close_failed", target.outTradeNo);
      return { kind: "unknown" };
    }
    // 复查：买家在关单前后完成支付则 paid 胜出；复查失败一律 unknown。
    const second = await queryTrade(dependencies, target);
    if (second === null) return { kind: "unknown" };
    const mapped = observationFromEvent(second.event);
    if (mapped !== null) return mapped;
    if (isTradeNotExist(second.queried) && second.queried.tradeStatus === null) return syntheticClosed();
    return { kind: "unknown" };
  }
  if (isTradeNotExist(first.queried) && first.queried.tradeStatus === null) return syntheticClosed();
  return { kind: "unknown" };
}

/* 普通路径：GET /api/pay/orders/:orderRef 触发的一次性查询+分发，
   行为与到期 sweep 引入前完全一致（不做关单、不把 TRADE_NOT_EXIST
   当作可关闭信号）。claimAlipayQuery 的 15 秒节流不变。 */
export async function refreshPaymentFromAlipay(
  dependencies: PaymentRefreshDependencies,
  target: RefreshTarget,
): Promise<void> {
  if (!hasBoundPaymentTarget(dependencies, target)) return;
  if (!claimAlipayQuery(dependencies, target.paymentId)) {
    return;
  }
  await queryAndDispatch(dependencies, target);
}

/* 到期宽限后的主动处理路径：只应在 payments.reserved_until + 2 分钟宽限
   都已过去时调用（由调用方——sweep——负责按此条件筛选）。
   - TRADE_SUCCESS/TRADE_FINISHED/TRADE_CLOSED：queryAndDispatch 内部已经
     走现有 finalizePaid/finalizeClosed，任何竞态都优先 paid。
   - WAIT_BUYER_PAY：主动调用 alipay.trade.close，再查一次；
     只有复查确认关闭（或复查发现已付款）才会真正转移状态，
     关单/复查失败则保持 pending，不释放。
   - ACQ.TRADE_NOT_EXIST：走与真实 TRADE_CLOSED 完全相同的 finalizeClosed
     路径（合成事件，不写 payment_notifications），允许本地关闭并释放。
   - 查询失败、未知状态：保持 pending，不释放（queryAndDispatch 已 audit）。 */
export async function refreshExpiredPendingPayment(
  dependencies: PaymentRefreshDependencies,
  target: RefreshTarget,
): Promise<void> {
  if (!hasBoundPaymentTarget(dependencies, target)) return;
  if (!claimAlipayQuery(dependencies, target.paymentId)) {
    return;
  }
  const first = await queryAndDispatch(dependencies, target);
  if (first === null) {
    return;
  }
  const { queried, event } = first;
  if (
    queried.tradeStatus === "TRADE_SUCCESS" ||
    queried.tradeStatus === "TRADE_FINISHED" ||
    queried.tradeStatus === "TRADE_CLOSED"
  ) {
    return;
  }

  if (event?.tradeStatus === "WAIT_BUYER_PAY") {
    if (!hasBoundPaymentTarget(dependencies, target)) return;
    try {
      await closeAlipayTrade(dependencies.sdk, target.outTradeNo);
    } catch {
      if (!hasBoundPaymentTarget(dependencies, target)) return;
      auditPaymentFailure(dependencies, "payment.close_failed", target.outTradeNo);
      return;
    }
    // 复查：若买家恰好在关单前后完成支付，queryAndDispatch 会优先分发为 paid。
    await queryAndDispatch(dependencies, target);
    return;
  }

  if (isTradeNotExist(queried) && queried.tradeStatus === null) {
    const result = finalizeClosed(dependencies, {
      outTradeNo: target.outTradeNo,
      tradeNo: `LOCAL-EXPIRED-${target.outTradeNo}`,
      tradeStatus: "TRADE_CLOSED",
      totalAmount: formatFenAsYuan(target.amountFen),
      totalAmountFen: target.amountFen,
      appId: dependencies.appId,
      sellerId: dependencies.sellerId,
    });
    if (result === "finalized") {
      auditPaymentFailure(dependencies, "payment.expired_locally_closed", target.outTradeNo);
    }
    return;
  }

  // 查询失败、未知状态、关单结果不明确：保持 pending，不释放。
}
