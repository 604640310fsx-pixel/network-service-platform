export const MONITOR_STATUS_RESPONSE_MAX_BYTES = 4 * 1024;
export const MONITOR_STATUS_TIMEOUT_MS = 7_000;

const LABEL_MAX_LENGTH = 200;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const UTC_SECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type MonitorStatusCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "no_eligible_service"
  | "method_not_allowed"
  | "monitor_unbound"
  | "rate_limited"
  | "monitor_invalid_response"
  | "monitor_unconfigured"
  | "monitor_unavailable"
  | "line_not_found"
  | "line_unbound";

export interface MonitorStatusProjection {
  readonly label: string;
  readonly status: "online" | "offline" | "stale";
  readonly updatedAt: string;
  readonly stale: boolean;
}

export class MonitorStatusApiError extends Error {
  readonly code: MonitorStatusCode;
  readonly status: number;

  constructor(code: MonitorStatusCode, status: number) {
    super(code);
    this.name = "MonitorStatusApiError";
    this.code = code;
    this.status = status;
  }
}

export class MonitorStatusAbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "MonitorStatusAbortError";
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
    ? record
    : null;
}

function isUtcSecond(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_SECOND_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().replace(".000Z", "Z") === value
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const contentLength = response.headers.get("Content-Length");
  if (
    !JSON_CONTENT_TYPE_PATTERN.test(contentType.trim()) ||
    cacheControl.trim().toLowerCase() !== "no-store" ||
    (contentLength !== null &&
      (!/^\d+$/.test(contentLength) ||
        Number(contentLength) > MONITOR_STATUS_RESPONSE_MAX_BYTES))
  ) {
    throw new MonitorStatusApiError("monitor_invalid_response", 502);
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MONITOR_STATUS_RESPONSE_MAX_BYTES) {
          await reader.cancel();
          throw new MonitorStatusApiError("monitor_invalid_response", 502);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof MonitorStatusApiError) throw error;
    throw new MonitorStatusApiError("monitor_invalid_response", 502);
  }
}

export function parseMonitorStatusSuccess(value: unknown): MonitorStatusProjection {
  const body = exactRecord(value, ["label", "status", "updatedAt", "stale"]);
  const label = body?.label;
  const status = body?.status;
  const stale = body?.stale;
  if (
    typeof label !== "string" ||
    label.length < 1 ||
    label.length > LABEL_MAX_LENGTH ||
    label.trim() !== label ||
    CONTROL_CHARACTER_PATTERN.test(label) ||
    (status !== "online" && status !== "offline" && status !== "stale") ||
    !isUtcSecond(body?.updatedAt) ||
    typeof stale !== "boolean" ||
    (status === "stale") !== stale
  ) {
    throw new MonitorStatusApiError("monitor_invalid_response", 502);
  }
  return {
    label,
    status,
    updatedAt: body.updatedAt,
    stale,
  };
}

const ERROR_CODES_BY_STATUS: Readonly<Record<number, readonly MonitorStatusCode[]>> = {
  400: ["invalid_request"],
  401: ["unauthorized"],
  403: ["forbidden"],
  404: ["no_eligible_service", "line_not_found"],
  405: ["method_not_allowed"],
  409: ["monitor_unbound", "line_unbound"],
  429: ["rate_limited"],
  502: ["monitor_invalid_response"],
  503: ["monitor_unconfigured", "monitor_unavailable"],
  504: ["monitor_unavailable"],
};

export function parseMonitorStatusError(status: number, value: unknown): MonitorStatusApiError {
  const body = exactRecord(value, ["error"]);
  const error = exactRecord(body?.error, ["code"]);
  const code = error?.code;
  const allowed = ERROR_CODES_BY_STATUS[status] ?? [];
  if (typeof code !== "string" || !allowed.includes(code as MonitorStatusCode)) {
    return new MonitorStatusApiError("monitor_invalid_response", 502);
  }
  return new MonitorStatusApiError(code as MonitorStatusCode, status);
}

/** `line` (optional) is a `kind:ref:position` selector of one of the buyer's own delivered
    lines; Auth resolves its bound server. Without it Auth picks the first owned binding. */
export async function getMonitorStatus(
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  line?: string,
): Promise<MonitorStatusProjection> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort("monitor-status-timeout"),
    MONITOR_STATUS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  try {
    let response: Response;
    try {
      // The fixed same-origin path is a release invariant; only the buyer line selector is appended.
      response = await fetchImpl("/api/me/monitor-status" + (line === undefined ? "" : `?line=${encodeURIComponent(line)}`), {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted === true) throw new MonitorStatusAbortError();
      if (controller.signal.aborted) {
        throw new MonitorStatusApiError("monitor_unavailable", 504);
      }
      throw new MonitorStatusApiError("monitor_unavailable", 503);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new MonitorStatusApiError("monitor_invalid_response", 502);
    }
    const body = await readBoundedJson(response);
    if (response.status === 200) return parseMonitorStatusSuccess(body);
    throw parseMonitorStatusError(response.status, body);
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
