import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import {
  AccountMonitorSelectionError,
  selectAccountMonitorTarget,
} from "../monitor/account-projection.js";
import {
  MONITOR_AUTH_TOTAL_TIMEOUT_MS,
  MonitorPrivateClientError,
  type MonitorPrivateClient,
} from "../monitor/private-client.js";
import { readPaymentSession } from "../payment/http-auth.js";
import { listMyNodeLines, resolveNodeStatuses } from "../monitor/node-status.js";
import { findOwnedLine, parseLineQuery } from "../monitor/line-selector.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  consumeMonitorStatusRateLimit,
  RateLimitExceededError,
  type RateLimitKeyring,
} from "./rate-limit.js";

export const MONITOR_BROWSER_RESPONSE_MAX_BYTES = 4 * 1024;

export interface MonitorHttpDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly privateClient: MonitorPrivateClient | null;
  readonly now?: () => Date;
}

interface ErrorResponse {
  readonly error: { readonly code: string };
}

function errorResponse(code: string): ErrorResponse {
  return { error: { code } };
}

function setJsonNoStore(reply: FastifyReply): void {
  void reply.type("application/json; charset=utf-8");
  void reply.header("Cache-Control", "no-store");
}

function hasQueryString(request: FastifyRequest): boolean {
  return request.raw.url?.includes("?") === true;
}

function hasNonEmptyBody(request: FastifyRequest): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && contentLength !== "0") return true;
  return request.body !== undefined && request.body !== null;
}

function sendPrivateFailure(error: MonitorPrivateClientError, reply: FastifyReply) {
  if (error.failure === "target_unbound") {
    return reply.code(409).send(errorResponse("monitor_unbound"));
  }
  if (error.failure === "timeout") {
    return reply.code(504).send(errorResponse("monitor_unavailable"));
  }
  if (error.failure === "invalid_response") {
    return reply.code(502).send(errorResponse("monitor_invalid_response"));
  }
  return reply.code(503).send(errorResponse("monitor_unavailable"));
}

