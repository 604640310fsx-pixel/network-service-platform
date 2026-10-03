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
  try {
    const queried = await queryAlipayTrade(dependencies.sdk, target.outTradeNo);
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
): Promise<AlipayTradeQueryResult | null> {
  const result = await queryTrade(dependencies, target);
  if (result === null) {
    return null;
  }
  const { queried, event } = result;
  if (event !== null) {
    if (event.tradeStatus === "TRADE_SUCCESS" || event.tradeStatus === "TRADE_FINISHED") {
      finalizePaid(dependencies, event);
    } else if (event.tradeStatus === "TRADE_CLOSED") {
      finalizeClosed(dependencies, event);
    } else if (event.tradeStatus === "WAIT_BUYER_PAY") {
      acceptPendingPaymentEvent(dependencies, event);
    }
  }
  return queried;
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
  if (first.queried.tradeStatus === "WAIT_BUYER_PAY") {
    try {
      await closeAlipayTrade(dependencies.sdk, target.outTradeNo);
    } catch {
      auditPaymentFailure(dependencies, "payment.close_failed", target.outTradeNo);
      return { kind: "unknown" };
    }
    // 复查：买家在关单前后完成支付则 paid 胜出；复查失败一律 unknown。
    const second = await queryTrade(dependencies, target);
    if (second === null) return { kind: "unknown" };
    const mapped = observationFromEvent(second.event);
    if (mapped !== null) return mapped;
    if (isTradeNotExist(second.queried)) return syntheticClosed();
    return { kind: "unknown" };
  }
  if (isTradeNotExist(first.queried)) return syntheticClosed();
  return { kind: "unknown" };
}

/* 普通路径：GET /api/pay/orders/:orderRef 触发的一次性查询+分发，
   行为与到期 sweep 引入前完全一致（不做关单、不把 TRADE_NOT_EXIST
   当作可关闭信号）。claimAlipayQuery 的 15 秒节流不变。 */
export async function refreshPaymentFromAlipay(
  dependencies: PaymentRefreshDependencies,
  target: RefreshTarget,
): Promise<void> {
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
  if (!claimAlipayQuery(dependencies, target.paymentId)) {
    return;
  }
  const first = await queryAndDispatch(dependencies, target);
  if (first === null) {
    return;
  }
  if (
    first.tradeStatus === "TRADE_SUCCESS" ||
    first.tradeStatus === "TRADE_FINISHED" ||
    first.tradeStatus === "TRADE_CLOSED"
  ) {
    return;
  }

  if (first.tradeStatus === "WAIT_BUYER_PAY") {
    try {
      await closeAlipayTrade(dependencies.sdk, target.outTradeNo);
    } catch {
      auditPaymentFailure(dependencies, "payment.close_failed", target.outTradeNo);
      return;
    }
    // 复查：若买家恰好在关单前后完成支付，queryAndDispatch 会优先分发为 paid。
    await queryAndDispatch(dependencies, target);
    return;
  }

  if (isTradeNotExist(first)) {
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
