import type { FastifyError, FastifyReply, FastifyRequest, FastifyInstance } from "fastify";

import {
  AccountSecurityError,
  changeAccountPassword,
  confirmAccountEmailChange,
  startAccountEmailChange,
  type AccountSecurityDependencies,
  type AccountSession,
} from "../account/account-security.js";
import type { RuntimeEnvironment } from "../config.js";
import { readReferralSessionReadOnly } from "../referral/http-auth.js";
import { verifyCsrfToken } from "./csrf.js";
import { RateLimitExceededError } from "./rate-limit.js";

/* /api/me/password/change and /api/me/email/change/{start,confirm}: signed-in
   account security writes. Same guards as the other /api/me writes: exact
   Origin, a valid web session, the session-bound CSRF token and JSON
   mutation headers. Responses never echo passwords, codes or addresses. */

const PRODUCTION_ORIGIN = "https://www.siqiapparel.com";
const DEVELOPMENT_ORIGIN = "http://localhost:5173";

export interface AccountHttpDependencies extends AccountSecurityDependencies {
  readonly nodeEnv: RuntimeEnvironment;
  readonly csrfSigningKey: Buffer;
}

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

const OK_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", const: "ok" } },
} as const;

const START_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changeToken", "expiresAt"],
  properties: {
    status: { type: "string", const: "ok" },
    changeToken: { type: "string" },
    expiresAt: { type: "string" },
  },
} as const;

const MUTATION_HEADERS_SCHEMA = {
  type: "object",
  required: ["content-type", "x-requested-with"],
  properties: {
    "content-type": { type: "string", const: "application/json" },
    "x-requested-with": { type: "string", const: "XMLHttpRequest" },
  },
} as const;

function stringBody(fields: Readonly<Record<string, number>>) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(fields),
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, maxLength]) => [name, { type: "string", minLength: 1, maxLength }]),
    ),
  } as const;
}

const PASSWORD_CHANGE_BODY = stringBody({ currentPassword: 1024, newPassword: 1024, confirmPassword: 1024 });
const EMAIL_START_BODY = stringBody({ currentPassword: 1024, newEmail: 320 });
const EMAIL_CONFIRM_BODY = stringBody({ changeToken: 4096, code: 16 });

const RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  401: ERROR_RESPONSE_SCHEMA,
  403: ERROR_RESPONSE_SCHEMA,
  409: ERROR_RESPONSE_SCHEMA,
  422: ERROR_RESPONSE_SCHEMA,
  429: ERROR_RESPONSE_SCHEMA,
  503: ERROR_RESPONSE_SCHEMA,
} as const;

const ERROR_STATUS: Readonly<Record<AccountSecurityError["code"], number>> = {
  invalid_credentials: 401,
  password_policy_violation: 422,
  invalid_email: 400,
  email_unchanged: 400,
  email_taken: 409,
  invalid_code: 400,
  invalid_or_expired: 400,
};

function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

async function accountMutationErrorHandler(
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
  return reply.code(503).send(errorBody("account_unavailable"));
}

type Guarded =
  | { readonly session: AccountSession }
  | { readonly status: number; readonly code: string };

function guard(request: FastifyRequest, dependencies: AccountHttpDependencies): Guarded {
  const origin = dependencies.nodeEnv === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
  if (request.headers.origin !== origin) return { status: 400, code: "origin_rejected" };
  const session = readReferralSessionReadOnly(request, dependencies);
  if (session === null) return { status: 401, code: "unauthorized" };
  if (!verifyCsrfToken(dependencies.csrfSigningKey, session.sessionTokenHash, request.headers["x-csrf-token"])) {
    return { status: 403, code: "csrf_invalid" };
  }
  return { session };
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AccountSecurityError) {
    return reply.code(ERROR_STATUS[error.code]).send(errorBody(error.code));
  }
  if (error instanceof RateLimitExceededError) {
    return reply.code(429).send(errorBody("rate_limited"));
  }
  return reply.code(503).send(errorBody("account_unavailable"));
}

export function registerAccountHttpRoutes(app: FastifyInstance, dependencies: AccountHttpDependencies): void {
  const common = {
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
    },
    errorHandler: accountMutationErrorHandler,
  };

  app.post<{
    Body: { currentPassword: string; newPassword: string; confirmPassword: string };
  }>(
    "/api/me/password/change",
    { ...common, schema: { headers: MUTATION_HEADERS_SCHEMA, body: PASSWORD_CHANGE_BODY, response: { 200: OK_RESPONSE_SCHEMA, ...RESPONSES } } },
    async (request, reply) => {
      try {
        const guarded = guard(request, dependencies);
        if (!("session" in guarded)) return reply.code(guarded.status).send(errorBody(guarded.code));
        await changeAccountPassword(dependencies, guarded.session, request.body);
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post<{ Body: { currentPassword: string; newEmail: string } }>(
    "/api/me/email/change/start",
    { ...common, schema: { headers: MUTATION_HEADERS_SCHEMA, body: EMAIL_START_BODY, response: { 200: START_RESPONSE_SCHEMA, ...RESPONSES } } },
    async (request, reply) => {
      try {
        const guarded = guard(request, dependencies);
        if (!("session" in guarded)) return reply.code(guarded.status).send(errorBody(guarded.code));
        const started = await startAccountEmailChange(dependencies, guarded.session, request.body);
        return reply.code(200).send({ status: "ok", ...started });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post<{ Body: { changeToken: string; code: string } }>(
    "/api/me/email/change/confirm",
    { ...common, schema: { headers: MUTATION_HEADERS_SCHEMA, body: EMAIL_CONFIRM_BODY, response: { 200: OK_RESPONSE_SCHEMA, ...RESPONSES } } },
    async (request, reply) => {
      try {
        const guarded = guard(request, dependencies);
        if (!("session" in guarded)) return reply.code(guarded.status).send(errorBody(guarded.code));
        confirmAccountEmailChange(dependencies, guarded.session, request.body);
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}
