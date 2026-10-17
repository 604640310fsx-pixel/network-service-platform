/* 钱包与续费授权客户端（NSP-WALLET-UI-WIRING-20261004）。契约取自已推送后端
   16458599 的 auth-service/src/http/wallet-routes.ts：
   - GET  /api/me/wallet                                   -> { balanceFen, currency: "CNY" }
   - GET  /api/me/services/:id/renewal-quote?period=…      -> { quote: {...} }
   - GET  /api/me/services/:id/renewal-consent             -> { consent: {...} }
   - PUT  /api/me/services/:id/renewal-consent             开启 { period, expectedRevision, enabled, expectedQuoteKey }；
                                                            关闭 { period, expectedRevision, enabled } -> { revision }
     （expectedQuoteKey 按经理批准的契约更新：取自已确认报价；409 quote_changed 表示报价已变）
   错误统一 { error: { code } }。所有请求同源携带 Session Cookie；写操作携带 Session 绑定的 CSRF。
   价格、报价 key、到期时间只由服务端给出，浏览器从不提交。:id 是服务端 services.id；
   买家服务列表目前不返回该字段，调用方不得用 orderRef 或其他字段推算。 */

export type BillingPeriod = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
export const BILLING_PERIODS: readonly BillingPeriod[] = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"];

export interface WalletBalance {
  readonly balanceFen: number;
  readonly currency: "CNY";
}

export interface TopupSnapshot {
  readonly topupId: string;
  readonly status: "PENDING" | "SUCCEEDED";
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly succeededAt: string | null;
}

export interface TopupIntent extends TopupSnapshot {
  readonly checkout: { readonly kind: "REDIRECT"; readonly url: string };
}

export interface RenewalQuote {
  readonly key: string;
  readonly priceFen: number;
  readonly currency: "CNY";
  readonly durationId: string;
  readonly period: BillingPeriod;
  readonly previousEndsAt: string | null;
  readonly newEndsAt: string;
}

export interface RenewalConsent {
  /** 已知取值：DISABLED（含从未设置）、ENABLED、RECONSENT_REQUIRED；其余值原样保留，按未开启处理。 */
  readonly state: string;
  readonly revision: number;
  readonly period: BillingPeriod | null;
  readonly priceFen: number | null;
  readonly durationId: string | null;
  readonly updatedAt: string | null;
}

export class WalletApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "WalletApiError";
    this.code = code;
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(new Date(value).getTime());
}

function isPeriod(value: unknown): value is BillingPeriod {
  return BILLING_PERIODS.includes(value as BillingPeriod);
}

function invalid(): never {
  throw new WalletApiError("invalid_response");
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
    throw new WalletApiError("network_error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new WalletApiError(response.ok ? "invalid_response" : "request_failed", response.status);
  }
  if (!response.ok) throw new WalletApiError(errorCode(value) ?? "request_failed", response.status);
  return value;
}

function servicePath(serviceId: number): string {
  if (!Number.isSafeInteger(serviceId) || serviceId <= 0) throw new WalletApiError("not_found", 404);
  return `/api/me/services/${serviceId}`;
}

function parseWallet(value: unknown): WalletBalance {
  if (!isRecord(value) || !isNonNegativeInteger(value.balanceFen) || value.currency !== "CNY") invalid();
  return { balanceFen: value.balanceFen, currency: "CNY" };
}

function parseTopup(value: unknown): TopupSnapshot {
  if (!isRecord(value) || typeof value.topupId !== "string" || value.topupId.length === 0 || value.topupId.length > 128 ||
    (value.status !== "PENDING" && value.status !== "SUCCEEDED") ||
    !isNonNegativeInteger(value.amountFen) || value.amountFen === 0 || value.currency !== "CNY" ||
    !(value.succeededAt === null || isInstant(value.succeededAt)) ||
    (value.status === "PENDING" && value.succeededAt !== null) ||
    (value.status === "SUCCEEDED" && value.succeededAt === null)) invalid();
  return { topupId: value.topupId, status: value.status, amountFen: value.amountFen,
    currency: "CNY", succeededAt: value.succeededAt as string | null };
}

export async function createMyTopup(csrfToken: string, idempotencyKey: string, amountFen: number): Promise<TopupIntent> {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
    throw new WalletApiError("invalid_request", 400);
  }
  const value = await requestJson("/api/me/wallet/topups", {
    method: "POST", headers: { ...writeHeaders(csrfToken), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ amountFen }),
  });
  const snapshot = parseTopup(value);
  if (!isRecord(value) || !isRecord(value.checkout) || value.checkout.kind !== "REDIRECT" ||
    typeof value.checkout.url !== "string" || value.checkout.url.length === 0) invalid();
  return { ...snapshot, checkout: { kind: "REDIRECT", url: value.checkout.url } };
}

export async function getMyTopup(topupId: string, signal?: AbortSignal): Promise<TopupSnapshot> {
  if (typeof topupId !== "string" || topupId.length === 0 || topupId.length > 128) throw new WalletApiError("not_found", 404);
  return parseTopup(await requestJson(`/api/me/wallet/topups/${encodeURIComponent(topupId)}`,
    { method: "GET", headers: { Accept: "application/json" } }, signal));
}

