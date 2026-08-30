import Fastify, { type FastifyInstance } from "fastify";

import { registerPaymentAdminHttpRoutes } from "./http/admin-routes.js";
import {
  registerAuthHttpRoutes,
  type AuthHttpDependencies,
} from "./http/auth-routes.js";
import {
  registerRegistrationHttpRoutes,
  type RegistrationHttpDependencies,
} from "./http/registration-routes.js";
import {
  registerInviteAdminHttpRoutes,
  type InviteAdminHttpDependencies,
} from "./http/invite-admin-routes.js";
import {
  registerDiagnosisHttpRoutes,
  type DiagnosisHttpDependencies,
} from "./http/diagnosis-routes.js";
import {
  registerPaymentHttpRoutes,
  type PaymentHttpDependencies,
} from "./http/payment-routes.js";

interface HealthResponse {
  readonly status: "ok";
}

const HEALTH_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ok" },
  },
} as const;

export interface BuildAppOptions {
  readonly auth?: AuthHttpDependencies;
  readonly registration?: RegistrationHttpDependencies;
  readonly inviteAdmin?: InviteAdminHttpDependencies;
  readonly diagnosis?: DiagnosisHttpDependencies;
  readonly payment?: PaymentHttpDependencies;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: (address) => address === "127.0.0.1" || address === "::1",
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.get<{ Reply: HealthResponse }>(
    "/health",
    {
      schema: {
        response: {
          200: HEALTH_RESPONSE_SCHEMA,
        },
      },
    },
    async () => ({ status: "ok" }),
  );

  if (options.auth !== undefined) {
    registerAuthHttpRoutes(app, options.auth);
  }
  if (options.registration !== undefined) {
    registerRegistrationHttpRoutes(app, options.registration);
  }
  if (options.inviteAdmin !== undefined) {
    registerInviteAdminHttpRoutes(app, options.inviteAdmin);
  }
  if (options.diagnosis !== undefined) {
    registerDiagnosisHttpRoutes(app, options.diagnosis);
  }
  const payment = options.payment ?? { enabled: false };
  registerPaymentHttpRoutes(app, payment);
  registerPaymentAdminHttpRoutes(app, payment);

  return app;
}
