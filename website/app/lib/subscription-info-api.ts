// Node's strip-types test runner needs the extension; Vite resolves the same module during build.
// @ts-ignore TS5097: the website tsconfig does not enable allowImportingTsExtensions.
import { PaymentApiError } from "./payment-api.ts";

/* GET /api/me/subscription-info?line=…（NSP-SUB-TRAFFIC-09）：订阅商在订阅链接响应头里提供的用量。
   严格解析：只接受约定结构，订阅地址从不出现在响应里。 */

export type SubscriptionUsage = {
  readonly upload: number | null;
  readonly download: number | null;
  readonly total: number | null;
  /** Unix seconds; null = not provided / no expiry. */
  readonly expire: number | null;
};

export type SubscriptionInfo =
  | { readonly kind: "usage"; readonly usage: SubscriptionUsage }
  | { readonly kind: "no_userinfo" }
  | { readonly kind: "unreachable" };

function count(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseSubscriptionInfo(value: unknown): SubscriptionInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PaymentApiError("invalid_response");
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(",");
  if (body.info === null) {
    if (keys !== "info,reason") throw new PaymentApiError("invalid_response");
    if (body.reason === "no_userinfo" || body.reason === "unreachable") return { kind: body.reason };
    throw new PaymentApiError("invalid_response");
  }
  if (keys !== "info" || typeof body.info !== "object" || Array.isArray(body.info)) throw new PaymentApiError("invalid_response");
  const info = body.info as Record<string, unknown>;
  if (Object.keys(info).sort().join(",") !== "download,expire,total,upload") throw new PaymentApiError("invalid_response");
  const [upload, download, total, expire] = [count(info.upload), count(info.download), count(info.total), count(info.expire)];
  if (upload === undefined || download === undefined || total === undefined || expire === undefined) {
    throw new PaymentApiError("invalid_response");
  }
  return { kind: "usage", usage: { upload, download, total, expire } };
}

export async function getSubscriptionInfo(line: string, signal?: AbortSignal): Promise<SubscriptionInfo> {
  let response: Response;
  try {
    response = await fetch(`/api/me/subscription-info?line=${encodeURIComponent(line)}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
  } catch {
    throw new PaymentApiError("network_error");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PaymentApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown } } | null)?.error;
    throw new PaymentApiError(typeof error?.code === "string" ? error.code : "request_failed", response.status);
  }
  return parseSubscriptionInfo(body);
}