export function parseTopupYuan(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [yuan, decimal = ""] = value.split(".");
  const amountFen = Number(yuan) * 100 + Number(decimal.padEnd(2, "0"));
  return Number.isSafeInteger(amountFen) && amountFen > 0 ? amountFen : null;
}

function parseQuote(value: unknown): RenewalQuote {
  const quote = isRecord(value) ? value.quote : undefined;
  if (
    !isRecord(quote) ||
    typeof quote.key !== "string" ||
    quote.key.length === 0 ||
    !isNonNegativeInteger(quote.priceFen) ||
    quote.currency !== "CNY" ||
    typeof quote.durationId !== "string" ||
    quote.durationId.length === 0 ||
    !isPeriod(quote.period) ||
    !(quote.previousEndsAt === null || isInstant(quote.previousEndsAt)) ||
    !isInstant(quote.newEndsAt)
  ) {
    invalid();
  }
  return {
    key: quote.key,
    priceFen: quote.priceFen,
    currency: "CNY",
    durationId: quote.durationId,
    period: quote.period,
    previousEndsAt: quote.previousEndsAt as string | null,
    newEndsAt: quote.newEndsAt,
  };
}

function parseConsent(value: unknown): RenewalConsent {
  const consent = isRecord(value) ? value.consent : undefined;
  if (
    !isRecord(consent) ||
    typeof consent.state !== "string" ||
    consent.state.length === 0 ||
    !isNonNegativeInteger(consent.revision) ||
    !(consent.period === null || isPeriod(consent.period)) ||
    !(consent.priceFen === null || isNonNegativeInteger(consent.priceFen)) ||
    !(consent.durationId === null || typeof consent.durationId === "string") ||
    // 从未设置过授权时服务端返回 updatedAt: ""（candidate.ts readRenewalConsent），视为无记录。
    !(consent.updatedAt === null || consent.updatedAt === "" || isInstant(consent.updatedAt))
  ) {
    invalid();
  }
  return {
    state: consent.state,
    revision: consent.revision,
    period: consent.period as BillingPeriod | null,
    priceFen: consent.priceFen as number | null,
    durationId: consent.durationId as string | null,
    updatedAt: consent.updatedAt === "" ? null : (consent.updatedAt as string | null),
  };
}

export async function getMyWallet(signal?: AbortSignal): Promise<WalletBalance> {
  return parseWallet(await requestJson("/api/me/wallet", { method: "GET", headers: { Accept: "application/json" } }, signal));
}

export async function getRenewalQuote(serviceId: number, period: BillingPeriod, signal?: AbortSignal): Promise<RenewalQuote> {
  if (!isPeriod(period)) throw new WalletApiError("invalid_request", 400);
  const url = `${servicePath(serviceId)}/renewal-quote?period=${period}`;
  return parseQuote(await requestJson(url, { method: "GET", headers: { Accept: "application/json" } }, signal));
}

export async function getRenewalConsent(serviceId: number, signal?: AbortSignal): Promise<RenewalConsent> {
  const url = `${servicePath(serviceId)}/renewal-consent`;
  return parseConsent(await requestJson(url, { method: "GET", headers: { Accept: "application/json" } }, signal));
}

/** 开启：{ period, expectedRevision, enabled: true, expectedQuoteKey }，key 必须是买家看到并确认的那次
    GET 报价的 quote.key（服务端比对最新报价，不一致返回 409 quote_changed 且不写入）。
    关闭：只提交 { period, expectedRevision, enabled: false }，不带 key。返回服务端新的 revision。 */
export type RenewalConsentChange =
  | { readonly period: BillingPeriod; readonly expectedRevision: number; readonly enabled: true; readonly expectedQuoteKey: string }
  | { readonly period: BillingPeriod; readonly expectedRevision: number; readonly enabled: false };

export async function putRenewalConsent(csrfToken: string, serviceId: number, input: RenewalConsentChange): Promise<number> {
  if (!isPeriod(input.period) || !isNonNegativeInteger(input.expectedRevision) || typeof input.enabled !== "boolean") {
    throw new WalletApiError("invalid_request", 400);
  }
  if (input.enabled && (typeof input.expectedQuoteKey !== "string" || input.expectedQuoteKey.length === 0)) {
    throw new WalletApiError("invalid_request", 400);
  }
  const body = input.enabled
    ? { period: input.period, expectedRevision: input.expectedRevision, enabled: true, expectedQuoteKey: input.expectedQuoteKey }
    : { period: input.period, expectedRevision: input.expectedRevision, enabled: false };
  const value = await requestJson(`${servicePath(serviceId)}/renewal-consent`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
  });
  if (!isRecord(value) || !isNonNegativeInteger(value.revision)) invalid();
  return value.revision;
}

function writeHeaders(csrfToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-Token": csrfToken,
  };
}

