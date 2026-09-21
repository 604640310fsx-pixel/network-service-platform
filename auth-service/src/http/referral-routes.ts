import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type {
  ReferralPublicLinkConfig,
  RuntimeEnvironment,
} from "../config.js";
import type { DatabaseConnection } from "../db.js";
import {
  ensureReferralProfile,
  readReferralProfile,
  type ReferralProfile,
  type ReferralProfileDependencies,
} from "../referral/profile.js";
import { readReferralSessionReadOnly } from "../referral/http-auth.js";
import {
  createReferralPublicRateLimiter,
  referralPublicLink,
  REFERRAL_PUBLIC_CODE_PATTERN,
  resolveReferralPublicCode,
  type ReferralPublicRateLimiter,
} from "../referral/public-resolution.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import { verifyCsrfToken } from "./csrf.js";
import {
  RateLimitExceededError,
  type RateLimitKeyring,
} from "./rate-limit.js";

const PRODUCTION_ORIGIN = "https://www.siqiapparel.com";
const DEVELOPMENT_ORIGIN = "http://localhost:5173";

const REFERRAL_TIERS = Object.freeze([
  { minSalesFen: 5_900, maxSalesFen: 99_899, rateBps: 1_000 },
  { minSalesFen: 99_900, maxSalesFen: 199_899, rateBps: 1_500 },
  { minSalesFen: 199_900, maxSalesFen: 399_899, rateBps: 2_000 },
  { minSalesFen: 399_900, maxSalesFen: null, rateBps: 3_000 },
]);

const WITHDRAWAL_THRESHOLD_FEN = 100_000;

interface ErrorBody {
  readonly error: { readonly code: string };
}

interface ReferralStateBody {
  readonly profile: ReferralProfile | null;
  readonly link:
    | {
        readonly status: "unavailable";
        readonly reason: "public_route_unconfigured";
      }
    | { readonly status: "ready"; readonly url: string };
  readonly program: {
    readonly tiers: typeof REFERRAL_TIERS;
    readonly withdrawalThresholdFen: number;
    readonly productCap: { readonly status: "unconfigured" };
    readonly commission: { readonly status: "not_integrated" };
    readonly refunds: { readonly status: "not_integrated" };
    readonly settlement: { readonly status: "not_integrated" };
    readonly withdrawn: { readonly status: "not_integrated" };
  };
}

export interface ReferralHttpDependencies extends ReferralProfileDependencies {
  readonly database: DatabaseConnection;
  readonly nodeEnv: RuntimeEnvironment;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly csrfSigningKey: Buffer;
  readonly publicLink: ReferralPublicLinkConfig;
  readonly publicRateLimiter?: ReferralPublicRateLimiter;
}

interface PublicResolutionBody {
  readonly valid: boolean;
}

const ERROR_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: { code: { type: "string" } },
    },
  },
} as const;

const PROFILE_SCHEMA = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["publicCode", "createdAt"],
      properties: {
        publicCode: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" },
        createdAt: { type: "string" },
      },
    },
  ],
} as const;

const STATE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "link", "program"],
  properties: {
    profile: PROFILE_SCHEMA,
    link: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "reason"],
          properties: {
            status: { type: "string", const: "unavailable" },
            reason: { type: "string", const: "public_route_unconfigured" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "url"],
          properties: {
            status: { type: "string", const: "ready" },
            url: { type: "string" },
          },
        },
      ],
    },
    program: {
      type: "object",
      additionalProperties: false,
      required: [
        "tiers",
        "withdrawalThresholdFen",
        "productCap",
        "commission",
        "refunds",
        "settlement",
        "withdrawn",
      ],
      properties: {
        tiers: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["minSalesFen", "maxSalesFen", "rateBps"],
            properties: {
              minSalesFen: { type: "integer", minimum: 0 },
              maxSalesFen: {
                anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
              },
              rateBps: { type: "integer", minimum: 0 },
            },
          },
        },
        withdrawalThresholdFen: { type: "integer", const: 100000 },
        productCap: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string", const: "unconfigured" } },
        },
        commission: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string", const: "not_integrated" } },
        },
        refunds: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string", const: "not_integrated" } },
        },
        settlement: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string", const: "not_integrated" } },
        },
        withdrawn: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string", const: "not_integrated" } },
        },
      },
    },
  },
} as const;

const PUBLIC_RESOLUTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["valid"],
  properties: { valid: { type: "boolean" } },
} as const;

const EMPTY_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  maxProperties: 0,
} as const;

const MUTATION_HEADERS_SCHEMA = {
  type: "object",
  required: ["content-type", "x-requested-with"],
  properties: {
    "content-type": { type: "string", const: "application/json" },
    "x-requested-with": { type: "string", const: "XMLHttpRequest" },
  },
} as const;