export function registerMonitorHttpRoutes(
  app: FastifyInstance,
  dependencies: MonitorHttpDependencies | null,
): void {
  app.route({
    method: [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "TRACE",
    ],
    url: "/api/me/monitor-status",
    onRequest: async (request, reply) => {
      setJsonNoStore(reply);
      if (request.method !== "GET") {
        void reply.header("Allow", "GET");
        return reply.code(405).send(errorResponse("method_not_allowed"));
      }
      // Reject framed bodies before Fastify's content-type parser can replace
      // the frozen 400 envelope with its generic 415 response. The only accepted
      // query is a single `line` selector (NSP-LINE-STATUS-08).
      if (
        !parseLineQuery(request.raw.url).ok ||
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0")
      ) {
        return reply.code(400).send(errorResponse("invalid_request"));
      }
    },
    handler: async (request, reply) => {
      setJsonNoStore(reply);
      if (request.method !== "GET") {
        void reply.header("Allow", "GET");
        return reply.code(405).send(errorResponse("method_not_allowed"));
      }
      const query = parseLineQuery(request.raw.url);
      if (!query.ok || hasNonEmptyBody(request)) {
        return reply.code(400).send(errorResponse("invalid_request"));
      }
      if (dependencies === null) {
        return reply.code(503).send(errorResponse("monitor_unconfigured"));
      }
      const signal = AbortSignal.timeout(MONITOR_AUTH_TOTAL_TIMEOUT_MS);

      let session: ReturnType<typeof readPaymentSession>;
      try {
        session = readPaymentSession(request, dependencies);
      } catch {
        return reply.code(503).send(errorResponse("monitor_unavailable"));
      }
      if (session === null) {
        return reply.code(401).send(errorResponse("unauthorized"));
      }
      if (session.principal.role !== "user") {
        return reply.code(403).send(errorResponse("forbidden"));
      }

      try {
        consumeMonitorStatusRateLimit(
          dependencies.database,
          dependencies.rateLimitKeyring,
          session.principal.userId,
          dependencies.now ? { now: dependencies.now } : {},
        );
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          return reply.code(429).send(errorResponse("rate_limited"));
        }
        return reply.code(503).send(errorResponse("monitor_unavailable"));
      }

      if (dependencies.privateClient === null) {
        return reply.code(503).send(errorResponse("monitor_unconfigured"));
      }

      try {
        /* With ?line= the target is the one bound to that line of the buyer's own delivery
           (open service / active+open gift); a malformed, foreign or missing line is the same
           404 and an unbound line is 409. Without it the first owned binding is used, unchanged. */
        let selectedKey: string;
        if (query.line === null) {
          selectedKey = selectAccountMonitorTarget(dependencies.database, session.principal.userId).key;
        } else {
          const owned = query.line === "invalid"
            ? null
            : findOwnedLine(dependencies.database, session.principal.userId, query.line);
          if (owned === null) return reply.code(404).send(errorResponse("line_not_found"));
          if (owned.targetKey === null) return reply.code(409).send(errorResponse("line_unbound"));
          selectedKey = owned.targetKey;
        }
        const catalog = await dependencies.privateClient.list(signal);
        const target = catalog.find((item) => item.key === selectedKey);
        if (target === undefined || target.state !== "active") {
          return reply.code(409).send(errorResponse("monitor_unbound"));
        }
        const status = await dependencies.privateClient.status(selectedKey, signal);
        const response = {
          label: target.label,
          status: status.status,
          updatedAt: status.updatedAt,
          stale: status.stale,
        } as const;
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > MONITOR_BROWSER_RESPONSE_MAX_BYTES) {
          return reply.code(502).send(errorResponse("monitor_invalid_response"));
        }
        return reply.code(200).send(response);
      } catch (error) {
        if (error instanceof AccountMonitorSelectionError) {
          return reply
            .code(error.code === "no_eligible_service" ? 404 : 409)
            .send(errorResponse(error.code));
        }
        if (error instanceof MonitorPrivateClientError) {
          return sendPrivateFailure(error, reply);
        }
        return reply.code(503).send(errorResponse("monitor_unavailable"));
      }
    },
  });

  /* 买家线路 → 公开监控页要选中的服务器（用户裁决 2026-10-04）：只返回买家本人已交付线路绑定的
     监控服务器名 `{target}`（公开三网监控页本来就列出这些名字），供 /status 嵌入的监控页预选；
     不调用私有监控、不返回状态或其他字段。越权 / 不存在 / 格式错误 404，未绑定 409。 */
  app.get("/api/me/monitor-target", async (request, reply) => {
    setJsonNoStore(reply);
    const query = parseLineQuery(request.raw.url);
    if (!query.ok || query.line === null) return reply.code(400).send(errorResponse("invalid_request"));
    if (dependencies === null) return reply.code(503).send(errorResponse("monitor_unconfigured"));
    let session: ReturnType<typeof readPaymentSession>;
    try {
      session = readPaymentSession(request, dependencies);
    } catch {
      return reply.code(503).send(errorResponse("monitor_unavailable"));
    }
    if (session === null) return reply.code(401).send(errorResponse("unauthorized"));
    if (session.principal.role !== "user") return reply.code(403).send(errorResponse("forbidden"));
    try {
      consumeMonitorStatusRateLimit(
        dependencies.database,
        dependencies.rateLimitKeyring,
        session.principal.userId,
        dependencies.now ? { now: dependencies.now } : {},
      );
    } catch (error) {
      if (error instanceof RateLimitExceededError) return reply.code(429).send(errorResponse("rate_limited"));
      return reply.code(503).send(errorResponse("monitor_unavailable"));
    }
    const owned = query.line === "invalid" ? null : findOwnedLine(dependencies.database, session.principal.userId, query.line);
    if (owned === null) return reply.code(404).send(errorResponse("line_not_found"));
    if (owned.targetKey === null) return reply.code(409).send(errorResponse("line_unbound"));
    return reply.code(200).send({ target: owned.targetKey });
  });

  /* 买家节点在线状态：会话鉴权 + 与 monitor-status 共用的按用户限流；私有监控未配置时
     返回 200 {monitor:"unavailable", items:[]}，由前端显示「状态暂不可用」，不让整页 503。 */
  app.get("/api/me/node-status", async (request, reply) => {
    setJsonNoStore(reply);
    if (hasQueryString(request)) {
      return reply.code(400).send(errorResponse("invalid_request"));
    }
    if (dependencies === null) {
      return reply.code(503).send(errorResponse("monitor_unconfigured"));
    }
    let session: ReturnType<typeof readPaymentSession>;
    try {
      session = readPaymentSession(request, dependencies);
    } catch {
      return reply.code(503).send(errorResponse("monitor_unavailable"));
    }
    if (session === null) {
      return reply.code(401).send(errorResponse("unauthorized"));
    }
    if (dependencies.privateClient === null) {
      return reply.code(200).send({ monitor: "unavailable", items: [] });
    }
    try {
      consumeMonitorStatusRateLimit(
        dependencies.database,
        dependencies.rateLimitKeyring,
        session.principal.userId,
        dependencies.now ? { now: dependencies.now } : {},
      );
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return reply.code(429).send(errorResponse("rate_limited"));
      }
      return reply.code(503).send(errorResponse("monitor_unavailable"));
    }
    try {
      const lines = listMyNodeLines(dependencies.database, session.principal.userId);
      const client = dependencies.privateClient;
      const items = await resolveNodeStatuses(
        lines,
        (target, signal) => client.status(target, signal),
        AbortSignal.timeout(MONITOR_AUTH_TOTAL_TIMEOUT_MS),
      );
      return reply.code(200).send({ monitor: "available", items });
    } catch {
      return reply.code(503).send(errorResponse("monitor_unavailable"));
    }
  });
}