/* 后端 f1e0898：买家取消未付款订单。已付 409 not_cancellable；他人或不存在 404。 */
export type OrderCancelResult = "CANCELLED" | "ALREADY_CANCELLED";

export async function cancelMyOrder(csrfToken: string, orderRef: string): Promise<OrderCancelResult> {
  if (typeof orderRef !== "string" || !/^DL[A-Za-z0-9]{8,64}$/.test(orderRef)) throw new WalletApiError("not_found", 404);
  const value = await requestJson(`/api/me/orders/${encodeURIComponent(orderRef)}/cancel`, {
    method: "POST",
    headers: writeHeaders(csrfToken),
    body: "{}",
  });
  if (!isRecord(value) || (value.result !== "CANCELLED" && value.result !== "ALREADY_CANCELLED")) invalid();
  return value.result;
}

/* 后端 f1e0898：下期续费周期，体仅 { period, expectedRevision }，返回 revision。
   服务端按真实在售 SKU 校验（无报价 409 quote_unavailable）；已开启的授权转为需重新确认，未开启保持未开启。
   买家只能改本人服务（他人 / 缺失 404），管理员按角色改任意真实服务；id 均为 services.id。 */
async function putNextBillingPeriod(url: string, csrfToken: string, input: { readonly period: BillingPeriod; readonly expectedRevision: number }): Promise<number> {
  if (!isPeriod(input.period) || !isNonNegativeInteger(input.expectedRevision)) throw new WalletApiError("invalid_request", 400);
  const value = await requestJson(url, {
    method: "PUT",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify({ period: input.period, expectedRevision: input.expectedRevision }),
  });
  if (!isRecord(value) || !isNonNegativeInteger(value.revision)) invalid();
  return value.revision;
}

export function setMyNextBillingPeriod(csrfToken: string, serviceId: number, input: { readonly period: BillingPeriod; readonly expectedRevision: number }): Promise<number> {
  return putNextBillingPeriod(`${servicePath(serviceId)}/next-billing-period`, csrfToken, input);
}

export function setAdminNextBillingPeriod(csrfToken: string, serviceId: number, input: { readonly period: BillingPeriod; readonly expectedRevision: number }): Promise<number> {
  if (!Number.isSafeInteger(serviceId) || serviceId <= 0) return Promise.reject(new WalletApiError("not_found", 404));
  return putNextBillingPeriod(`/api/admin/services/${serviceId}/next-billing-period`, csrfToken, input);
}

/** 金额一律按分精确显示两位小数：0 分显示 ¥0.00（真实零余额），不是占位。 */
export function formatWalletFen(balanceFen: number): string {
  const yuan = Math.trunc(balanceFen / 100);
  const fen = String(balanceFen % 100).padStart(2, "0");
  return `¥${yuan.toLocaleString("en-US")}.${fen}`;
}

export type WalletLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly wallet: WalletBalance }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly code: string };

/* ———— 我的钱包读 / 刷新共享订阅 ————
   所有消费方共享一份 GET /api/me/wallet 服务端快照：任一 refreshMyWallet 只触发一次
   服务端重读并把结果广播给全部订阅者——服务端永远是唯一事实，不做乐观记账。
   在途期间的重试合并为一个紧随其后的新读，保证“确认结果之后再读”仍拿到最新事实。 */
type WalletListener = () => void;
let sharedWallet: WalletLoad = { kind: "loading" };
let walletInflight: Promise<void> | null = null;
let walletInflightController: AbortController | null = null;
let walletRefreshAfterInflight = false;
const walletListeners = new Set<WalletListener>();

function emitWallet(next: WalletLoad): void {
  sharedWallet = next;
  for (const listener of walletListeners) listener();
}

export function refreshMyWallet(): Promise<void> {
  if (walletInflight !== null) {
    walletRefreshAfterInflight = true;
    return walletInflight;
  }
  const controller = new AbortController();
  walletInflightController = controller;
  emitWallet({ kind: "loading" });
  walletInflight = getMyWallet(controller.signal)
    .then((wallet) => emitWallet({ kind: "ready", wallet }))
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof WalletApiError && error.code === "unauthorized") emitWallet({ kind: "unauthorized" });
      else emitWallet({ kind: "error", code: error instanceof WalletApiError ? error.code : "wallet_unavailable" });
    })
    .finally(() => {
      walletInflight = null;
      walletInflightController = null;
      if (walletRefreshAfterInflight) {
        walletRefreshAfterInflight = false;
        void refreshMyWallet();
      }
    });
  return walletInflight;
}

export function getMyWalletSnapshot(): WalletLoad {
  return sharedWallet;
}

export function subscribeMyWallet(listener: WalletListener): () => void {
  walletListeners.add(listener);
  return () => {
    walletListeners.delete(listener);
  };
}

/** Test seam only: reset the shared cache between cases. */
export function __resetMyWalletSharedForTest(): void {
  walletInflightController?.abort();
  sharedWallet = { kind: "loading" };
  walletInflight = null;
  walletInflightController = null;
  walletRefreshAfterInflight = false;
}
