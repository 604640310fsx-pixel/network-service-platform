import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";

import {
  normalizeMonitorTargetKey,
  normalizeMonitorTargetLabel,
  normalizeMonitorTargetState,
  type MonitorTargetCatalog,
  type MonitorTargetOption,
} from "./target-catalog.js";

export const MONITOR_PRIVATE_STATUS_MAX_BYTES = 8 * 1024;
export const MONITOR_PRIVATE_CATALOG_MAX_BYTES = 64 * 1024;
export const MONITOR_AUTH_TOTAL_TIMEOUT_MS = 6_000;

const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const UTC_SECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PRIVATE_IPV4_RANGES = [
  [0x0a000000, 0x0affffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
] as const;

type MonitorPrivateFailure =
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "target_unbound";

export class MonitorPrivateClientError extends Error {
  readonly failure: MonitorPrivateFailure;

  constructor(failure: MonitorPrivateFailure) {
    super(failure);
    this.name = "MonitorPrivateClientError";
    this.failure = failure;
  }
}

export interface MonitorPrivateStatus {
  readonly status: "online" | "offline" | "stale";
  readonly updatedAt: string;
  readonly stale: boolean;
}

export interface MonitorPrivateClient extends MonitorTargetCatalog {
  status(target: string, signal?: AbortSignal): Promise<MonitorPrivateStatus>;
}

export interface MonitorPrivateTlsCredentials {
  readonly caCertificate: Buffer;
  readonly clientCertificate: Buffer;
  readonly clientPrivateKey: Buffer;
}

interface TransportResponse {
  readonly status: number;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly body: Buffer;
}

type Transport = (
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<TransportResponse>;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const value =
    (((parts[0]! << 24) >>> 0) +
      (parts[1]! << 16) +
      (parts[2]! << 8) +
      parts[3]!) >>>
    0;
  return PRIVATE_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return false;
}

export function normalizeMonitorPrivateOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      !isPrivateHostname(url.hostname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

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

function canonicalUtcSecond(value: unknown): string | null {
  if (typeof value !== "string" || !UTC_SECOND_PATTERN.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().replace(".000Z", "Z") === value ? value : null;
}

function parseJson(response: TransportResponse): unknown {
  if (!JSON_CONTENT_TYPE_PATTERN.test(response.contentType.trim())) {
    throw new MonitorPrivateClientError("invalid_response");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    return JSON.parse(text) as unknown;
  } catch {
    throw new MonitorPrivateClientError("invalid_response");
  }
}

function parseErrorEnvelope(response: TransportResponse): never {
  const parsed = parseJson(response);
  const envelope = exactRecord(parsed, ["error"]);
  const error = exactRecord(envelope?.error, ["code"]);
  const code = error?.code;
  if (typeof code !== "string") {
    throw new MonitorPrivateClientError("invalid_response");
  }
  if (
    (response.status === 404 && code === "target_not_found") ||
    (response.status === 409 && code === "target_unavailable")
  ) {
    throw new MonitorPrivateClientError("target_unbound");
  }
  if (response.status === 504 && code === "monitor_unavailable") {
    throw new MonitorPrivateClientError("timeout");
  }
  if (
    (response.status === 503 && code === "monitor_unavailable") ||
    (response.status === 403 && code === "forbidden")
  ) {
    throw new MonitorPrivateClientError("unavailable");
  }
  if (response.status === 502 && code === "monitor_invalid_response") {
    throw new MonitorPrivateClientError("invalid_response");
  }
  throw new MonitorPrivateClientError("invalid_response");
}

function parseCatalog(response: TransportResponse): readonly MonitorTargetOption[] {
  if (response.status !== 200) parseErrorEnvelope(response);
  const envelope = exactRecord(parseJson(response), ["items"]);
  if (!Array.isArray(envelope?.items) || envelope.items.length > 100) {
    throw new MonitorPrivateClientError("invalid_response");
  }
  const seen = new Set<string>();
  const items = envelope.items.map((rawItem) => {
    const item = exactRecord(rawItem, ["key", "label", "state"]);
    const key = normalizeMonitorTargetKey(item?.key);
    const label = normalizeMonitorTargetLabel(item?.label);
    const state = normalizeMonitorTargetState(item?.state);
    if (key === null || label === null || state === null || seen.has(key)) {
      throw new MonitorPrivateClientError("invalid_response");
    }
    seen.add(key);
    return Object.freeze({ key, label, state });
  });
  return Object.freeze(items);
}

function parseStatus(response: TransportResponse): MonitorPrivateStatus {
  if (response.status !== 200) parseErrorEnvelope(response);
  const body = exactRecord(parseJson(response), ["status", "updatedAt", "stale"]);
  const status = body?.status;
  const updatedAt = canonicalUtcSecond(body?.updatedAt);
  const stale = body?.stale;
  if (
    (status !== "online" && status !== "offline" && status !== "stale") ||
    updatedAt === null ||
    typeof stale !== "boolean" ||
    (status === "stale") !== stale
  ) {
    throw new MonitorPrivateClientError("invalid_response");
  }
  return Object.freeze({ status, updatedAt, stale });
}

function createHttpsTransport(
  origin: URL,
  credentials: MonitorPrivateTlsCredentials,
): Transport {
  return (path, maxBytes, signal) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const options: RequestOptions = {
        protocol: "https:",
        hostname: origin.hostname,
        port: origin.port === "" ? 443 : Number(origin.port),
        path,
        method: "GET",
        headers: {
          Accept: "application/json",
          Connection: "close",
        },
        ca: credentials.caCertificate,
        cert: credentials.clientCertificate,
        key: credentials.clientPrivateKey,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        servername: isIP(origin.hostname) === 0 ? origin.hostname : undefined,
        agent: false,
        signal,
      };
      const request = httpsRequest(options, (response) => {
        const declaredLength = response.headers["content-length"];
        if (
          declaredLength !== undefined &&
          (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
        ) {
          response.destroy();
          reject(new MonitorPrivateClientError("invalid_response"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            response.destroy(new MonitorPrivateClientError("invalid_response"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            contentType:
              typeof response.headers["content-type"] === "string"
                ? response.headers["content-type"]
                : "",
            cacheControl:
              typeof response.headers["cache-control"] === "string"
                ? response.headers["cache-control"]
                : "",
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
}

export function createMonitorPrivateClient(
  privateOrigin: string,
  credentials: MonitorPrivateTlsCredentials,
  transportOverride?: Transport,
): MonitorPrivateClient {
  const normalizedOrigin = normalizeMonitorPrivateOrigin(privateOrigin);
  if (normalizedOrigin === null) {
    throw new Error("Monitor Auth private origin is invalid");
  }
  const origin = new URL(normalizedOrigin);
  const transport = transportOverride ?? createHttpsTransport(origin, credentials);

  async function request(path: string, maxBytes: number, signal?: AbortSignal) {
    const requestSignal = signal ?? AbortSignal.timeout(MONITOR_AUTH_TOTAL_TIMEOUT_MS);
    try {
      const response = await transport(path, maxBytes, requestSignal);
      if (
        !Number.isSafeInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        typeof response.contentType !== "string" ||
        typeof response.cacheControl !== "string" ||
        response.cacheControl.trim().toLowerCase() !== "no-store" ||
        !Buffer.isBuffer(response.body) ||
        response.body.length > maxBytes
      ) {
        throw new MonitorPrivateClientError("invalid_response");
      }
      return response;
    } catch (error) {
      if (error instanceof MonitorPrivateClientError) throw error;
      if (requestSignal.aborted) {
        throw new MonitorPrivateClientError("timeout");
      }
      throw new MonitorPrivateClientError("unavailable");
    }
  }

  return Object.freeze({
    async list(signal?: AbortSignal): Promise<readonly MonitorTargetOption[]> {
      return parseCatalog(
        await request(
          "/api/auth-service/targets",
          MONITOR_PRIVATE_CATALOG_MAX_BYTES,
          signal,
        ),
      );
    },
    async status(target: string, signal?: AbortSignal): Promise<MonitorPrivateStatus> {
      const normalizedTarget = normalizeMonitorTargetKey(target);
      if (normalizedTarget === null) {
        throw new MonitorPrivateClientError("invalid_response");
      }
      return parseStatus(
        await request(
          `/api/auth-service/status?target=${encodeURIComponent(normalizedTarget)}`,
          MONITOR_PRIVATE_STATUS_MAX_BYTES,
          signal,
        ),
      );
    },
  });
}

export const __privateClientTest = Object.freeze({ parseCatalog, parseStatus });
