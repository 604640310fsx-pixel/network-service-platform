import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { PasswordPolicyError } from "../auth/password-policy.js";
import type { RuntimeEnvironment } from "../config.js";
import { assertRegistrationPasswordConfirmation } from "../registration/password-confirmation.js";
import { REGISTRATION_TOKEN_PATTERN } from "../registration/registration-crypto.js";

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

interface ErrorBody {
  readonly error: { readonly code: string };
}

export type CompleteRegistrationOperation = (
  input: CompleteRegistrationBody,
) => Promise<void> | void;

export interface RegistrationCompleteHttpDependencies {
  readonly nodeEnv: RuntimeEnvironment;
  readonly completeRegistration: CompleteRegistrationOperation;
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

export function registerRegistrationCompleteRoute(
  app: FastifyInstance,
  dependencies: RegistrationCompleteHttpDependencies,
): void {
  app.post<{
    Body: CompleteRegistrationBody;
    Reply: StatusBody | ErrorBody;
  }>(
    "/api/auth/register/complete",
    {
      onRequest: async (_request, reply) => {
        void reply.header("Cache-Control", "no-store");
      },
      preValidation: async (request, reply) =>
        requireRegistrationOrigin(request, reply, dependencies.nodeEnv),
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
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: { status: { type: "string", const: "ok" } },
          },
          400: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          422: ERROR_RESPONSE_SCHEMA,
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
        await dependencies.completeRegistration(request.body);
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        if (error instanceof PasswordPolicyError) {
          return reply
            .code(422)
            .send(errorBody("password_policy_violation"));
        }
        return reply.code(503).send(errorBody("auth_unavailable"));
      }
    },
  );
}
