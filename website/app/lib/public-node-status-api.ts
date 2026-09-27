/* Public operator node status (no session). Two same-origin read-only
   endpoints served by the sanitized monitor gateway through the site proxy:
   the three-network summary and the single operator server chosen server-side.
   Responses are parsed against exact allowlists; any failure is reported as a
   failure, never replaced by cached, fixture or Mock data. Customer data stays
   on the authenticated /api/me/monitor-status. */

export const PUBLIC_SUMMARY_URL = "/api/public-monitor/summary";
export const PUBLIC_SERVER_STATUS_URL = "/api/public-monitor/server-status";
export const PUBLIC_STATUS_MAX_BYTES = 16 * 1024;
export const PUBLIC_STATUS_TIMEOUT_MS = 7_000;

const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const UTC_SECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WAN_NAMES = { telecom: "电信", mobile: "移动", unicom: "联通" } as const;
const WAN_ORDER = ["telecom", "mobile", "unicom"] as const;
const WAN_STATUSES = ["healthy", "degraded", "unavailable", "no_data", "stale"] as const;
const WAN_REQUIRED = ["wanId", "displayName", "status", "packetLossSummary", "updatedAt", "stale", "trend"];
const TREND_POINT_LIMIT = 288;

export type WanId = (typeof WAN_ORDER)[number];
export type WanStatus = (typeof WAN_STATUSES)[number];

export interface PublicWan {
  readonly wanId: WanId;
  readonly displayName: string;
  readonly status: WanStatus;
  readonly latestLatencyMs: number | null;
  readonly packetLossSummary: number | null;
  readonly updatedAt: string | null;
  readonly stale: boolean;
  readonly trend: readonly number[];
}

export interface PublicServerStatus {
  readonly label: string;
  readonly status: "online" | "offline" | "stale";
  readonly updatedAt: string;
  readonly stale: boolean;
}

export type PublicStatusFailure = "unavailable" | "timeout" | "rate_limited" | "invalid";

export class PublicStatusError extends Error {
  readonly kind: PublicStatusFailure;
  constructor(kind: PublicStatusFailure) {
    super(kind);
    this.name = "PublicStatusError";
    this.kind = kind;
  }
}

export class PublicStatusAbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "PublicStatusAbortError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtcSecond(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_SECOND_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace(".000Z", "Z") === value;
}

function finite(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

export function parsePublicSummary(value: unknown): readonly PublicWan[] {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.wans)) {
    throw new PublicStatusError("invalid");
  }
  if (value.wans.length !== WAN_ORDER.length) throw new PublicStatusError("invalid");
  const byId = new Map<WanId, PublicWan>();
  for (const raw of value.wans) {
    if (!isRecord(raw)) throw new PublicStatusError("invalid");
    const keys = Object.keys(raw);
    const allowed = [...WAN_REQUIRED, "latestLatencyMs"];
    if (!WAN_REQUIRED.every((key) => key in raw) || !keys.every((key) => allowed.includes(key))) {
      throw new PublicStatusError("invalid");
    }
    const wanId = raw.wanId as WanId;
    const status = raw.status as WanStatus;
    if (!WAN_ORDER.includes(wanId) || byId.has(wanId) || raw.displayName !== WAN_NAMES[wanId]) {
      throw new PublicStatusError("invalid");
    }
    if (!WAN_STATUSES.includes(status) || typeof raw.stale !== "boolean" || raw.stale !== (status === "stale")) {
      throw new PublicStatusError("invalid");
    }
    const current = status !== "no_data" && status !== "stale";
    const updatedAt = raw.updatedAt;
    if (status === "no_data" ? updatedAt !== null : !isUtcSecond(updatedAt)) throw new PublicStatusError("invalid");
    const loss = raw.packetLossSummary;
    if (!(loss === null || finite(loss, 100))) throw new PublicStatusError("invalid");
    const latency = "latestLatencyMs" in raw ? raw.latestLatencyMs : null;
    if (latency !== null && (!finite(latency) || !current)) throw new PublicStatusError("invalid");
    const trend = raw.trend;
    if (!Array.isArray(trend) || trend.length > TREND_POINT_LIMIT || !trend.every((point) => finite(point))) {
      throw new PublicStatusError("invalid");
    }
    if (!current && (loss !== null || trend.length > 0 || latency !== null)) throw new PublicStatusError("invalid");
    byId.set(wanId, {
      wanId,
      displayName: WAN_NAMES[wanId],
      status,
      latestLatencyMs: latency as number | null,
      packetLossSummary: loss as number | null,
      updatedAt: updatedAt as string | null,
      stale: raw.stale,
      trend: trend as number[],
    });
  }
  return WAN_ORDER.map((id) => byId.get(id) as PublicWan);
}

export function parsePublicServerStatus(value: unknown): PublicServerStatus {
  if (!isRecord(value)) throw new PublicStatusError("invalid");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "label,stale,status,updatedAt") throw new PublicStatusError("invalid");
  const { label, status, updatedAt, stale } = value;
  if (
    typeof label !== "string" ||
    label.length < 1 ||
    label.length > 200 ||
    label.trim() !== label ||
    CONTROL_CHARACTER_PATTERN.test(label) ||
    (status !== "online" && status !== "offline" && status !== "stale") ||
    !isUtcSecond(updatedAt) ||
    typeof stale !== "boolean" ||
    (status === "stale") !== stale
  ) {
    throw new PublicStatusError("invalid");
  }
  return { label, status, updatedAt, stale };
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = (response.headers.get("Content-Type") ?? "").trim();
  const length = response.headers.get("Content-Length");
  if (
    !JSON_CONTENT_TYPE_PATTERN.test(contentType) ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > PUBLIC_STATUS_MAX_BYTES))
  ) {
    throw new PublicStatusError("invalid");
  }
  // Stream with a hard cap so a body without (or lying about) Content-Length is
  // cancelled as soon as it exceeds the limit instead of being buffered whole.
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > PUBLIC_STATUS_MAX_BYTES) {
          await reader.cancel();
          throw new PublicStatusError("invalid");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new PublicStatusError("invalid");
  }
}

async function getPublic<T>(
  url: string,
  parse: (value: unknown) => T,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort("public-status-timeout"), PUBLIC_STATUS_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        credentials: "omit",
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted === true) throw new PublicStatusAbortError();
      throw new PublicStatusError(controller.signal.aborted ? "timeout" : "unavailable");
    }
    if (response.status === 200) return parse(await readJson(response));
    if (response.status === 429) throw new PublicStatusError("rate_limited");
    if (response.status === 504) throw new PublicStatusError("timeout");
    if (response.status >= 500) throw new PublicStatusError("unavailable");
    throw new PublicStatusError("invalid");
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function getPublicSummary(signal?: AbortSignal, fetchImpl: FetchLike = fetch) {
  return getPublic(PUBLIC_SUMMARY_URL, parsePublicSummary, signal, fetchImpl);
}

export function getPublicServerStatus(signal?: AbortSignal, fetchImpl: FetchLike = fetch) {
  return getPublic(PUBLIC_SERVER_STATUS_URL, parsePublicServerStatus, signal, fetchImpl);
}
