import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { canonicalizeEmail } from "../auth/email.js";
import { InvalidCredentialsError } from "../auth/authentication.js";
import { isArgon2BusyError } from "../auth/argon2-gate.js";
import type { RuntimeEnvironment } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import {
  loginAndCreateSession,
  type LoginSessionDependencies,
  type LoginSessionResult,
} from "../session/login-session.js";
import {
  computeSessionTokenHash,
  type TokenHmacKeyring,
} from "../session/session-token.js";
import {
  lookupAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
  type SessionLookupDependencies,
} from "../session/session-validity.js";
import {
  readWebSessionCookie,
  serializeWebSessionCookie,
} from "./cookie.js";
import { issueCsrfToken } from "./csrf.js";
import {
  consumeLoginRateLimit,
  RateLimitExceededError,
  type LoginRateLimitDependencies,
  type RateLimitKeyring,
} from "./rate-limit.js";

const PRODUCTION_ORIGIN = "https://www.siqiapparel.com";
const DEVELOPMENT_ORIGIN = "http://localhost:5173";

interface LoginBody {
  readonly email: string;
  readonly password: string;
}

interface ErrorBody {
  readonly error: { readonly code: string };
}

interface LoginSuccessBody {
  readonly status: "ok";
}

interface MeSuccessBody {
  readonly user: {
    readonly email: string;
    readonly role: "user" | "admin";
  };
  readonly csrfToken: string;
}

type LoginOperation = (
  database: DatabaseConnection,
  email: string,
  password: string,
  tokenHmacKeyring: TokenHmacKeyring,
  dependencies?: LoginSessionDependencies,
) => Promise<LoginSessionResult>;

type SessionLookupOperation = (
  database: DatabaseConnection,
  rawSessionToken: string,
  audience: "web",
  tokenHmacKeyring: TokenHmacKeyring,
  dependencies?: SessionLookupDependencies,
) => AuthenticatedPrincipal | null;

export interface AuthHttpDependencies {
  readonly database: DatabaseConnection;
  readonly nodeEnv: RuntimeEnvironment;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly csrfSigningKey: Buffer;
  readonly loginSessionDependencies?: LoginSessionDependencies;
  readonly sessionLookupDependencies?: SessionLookupDependencies;
  readonly rateLimitDependencies?: LoginRateLimitDependencies;
  readonly loginOperation?: LoginOperation;
  readonly sessionLookupOperation?: SessionLookupOperation;
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

const LOGIN_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", maxLength: 254 },
    password: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

const LOGIN_SUCCESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", const: "ok" } },
} as const;

const ME_SUCCESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["user", "csrfToken"],
  properties: {
    user: {
      type: "object",
      additionalProperties: false,
      required: ["email", "role"],
      properties: {
        email: { type: "string" },
        role: { type: "string", enum: ["user", "admin"] },
      },
    },
    csrfToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  },
} as const;

function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

function allowedOrigin(nodeEnv: RuntimeEnvironment): string {
  return nodeEnv === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
}

async function requireLoginOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  nodeEnv: RuntimeEnvironment,
): Promise<void> {
  if (request.headers.origin !== allowedOrigin(nodeEnv)) {
    await reply.code(400).send(errorBody("origin_rejected"));
  }
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

export function registerAuthHttpRoutes(
  app: FastifyInstance,
  dependencies: AuthHttpDependencies,
): void {
  const loginOperation = dependencies.loginOperation ?? loginAndCreateSession;
  const sessionLookup =
    dependencies.sessionLookupOperation ?? lookupAuthenticatedPrincipal;

  app.post<{ Body: LoginBody; Reply: LoginSuccessBody | ErrorBody }>(
    "/api/auth/login",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      preValidation: async (request, reply) =>
        requireLoginOrigin(request, reply, dependencies.nodeEnv),
      schema: {
        headers: {
          type: "object",
          required: ["content-type", "x-requested-with"],
          properties: {
            "content-type": { type: "string", const: "application/json" },
            "x-requested-with": {
              type: "string",
              const: "XMLHttpRequest",
            },
          },
        },
        body: LOGIN_BODY_SCHEMA,
        response: {
          200: LOGIN_SUCCESS_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      let canonicalEmail: string;
      try {
        canonicalEmail = canonicalizeEmail(request.body.email);
      } catch {
        return reply.code(401).send(errorBody("invalid_credentials"));
      }

      try {
        consumeLoginRateLimit(
          dependencies.database,
          dependencies.rateLimitKeyring,
          { ip: request.ip, canonicalEmail },
          dependencies.rateLimitDependencies,
        );
        const result = await loginOperation(
          dependencies.database,
          canonicalEmail,
          request.body.password,
          dependencies.tokenHmacKeyring,
          dependencies.loginSessionDependencies,
        );

        return reply
          .header("Set-Cookie", serializeWebSessionCookie(result.rawSessionToken))
          .code(200)
          .send({ status: "ok" });
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          return reply.code(401).send(errorBody("invalid_credentials"));
        }
        if (isArgon2BusyError(error)) {
          return reply
            .header("Retry-After", "2")
            .code(503)
            .send(errorBody("busy"));
        }
        if (error instanceof RateLimitExceededError) {
          return reply.code(429).send(errorBody("rate_limited"));
        }
        return reply.code(503).send(errorBody("auth_unavailable"));
      }
    },
  );

  app.get<{ Reply: MeSuccessBody | ErrorBody }>(
    "/api/auth/me",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      schema: {
        response: {
          200: ME_SUCCESS_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const rawSessionToken = readWebSessionCookie(request.headers.cookie);
      if (rawSessionToken === null) {
        return reply.code(401).send(errorBody("unauthorized"));
      }

      try {
        const principal = sessionLookup(
          dependencies.database,
          rawSessionToken,
          "web",
          dependencies.tokenHmacKeyring,
          dependencies.sessionLookupDependencies,
        );
        if (principal === null) {
          return reply.code(401).send(errorBody("unauthorized"));
        }

        const { tokenHash } = computeSessionTokenHash(
          rawSessionToken,
          dependencies.tokenHmacKeyring,
        );
        const csrfToken = issueCsrfToken(
          dependencies.csrfSigningKey,
          tokenHash,
        );
        return reply.code(200).send({
          user: { email: principal.email, role: principal.role },
          csrfToken,
        });
      } catch {
        return reply.code(401).send(errorBody("unauthorized"));
      }
    },
  );
}
