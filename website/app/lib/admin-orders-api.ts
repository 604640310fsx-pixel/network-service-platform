/* 管理员订单列表与内部关单（后端 078231c auth-service/src/http/wallet-routes.ts）：
   - GET  /api/admin/orders?orderRef=&userId=&beforeId=  -> { orders: AdminOrder[], nextBeforeId: number | null }
     只读，按 id 倒序每页 50；读取失败（含 503）是错误，不是空列表。
   - POST /api/admin/orders/:id/close                    -> { orderRef, managementClosed: true, refundState, serviceStopState }
     :id 是真实 orders.id（来自上面的列表），带 Session 绑定 CSRF。
   refundState=AWAITING_POLICY 只表示退款案待定、未完成；serviceStopState=REQUESTED 只表示已记录停止请求，并未实际停止。
   paymentStatus=null 表示无支付记录，不能据此推断“未付款”。 */

// Node's strip-types test runner needs the extension; Vite resolves the same module during build.
// @ts-ignore TS5097: the website tsconfig does not enable allowImportingTsExtensions.
import { WalletApiError } from "./wallet-api.ts";

export type AdminOrderStatus = "pending" | "paid" | "closed";

export interface AdminOrder {
  readonly id: number;
  readonly orderRef: string;
  readonly userId: number | null;
  readonly status: AdminOrderStatus;
  readonly paymentStatus: AdminOrderStatus | null;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly createdAt: string;
  readonly serviceId: number | null;
  readonly serviceStatus: "pending_open" | "open" | null;
  readonly managementClosed: boolean;
  readonly refundState: string | null;
  readonly serviceStopState: string | null;
}

export interface AdminOrderPage {
  readonly orders: readonly AdminOrder[];
  readonly nextBeforeId: number | null;
}

export interface AdminOrderCloseResult {
  readonly orderRef: string;
  readonly managementClosed: true;
  readonly refundState: "AWAITING_POLICY" | null;
  readonly serviceStopState: "REQUESTED" | null;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStatus(value: unknown): value is AdminOrderStatus {
  return value === "pending" || value === "paid" || value === "closed";
}

function invalid(): never {
  throw new WalletApiError("invalid_response");
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
  if (!response.ok) {
    const code = isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "request_failed";
    throw new WalletApiError(code, response.status);
  }
  return value;
}

function parseOrder(value: unknown): AdminOrder {
  if (
    !isRecord(value) ||
    !isPositiveInt(value.id) ||
    typeof value.orderRef !== "string" ||
    value.orderRef.length === 0 ||
    !(value.userId === null || isPositiveInt(value.userId)) ||
    !isStatus(value.status) ||
    !(value.paymentStatus === null || isStatus(value.paymentStatus)) ||
    typeof value.amountFen !== "number" ||
    !Number.isSafeInteger(value.amountFen) ||
    value.amountFen < 0 ||
    value.currency !== "CNY" ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length === 0 ||
    !(value.serviceId === null || isPositiveInt(value.serviceId)) ||
    !(value.serviceStatus === null || value.serviceStatus === "pending_open" || value.serviceStatus === "open") ||
    typeof value.managementClosed !== "boolean" ||
    !(value.refundState === null || (typeof value.refundState === "string" && value.refundState.length > 0)) ||
    !(value.serviceStopState === null || (typeof value.serviceStopState === "string" && value.serviceStopState.length > 0))
  ) {
    invalid();
  }
  return {
    id: value.id,
    orderRef: value.orderRef,
    userId: value.userId as number | null,
    status: value.status,
    paymentStatus: value.paymentStatus as AdminOrderStatus | null,
    amountFen: value.amountFen,
    currency: "CNY",
    createdAt: value.createdAt,
    serviceId: value.serviceId as number | null,
    serviceStatus: value.serviceStatus as AdminOrder["serviceStatus"],
    managementClosed: value.managementClosed,
    refundState: value.refundState as string | null,
    serviceStopState: value.serviceStopState as string | null,
  };
}

export interface AdminOrderFilter {
  readonly orderRef?: string;
  readonly userId?: number;
  readonly beforeId?: number;
}

export async function listAdminOrders(filter: AdminOrderFilter = {}, signal?: AbortSignal): Promise<AdminOrderPage> {
  const params = new URLSearchParams();
  if (filter.orderRef !== undefined) {
    const ref = filter.orderRef.trim();
    if (ref.length === 0 || ref.length > 128) throw new WalletApiError("invalid_request", 400);
    params.set("orderRef", ref);
  }
  if (filter.userId !== undefined) {
    if (!isPositiveInt(filter.userId)) throw new WalletApiError("invalid_request", 400);
    params.set("userId", String(filter.userId));
  }
  if (filter.beforeId !== undefined) {
    if (!isPositiveInt(filter.beforeId)) throw new WalletApiError("invalid_request", 400);
    params.set("beforeId", String(filter.beforeId));
  }
  const query = params.toString();
  const value = await requestJson(`/api/admin/orders${query ? `?${query}` : ""}`, { method: "GET", headers: { Accept: "application/json" } }, signal);
  if (!isRecord(value) || !Array.isArray(value.orders) || !(value.nextBeforeId === null || isPositiveInt(value.nextBeforeId))) invalid();
  return { orders: value.orders.map(parseOrder), nextBeforeId: value.nextBeforeId as number | null };
}

export async function closeAdminOrder(csrfToken: string, orderId: number): Promise<AdminOrderCloseResult> {
  if (!isPositiveInt(orderId)) throw new WalletApiError("not_found", 404);
  const value = await requestJson(`/api/admin/orders/${orderId}/close`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    },
    body: "{}",
  });
  if (
    !isRecord(value) ||
    typeof value.orderRef !== "string" ||
    value.managementClosed !== true ||
    !(value.refundState === null || value.refundState === "AWAITING_POLICY") ||
    !(value.serviceStopState === null || value.serviceStopState === "REQUESTED")
  ) {
    invalid();
  }
  return {
    orderRef: value.orderRef,
    managementClosed: true,
    refundState: value.refundState as AdminOrderCloseResult["refundState"],
    serviceStopState: value.serviceStopState as AdminOrderCloseResult["serviceStopState"],
  };
}
