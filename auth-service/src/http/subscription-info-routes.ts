import type { FastifyInstance, FastifyReply } from "fastify";

import type { DatabaseConnection } from "../db.js";
import { formatLineSelector, parseLineQuery } from "../monitor/line-selector.js";
import { readPaymentSession } from "../payment/http-auth.js";
import { auditGrantDeliveryDecryptFailure } from "../payment/admin-services.js";
import { auditDeliveryDecryptFailure } from "../payment/orders.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import { readOwnedSubscriptionUrl } from "../subscription/owned-url.js";
import {
  nodeSubscriptionHeaderFetcher,
  readSubscriptionInfo,
  SubscriptionInfoCache,
  type SubscriptionHeaderFetcher,
} from "../subscription/userinfo.js";
import { consumeSubscriptionInfoRateLimit, RateLimitExceededError, type RateLimitKeyring } from "./rate-limit.js";

export interface SubscriptionInfoHttpDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly deliveryEncKeyring: TokenHmacKeyring;
  /** Outbound header reader; tests inject a fake. */
  readonly fetcher?: SubscriptionHeaderFetcher;
  readonly cache?: SubscriptionInfoCache;
  readonly now?: () => Date;
}

function errorResponse(code: string) {
  return { error: { code } };
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

/* GET /api/me/subscription-info?line=<kind>:<ref>:<position>（NSP-SUB-TRAFFIC-09）
   会话 → 每用户限流 → 买家拥有该交付行 → 服务端解密订阅 URL → 只取 subscription-userinfo 头。
   200 {info:{upload,download,total,expire}} / {info:null, reason:"no_userinfo"|"unreachable"}；
   订阅 URL 与上游内容绝不进入响应。 */
export function registerSubscriptionInfoHttpRoutes(
  app: FastifyInstance,
  dependencies: SubscriptionInfoHttpDependencies | null,
): void {
  const cache = dependencies?.cache ?? new SubscriptionInfoCache();
  const fetcher = dependencies?.fetcher ?? nodeSubscriptionHeaderFetcher;

  app.get("/api/me/subscription-info", async (request, reply) => {
    setNoStore(reply);
    const query = parseLineQuery(request.raw.url);
    if (!query.ok || query.line === null) return reply.code(400).send(errorResponse("invalid_request"));
    if (dependencies === null) return reply.code(503).send(errorResponse("subscription_info_unavailable"));

    let session: ReturnType<typeof readPaymentSession>;
    try {
      session = readPaymentSession(request, dependencies);
    } catch {
      return reply.code(503).send(errorResponse("subscription_info_unavailable"));
    }
    if (session === null) return reply.code(401).send(errorResponse("unauthorized"));
    if (session.principal.role !== "user") return reply.code(403).send(errorResponse("forbidden"));
    const userId = session.principal.userId;

    try {
      consumeSubscriptionInfoRateLimit(dependencies.database, dependencies.rateLimitKeyring, userId, dependencies.now ? { now: dependencies.now } : {});
    } catch (error) {
      if (error instanceof RateLimitExceededError) return reply.code(429).send(errorResponse("rate_limited"));
      return reply.code(503).send(errorResponse("subscription_info_unavailable"));
    }

    if (query.line === "invalid") return reply.code(404).send(errorResponse("line_not_found"));
    const line = query.line;
    const cacheKey = `${userId}|${formatLineSelector(line)}`;
    const now = (dependencies.now ?? (() => new Date()))().getTime();
    const cached = cache.get(cacheKey, now);
    if (cached !== null) return reply.code(200).send(cached);

    let url: string | null;
    try {
      url = readOwnedSubscriptionUrl(dependencies.database, userId, line, dependencies.deliveryEncKeyring);
    } catch {
      try {
        if (line.kind === "service") auditDeliveryDecryptFailure(dependencies.database, line.ref, dependencies.now);
        else auditGrantDeliveryDecryptFailure(dependencies.database, line.ref, dependencies.now);
      } catch {
        // The response stays fail-closed even when audit persistence fails.
      }
      return reply.code(503).send(errorResponse("subscription_info_unavailable"));
    }
    if (url === null) return reply.code(404).send(errorResponse("line_not_found"));

    const result = await readSubscriptionInfo(url, fetcher);
    cache.set(cacheKey, result, now);
    return reply.code(200).send(result);
  });
}
