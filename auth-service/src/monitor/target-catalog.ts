export const MONITOR_TARGET_KEY_MAX_LENGTH = 128;
export const MONITOR_TARGET_LABEL_MAX_LENGTH = 200;

const MONITOR_RESPONSE_MAX_BYTES = 256 * 1024;
const MONITOR_REQUEST_TIMEOUT_MS = 5_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface MonitorTargetOption {
  readonly key: string;
  readonly label: string;
}

export interface MonitorTargetCatalog {
  list(): Promise<readonly MonitorTargetOption[]>;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function normalizedBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  if (
    value.length < 1 ||
    value.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

export function normalizeMonitorTargetKey(value: unknown): string | null {
  return normalizedBoundedText(value, MONITOR_TARGET_KEY_MAX_LENGTH);
}

function normalizeMonitorTargetLabel(value: unknown): string | null {
  return normalizedBoundedText(value, MONITOR_TARGET_LABEL_MAX_LENGTH);
}

export function normalizeMonitorApiOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function parseMonitorTargets(value: unknown): readonly MonitorTargetOption[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("targets" in value) ||
    !Array.isArray(value.targets) ||
    value.targets.length > 100
  ) {
    throw new Error("Monitor target response is invalid");
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.targets.map((rawTarget) => {
      if (typeof rawTarget !== "object" || rawTarget === null || Array.isArray(rawTarget)) {
        throw new Error("Monitor target response is invalid");
      }
      const target = rawTarget as Record<string, unknown>;
      const key = normalizeMonitorTargetKey(target.target_name);
      const label = normalizeMonitorTargetLabel(target.display_name);
      if (key === null || label === null || seen.has(key)) {
        throw new Error("Monitor target response is invalid");
      }
      seen.add(key);
      return Object.freeze({ key, label });
    }),
  );
}

export function createMonitorTargetCatalog(
  apiOrigin: string,
  fetchImpl: FetchLike = fetch,
): MonitorTargetCatalog {
  const normalizedOrigin = normalizeMonitorApiOrigin(apiOrigin);
  if (normalizedOrigin === null) {
    throw new Error("Monitor API configuration is invalid");
  }
  const endpoint = new URL("/api/vps-targets", `${normalizedOrigin}/`);
  return Object.freeze({
    async list(): Promise<readonly MonitorTargetOption[]> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MONITOR_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(endpoint, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Monitor target request failed");
        const body = await response.text();
        if (Buffer.byteLength(body, "utf8") > MONITOR_RESPONSE_MAX_BYTES) {
          throw new Error("Monitor target response is too large");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error("Monitor target response is invalid");
        }
        return parseMonitorTargets(parsed);
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
