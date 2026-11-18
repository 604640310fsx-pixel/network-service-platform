import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/* 买家流量明细（NSP-SUB-TRAFFIC-09）：服务端代取交付订阅 URL 的 `subscription-userinfo` 响应头
   （Clash / 通用订阅约定：upload=<bytes>; download=<bytes>; total=<bytes>; expire=<unix 秒>）。

   威胁模型（SSRF）：订阅 URL 由管理员在开通时录入并加密保存，信任级别等同管理端输入，买家只能
   按自己拥有的线路触发读取，无法提交 URL。即便如此，出站请求仍按不可信目标处理：
   - 只允许 http/https；不跟随任何跳转（3xx 视为失败），防止被当作跳板；
   - 连接前在 DNS 解析结果上校验目标地址：回环、私有、链路本地、CGNAT、多播、未指定等地址一律拒绝
     （字面 IP 与域名解析结果同样处理，连接使用的正是校验过的地址，规避 DNS rebinding）；
   - 只读取响应头，收到头即断开，不读取 body；整次请求 ≤8s；
   - 订阅 URL 与对端返回的其他任何内容都不进入响应、日志或审计。 */

export interface SubscriptionUsage {
  readonly upload: number | null;
  readonly download: number | null;
  readonly total: number | null;
  /** Unix seconds; null when absent or 0 (no expiry). */
  readonly expire: number | null;
}

export type SubscriptionInfoResult =
  | { readonly info: SubscriptionUsage }
  | { readonly info: null; readonly reason: "no_userinfo" | "unreachable" };

export const SUBSCRIPTION_FETCH_TIMEOUT_MS = 8_000;
export const SUBSCRIPTION_USER_AGENT = "clash-meta";

const FIELDS = ["upload", "download", "total", "expire"] as const;

/** Parse a `subscription-userinfo` value; null when it carries none of the four fields. */
export function parseSubscriptionUserinfo(value: string | null | undefined): SubscriptionUsage | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const parsed: Record<(typeof FIELDS)[number], number | null> = { upload: null, download: null, total: null, expire: null };
  let recognized = false;
  for (const part of value.split(/[;,]/)) {
    const [rawKey, rawValue, ...rest] = part.split("=");
    if (rawKey === undefined || rawValue === undefined || rest.length > 0) continue;
    const key = rawKey.trim().toLowerCase();
    if (!(FIELDS as readonly string[]).includes(key)) continue;
    recognized = true;
    const text = rawValue.trim();
    if (!/^\d{1,16}$/.test(text)) continue;
    const number = Number(text);
    if (!Number.isSafeInteger(number)) continue;
    parsed[key as (typeof FIELDS)[number]] = key === "expire" && number === 0 ? null : number;
  }
  return recognized ? parsed : null;
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address. (A ::ffff:0:0/96 rule would
  // also match every plain IPv4 address, because BlockList maps IPv4 into IPv6 rules.)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const candidate = mapped?.[1] ?? address;
  const family = isIP(candidate);
  if (family === 0) return true;
  return BLOCKED.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/* Resolve, then refuse any blocked address. The socket connects to exactly what this returns. */
function guardedLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
      const blocked: NodeJS.ErrnoException = new Error("subscription host is not allowed");
      blocked.code = "EBLOCKED";
      return callback(blocked, []);
    }
    if ((options as { all?: boolean }).all === true) return callback(null, list);
    const first = list[0]!;
    return callback(null, first.address, first.family);
  });
}

/** Status and the userinfo header of one GET; never the body. */
export type SubscriptionHeaderFetcher = (
  url: URL,
  signal: AbortSignal,
) => Promise<{ readonly status: number; readonly userinfo: string | null }>;

export const nodeSubscriptionHeaderFetcher: SubscriptionHeaderFetcher = (url, signal) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && isBlockedAddress(host))) {
      reject(new Error("subscription host is not allowed"));
      return;
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, {
      method: "GET",
      headers: { "User-Agent": SUBSCRIPTION_USER_AGENT, Accept: "*/*" },
      lookup: guardedLookup as never,
      signal,
    });
    request.once("response", (response: IncomingMessage) => {
      const header = response.headers["subscription-userinfo"];
      const userinfo = typeof header === "string" ? header : Array.isArray(header) ? (header[0] ?? null) : null;
      resolve({ status: response.statusCode ?? 0, userinfo });
      response.destroy();
      request.destroy();
    });
    request.once("error", reject);
    request.end();
  });

/** Fetch and parse one subscription URL; every failure is the same `unreachable`. */
export async function readSubscriptionInfo(
  rawUrl: string,
  fetcher: SubscriptionHeaderFetcher,
  timeoutMs: number = SUBSCRIPTION_FETCH_TIMEOUT_MS,
): Promise<SubscriptionInfoResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { info: null, reason: "unreachable" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { info: null, reason: "unreachable" };
  let response: { readonly status: number; readonly userinfo: string | null };
  try {
    response = await fetcher(url, AbortSignal.timeout(timeoutMs));
  } catch {
    return { info: null, reason: "unreachable" };
  }
  // 3xx is never followed (no redirect pivot); any non-2xx is a failed read.
  if (response.status < 200 || response.status >= 300) return { info: null, reason: "unreachable" };
  const info = parseSubscriptionUserinfo(response.userinfo);
  return info === null ? { info: null, reason: "no_userinfo" } : { info };
}

/* Short per-line cache so a page load (≤20 lines) and quick reloads do not re-fetch upstream. */
export class SubscriptionInfoCache {
  private readonly entries = new Map<string, { readonly expiresAt: number; readonly result: SubscriptionInfoResult }>();

  constructor(
    private readonly successTtlMs = 60_000,
    private readonly failureTtlMs = 15_000,
    private readonly maxEntries = 1_000,
  ) {}

  get(key: string, now: number): SubscriptionInfoResult | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, result: SubscriptionInfoResult, now: number): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const ttl = result.info === null && result.reason === "unreachable" ? this.failureTtlMs : this.successTtlMs;
    this.entries.set(key, { expiresAt: now + ttl, result });
  }
}
