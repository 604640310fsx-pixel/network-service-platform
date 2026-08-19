import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { isArgon2BusyError } from "../auth/argon2-gate.js";
import { InvalidEmailError } from "../auth/email.js";
import { PasswordPolicyError } from "../auth/password-policy.js";
import type { RuntimeEnvironment } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import type { InviteHmacKeyring } from "../registration/invite-code.js";
import { assertRegistrationPasswordConfirmation } from "../registration/password-confirmation.js";
import {
  INVITE_CODE_PATTERN,
} from "../registration/invite-code.js";
import {
  REGISTRATION_OTP_PATTERN,
  REGISTRATION_TOKEN_PATTERN,
} from "../registration/registration-crypto.js";
import {
  completeRegistration,
  InvalidOrExpiredRegistrationError,
  RegistrationEmailTakenError,
  resendRegistrationCode,
  startRegistration,
  verifyRegistrationCode,
  type RegistrationServiceDependencies,
  type RegistrationServiceKeyrings,
} from "../registration/registration-service.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  RateLimitExceededError,
  type RateLimitKeyring,
} from "./rate-limit.js";

const PRODUCTION_ORIGIN = "https://www.siqiapparel.com";
const DEVELOPMENT_ORIGIN = "http://localhost:5173";

interface CompleteRegistrationBody {
  readonly registrationToken: string;
  readonly password: string;
  readonly confirmPassword: string;
}

interface StatusBody {
  readonly status: "ok";
}

interface RegistrationTokenBody extends StatusBody {
  readonly registrationToken: string;
}

interface StartRegistrationBody {
  readonly email: string;
  readonly inviteCode: string;
}

interface RegistrationTokenRequestBody {
  readonly registrationToken: string;
}

interface VerifyRegistrationBody extends RegistrationTokenRequestBody {
  readonly otp: string;
}

interface ErrorBody {
  readonly error: { readonly code: string };
}

export interface RegistrationHttpDependencies {
  readonly database: DatabaseConnection;
  readonly nodeEnv: RuntimeEnvironment;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly inviteHmacKeyring: InviteHmacKeyring;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly serviceDependencies?: RegistrationServiceDependencies;
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

function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

const STATUS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", const: "ok" } },
} as const;

