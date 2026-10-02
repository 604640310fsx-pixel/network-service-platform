import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  confirmPasswordReset,
  PasswordResetError,
  requestPasswordReset,
  type PasswordResetDependencies,
} from "../account/password-reset.js";
import { isArgon2BusyError } from "../auth/argon2-gate.js";
import type { RuntimeEnvironment } from "../config.js";
import { RateLimitExceededError } from "./rate-limit.js";

/* /api/auth/password-reset/{request,confirm}: signed-out password reset.
   Same guards as registration: exact Origin and JSON mutation headers, no
   session. Request answers { status: "ok" } for every well-formed address,
   registered or not. Responses never echo addresses, tokens or passwords. */

const PRODUCTION_ORIGIN = "https://www.siqiapparel.com";
const DEVELOPMENT_ORIGIN = "http://localhost:5173";

export interface PasswordResetHttpDependencies extends PasswordResetDependencies {
  readonly nodeEnv: RuntimeEnvironment;
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

const MUTATION_HEADERS_SCHEMA = {
  type: "object",
  required: ["content-type", "x-requested-with"],
  properties: {
    "content-type": { type: "string", const: "application/json" },
    "x-requested-with": { type: "string", const: "XMLHttpRequest" },
  },
} as const;

const REQUEST_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: { email: { type: "string", minLength: 1, maxLength: 254 } },
} as const;

const CONFIRM_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["token", "password"],
  properties: {
    token: { type: "string", minLength: 1, maxLength: 256 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;

const RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  422: ERROR_RESPONSE_SCHEMA,
  429: ERROR_RESPONSE_SCHEMA,
  503: ERROR_RESPONSE_SCHEMA,
} as const;

function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PasswordResetError) {
    return reply
      .code(error.code === "password_policy_violation" ? 422 : 400)
      .send(errorBody(error.code));
  }
  if (error instanceof RateLimitExceededError) {
    return reply.code(429).send(errorBody("rate_limited"));
  }
  if (isArgon2BusyError(error)) {
    return reply.header("Retry-After", "2").code(503).send(errorBody("busy"));
  }
  return reply.code(503).send(errorBody("account_unavailable"));
}

export function registerPasswordResetHttpRoutes(
  app: FastifyInstance,
  dependencies: PasswordResetHttpDependencies,
): void {
  const origin = dependencies.nodeEnv === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
  const common = {
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
    },
    preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers.origin !== origin) {
        await reply.code(400).send(errorBody("origin_rejected"));
      }
    },
    errorHandler: async (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      if (
        error.validation !== undefined ||
        error.statusCode === 400 ||
        error.statusCode === 413 ||
        error.statusCode === 415
      ) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      return reply.code(503).send(errorBody("account_unavailable"));
    },
  };

  app.post<{ Body: { email: string } }>(
    "/api/auth/password-reset/request",
    { ...common, schema: { headers: MUTATION_HEADERS_SCHEMA, body: REQUEST_BODY, response: { 200: OK_RESPONSE_SCHEMA, ...RESPONSES } } },
    async (request, reply) => {
      try {
        requestPasswordReset(dependencies, { email: request.body.email, ip: request.ip });
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    "/api/auth/password-reset/confirm",
    { ...common, schema: { headers: MUTATION_HEADERS_SCHEMA, body: CONFIRM_BODY, response: { 200: OK_RESPONSE_SCHEMA, ...RESPONSES } } },
    async (request, reply) => {
      try {
        await confirmPasswordReset(dependencies, { ...request.body, ip: request.ip });
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}
