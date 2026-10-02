// Node's strip-types test runner needs the extension; Vite resolves the same module during build.
// @ts-ignore TS5097: the website tsconfig does not enable allowImportingTsExtensions.
import { PaymentApiError } from "./payment-api.ts";

/* GET /api/me/node-status：买家本人交付线路的在线状态。响应只含线路名称与状态，
   不含任何监控目标、主机名或 IP；结构不符一律 invalid_response。 */

export type NodeLineStatus = "online" | "offline" | "stale" | "unbound" | "unknown";

export type NodeStatusItem =
  | { readonly kind: "service"; readonly ref: string; readonly position: number; readonly label: string; readonly status: NodeLineStatus }
  | { readonly kind: "grant"; readonly ref: number; readonly position: number; readonly label: string; readonly status: NodeLineStatus };

export type NodeStatusResult = {
  readonly monitor: "available" | "unavailable";
  readonly items: readonly NodeStatusItem[];
};

const STATUSES: ReadonlySet<string> = new Set(["online", "offline", "stale", "unbound", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseNodeStatus(value: unknown): NodeStatusResult {
  if (!isRecord(value) || !exactKeys(value, ["monitor", "items"]) || !Array.isArray(value.items)) {
    throw new PaymentApiError("invalid_response");
  }
  const monitor = value.monitor;
  if (monitor !== "available" && monitor !== "unavailable") throw new PaymentApiError("invalid_response");
  const items = value.items.map((raw): NodeStatusItem => {
    if (!isRecord(raw) || !exactKeys(raw, ["kind", "ref", "position", "label", "status"])) {
      throw new PaymentApiError("invalid_response");
    }
    const { kind, ref, position, label, status } = raw;
    if (
      typeof position !== "number" || !Number.isSafeInteger(position) || position < 1 ||
      typeof label !== "string" || label.trim() === "" ||
      typeof status !== "string" || !STATUSES.has(status)
    ) {
      throw new PaymentApiError("invalid_response");
    }
    if (kind === "service" && typeof ref === "string" && ref !== "") {
      return { kind, ref, position, label, status: status as NodeLineStatus };
    }
    if (kind === "grant" && typeof ref === "number" && Number.isSafeInteger(ref) && ref > 0) {
      return { kind, ref, position, label, status: status as NodeLineStatus };
    }
    throw new PaymentApiError("invalid_response");
  });
  if (monitor === "unavailable" && items.length > 0) throw new PaymentApiError("invalid_response");
  return { monitor, items };
}

export async function getMyNodeStatus(signal?: AbortSignal): Promise<NodeStatusResult> {
  let response: Response;
  try {
    response = await fetch("/api/me/node-status", { headers: { Accept: "application/json" }, credentials: "same-origin", signal });
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
    const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" ? body.error.code : "request_failed";
    throw new PaymentApiError(code, response.status);
  }
  return parseNodeStatus(body);
}

/** Card counts: all = every delivery line; online/stale/offline as reported; unbound and
    unknown lines only count toward "all" and are listed as the pending group. */
export function nodeStatusCounts(items: readonly NodeStatusItem[]) {
  const count = (status: NodeLineStatus) => items.filter((item) => item.status === status).length;
  return {
    all: items.length,
    online: count("online"),
    stale: count("stale"),
    offline: count("offline"),
    unbound: count("unbound"),
    unknown: count("unknown"),
  };
}