function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

async function referralMutationErrorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (
    error.validation !== undefined ||
    error.statusCode === 400 ||
    error.statusCode === 413 ||
    error.statusCode === 415
  ) {
    return reply.code(400).send(errorBody("invalid_request"));
  }
  return reply.code(503).send(errorBody("referral_unavailable"));
}

function allowedOrigin(nodeEnv: RuntimeEnvironment): string {
  return nodeEnv === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
}

function stateBody(
  profile: ReferralProfile | null,
  publicLinkConfig: ReferralPublicLinkConfig,
): ReferralStateBody {
  const link =
    profile === null ? null : referralPublicLink(publicLinkConfig, profile.publicCode);
  return {
    profile,
    link:
      link === null
        ? { status: "unavailable", reason: "public_route_unconfigured" }
        : { status: "ready", url: link },
    program: {
      tiers: REFERRAL_TIERS,
      withdrawalThresholdFen: WITHDRAWAL_THRESHOLD_FEN,
      productCap: { status: "unconfigured" },
      commission: { status: "not_integrated" },
      refunds: { status: "not_integrated" },
      settlement: { status: "not_integrated" },
      withdrawn: { status: "not_integrated" },
    },
  };
}

function publicCodeFromQuery(query: unknown): string | null {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return null;
  }
  const value = query as Record<string, unknown>;
  if (
    Object.keys(value).length !== 1 ||
    typeof value.code !== "string" ||
    !REFERRAL_PUBLIC_CODE_PATTERN.test(value.code)
  ) {
    return null;
  }
  return value.code;
}

function readSession(request: FastifyRequest, dependencies: ReferralHttpDependencies) {
  return readReferralSessionReadOnly(request, dependencies);
}

export function registerReferralHttpRoutes(
  app: FastifyInstance,
  dependencies: ReferralHttpDependencies,
): void {
  const publicRateLimiter =
    dependencies.publicRateLimiter ??
    createReferralPublicRateLimiter(dependencies.rateLimitKeyring);

  app.get<{
    Querystring: Record<string, unknown>;
    Reply: PublicResolutionBody | ErrorBody;
  }>(
    "/api/public/referral",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      schema: {
        response: {
          200: PUBLIC_RESOLUTION_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        publicRateLimiter.consume(request.ip);
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          return reply.code(429).send(errorBody("rate_limited"));
        }
        return reply.code(503).send(errorBody("referral_unavailable"));
      }

      const publicCode = publicCodeFromQuery(request.query);
      if (publicCode === null) {
        return reply.code(200).send({ valid: false });
      }
      try {
        return reply
          .code(200)
          .send({ valid: resolveReferralPublicCode(dependencies.database, publicCode) });
      } catch {
        return reply.code(503).send(errorBody("referral_unavailable"));
      }
    },
  );

  app.get<{ Reply: ReferralStateBody | ErrorBody }>(
    "/api/me/referral",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      schema: {
        response: {
          200: STATE_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        const session = readSession(request, dependencies);
        if (session === null) {
          return reply.code(401).send(errorBody("unauthorized"));
        }
        return reply
          .code(200)
          .send(
            stateBody(
              readReferralProfile(
                dependencies.database,
                session.userId,
              ),
              dependencies.publicLink,
            ),
          );
      } catch {
        return reply.code(503).send(errorBody("referral_unavailable"));
      }
    },
  );

  app.post<{
    Body: Record<string, never>;
    Reply: ReferralStateBody | ErrorBody;
  }>(
    "/api/me/referral/profile",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      errorHandler: referralMutationErrorHandler,
      schema: {
        headers: MUTATION_HEADERS_SCHEMA,
        body: EMPTY_BODY_SCHEMA,
        response: {
          200: STATE_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      if (request.headers.origin !== allowedOrigin(dependencies.nodeEnv)) {
        return reply.code(400).send(errorBody("origin_rejected"));
      }
      try {
        const session = readSession(request, dependencies);
        if (session === null) {
          return reply.code(401).send(errorBody("unauthorized"));
        }
        if (
          !verifyCsrfToken(
            dependencies.csrfSigningKey,
            session.sessionTokenHash,
            request.headers["x-csrf-token"],
          )
        ) {
          return reply.code(403).send(errorBody("csrf_invalid"));
        }
        return reply
          .code(200)
          .send(
            stateBody(
              ensureReferralProfile(
                dependencies.database,
                session.userId,
                dependencies,
              ),
              dependencies.publicLink,
            ),
          );
      } catch {
        return reply.code(503).send(errorBody("referral_unavailable"));
      }
    },
  );
}