const TOKEN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "registrationToken"],
  properties: {
    status: { type: "string", const: "ok" },
    registrationToken: {
      type: "string",
      pattern: REGISTRATION_TOKEN_PATTERN.source,
    },
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

function allowedOrigin(nodeEnv: RuntimeEnvironment): string {
  return nodeEnv === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
}

async function requireRegistrationOrigin(
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

function keyrings(
  dependencies: RegistrationHttpDependencies,
): RegistrationServiceKeyrings {
  return {
    tokenHmacKeyring: dependencies.tokenHmacKeyring,
    inviteHmacKeyring: dependencies.inviteHmacKeyring,
    mailPayloadEncKeyring: dependencies.mailPayloadEncKeyring,
    rateLimitKeyring: dependencies.rateLimitKeyring,
  };
}

function registrationError(
  error: unknown,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof InvalidOrExpiredRegistrationError) {
    return reply.code(400).send(errorBody("invalid_or_expired"));
  }
  if (error instanceof RegistrationEmailTakenError) {
    return reply.code(409).send(errorBody("email_taken"));
  }
  if (error instanceof PasswordPolicyError) {
    return reply.code(422).send(errorBody("password_policy_violation"));
  }
  if (error instanceof RateLimitExceededError) {
    return reply.code(429).send(errorBody("rate_limited"));
  }
  if (isArgon2BusyError(error)) {
    return reply
      .header("Retry-After", "2")
      .code(503)
      .send(errorBody("busy"));
  }
  if (error instanceof InvalidEmailError) {
    return reply.code(400).send(errorBody("invalid_request"));
  }
  return reply.code(503).send(errorBody("auth_unavailable"));
}

export function registerRegistrationHttpRoutes(
  app: FastifyInstance,
  dependencies: RegistrationHttpDependencies,
): void {
  const registrationKeyrings = keyrings(dependencies);
  const commonHooks = {
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) =>
      setNoStore(reply),
    preValidation: async (request: FastifyRequest, reply: FastifyReply) =>
      requireRegistrationOrigin(request, reply, dependencies.nodeEnv),
    errorHandler: async (
      error: FastifyError,
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (error.validation !== undefined) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      return reply.code(503).send(errorBody("auth_unavailable"));
    },
  };

  app.post<{
    Body: StartRegistrationBody;
    Reply: RegistrationTokenBody | ErrorBody;
  }>(
    "/api/auth/register/start",
    {
      ...commonHooks,
      schema: {
        headers: MUTATION_HEADERS_SCHEMA,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "inviteCode"],
          properties: {
            email: { type: "string", maxLength: 254 },
            inviteCode: {
              type: "string",
              pattern: INVITE_CODE_PATTERN.source,
            },
          },
        },
        response: {
          200: TOKEN_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = startRegistration(
          dependencies.database,
          { ...request.body, ip: request.ip },
          registrationKeyrings,
          dependencies.serviceDependencies,
        );
        return reply.code(200).send({ status: "ok", ...result });
      } catch (error) {
        return registrationError(error, reply);
      }
    },
  );

  app.post<{
    Body: RegistrationTokenRequestBody;
    Reply: StatusBody | ErrorBody;
  }>(
    "/api/auth/register/resend-code",
    {
      ...commonHooks,
      schema: {
        headers: MUTATION_HEADERS_SCHEMA,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["registrationToken"],
          properties: {
            registrationToken: {
              type: "string",
              pattern: REGISTRATION_TOKEN_PATTERN.source,
            },
          },
        },
        response: {
          200: STATUS_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        resendRegistrationCode(
          dependencies.database,
          { ...request.body, ip: request.ip },
          registrationKeyrings,
          dependencies.serviceDependencies,
        );
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        return registrationError(error, reply);
      }
    },
  );

  app.post<{
    Body: VerifyRegistrationBody;
    Reply: RegistrationTokenBody | ErrorBody;
  }>(
    "/api/auth/register/verify-code",
    {
      ...commonHooks,
      schema: {
        headers: MUTATION_HEADERS_SCHEMA,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["registrationToken", "otp"],
          properties: {
            registrationToken: {
              type: "string",
              pattern: REGISTRATION_TOKEN_PATTERN.source,
            },
            otp: { type: "string", pattern: REGISTRATION_OTP_PATTERN.source },
          },
        },
        response: {
          200: TOKEN_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = verifyRegistrationCode(
          dependencies.database,
          { ...request.body, ip: request.ip },
          registrationKeyrings,
          dependencies.serviceDependencies,
        );
        return reply.code(200).send({ status: "ok", ...result });
      } catch (error) {
        return registrationError(error, reply);
      }
    },
  );

  app.post<{
    Body: CompleteRegistrationBody;
    Reply: StatusBody | ErrorBody;
  }>(
    "/api/auth/register/complete",
    {
      ...commonHooks,
      schema: {
        headers: MUTATION_HEADERS_SCHEMA,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["registrationToken", "password", "confirmPassword"],
          properties: {
            registrationToken: {
              type: "string",
              pattern: REGISTRATION_TOKEN_PATTERN.source,
            },
            password: { type: "string", minLength: 12, maxLength: 256 },
            confirmPassword: { type: "string", maxLength: 256 },
          },
        },
        response: {
          200: STATUS_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          422: ERROR_RESPONSE_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        assertRegistrationPasswordConfirmation(
          request.body.password,
          request.body.confirmPassword,
        );
        await completeRegistration(
          dependencies.database,
          {
            registrationToken: request.body.registrationToken,
            password: request.body.password,
            ip: request.ip,
          },
          registrationKeyrings,
          dependencies.serviceDependencies,
        );
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        return registrationError(error, reply);
      }
    },
  );
}
