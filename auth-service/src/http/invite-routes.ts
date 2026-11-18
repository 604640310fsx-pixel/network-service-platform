import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RuntimeEnvironment } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { ensureReferralProfile, readReferralProfile, type ReferralProfile } from "../referral/profile.js";
import { readReferralSessionReadOnly } from "../referral/http-auth.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import { verifyCsrfToken } from "./csrf.js";

/* /api/me/invites: the signed-in account's own personal invite code (its stable
   referral public code) and how many accounts it directly invited. Self-only:
   no invitee identity or other personal data is ever returned.
   - GET is read-only. An account without a code gets an explicit
     "uninitialized" state, never a generated or placeholder code.
   - POST is the only write: session + Origin + CSRF, empty body. It provisions
     the code once through the existing collision-safe mechanism and is
     idempotent; an existing code is returned unchanged, never rotated.
   New accounts receive their code inside the registration transaction. */

const PRODUCTION_ORIGIN = "https://www.siqiapparel.com";
const DEVELOPMENT_ORIGIN = "http://localhost:5173";

export interface InviteHttpDependencies {
  readonly database: DatabaseConnection;
  readonly nodeEnv: RuntimeEnvironment;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly csrfSigningKey: Buffer;
  readonly now?: () => Date;
}

type InviteStateBody =
  | { readonly status: "ready"; readonly code: string; readonly directInviteCount: number }
  | { readonly status: "uninitialized" };

interface ErrorBody {
  readonly error: { readonly code: string };
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

const STATE_RESPONSE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "code", "directInviteCount"],
      properties: {
        status: { type: "string", const: "ready" },
        code: { type: "string" },
        directInviteCount: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", const: "uninitialized" } },
    },
  ],
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
  reply.header("Cache-Control", "no-store");
}

function allowedOrigin(nodeEnv: RuntimeEnvironment): string {
  return nodeEnv === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
}

async function inviteMutationErrorHandler(
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
  return reply.code(503).send(errorBody("invites_unavailable"));
}

function countDirectInvites(database: DatabaseConnection, userId: number): number {
  const rows = database
    .prepare("SELECT COUNT(*) AS count FROM users WHERE invited_by_user_id = ?")
    .all(userId) as Array<{ readonly count: unknown }>;
  const count = rows[0]?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Direct invite count is invalid");
  }
  return count;
}

function stateBody(database: DatabaseConnection, userId: number, profile: ReferralProfile | null): InviteStateBody {
  if (profile === null) return { status: "uninitialized" };
  return { status: "ready", code: profile.publicCode, directInviteCount: countDirectInvites(database, userId) };
}

export function registerInviteHttpRoutes(app: FastifyInstance, dependencies: InviteHttpDependencies): void {
  app.get<{ Reply: InviteStateBody | ErrorBody }>(
    "/api/me/invites",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      schema: {
        response: { 200: STATE_RESPONSE_SCHEMA, 401: ERROR_RESPONSE_SCHEMA, 503: ERROR_RESPONSE_SCHEMA },
      },
    },
    async (request, reply) => {
      try {
        const session = readReferralSessionReadOnly(request, dependencies);
        if (session === null) {
          return reply.code(401).send(errorBody("unauthorized"));
        }
        const profile = readReferralProfile(dependencies.database, session.userId);
        return reply.code(200).send(stateBody(dependencies.database, session.userId, profile));
      } catch {
        return reply.code(503).send(errorBody("invites_unavailable"));
      }
    },
  );

  app.post<{ Body: Record<string, never>; Reply: InviteStateBody | ErrorBody }>(
    "/api/me/invites",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      errorHandler: inviteMutationErrorHandler,
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
        const session = readReferralSessionReadOnly(request, dependencies);
        if (session === null) {
          return reply.code(401).send(errorBody("unauthorized"));
        }
        if (!verifyCsrfToken(dependencies.csrfSigningKey, session.sessionTokenHash, request.headers["x-csrf-token"])) {
          return reply.code(403).send(errorBody("csrf_invalid"));
        }
        const profile = ensureReferralProfile(
          dependencies.database,
          session.userId,
          dependencies.now ? { now: dependencies.now } : {},
        );
        return reply.code(200).send(stateBody(dependencies.database, session.userId, profile));
      } catch {
        return reply.code(503).send(errorBody("invites_unavailable"));
      }
    },
  );
}
