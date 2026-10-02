import Fastify, { type FastifyInstance } from "fastify";

import { registerPaymentAdminHttpRoutes } from "./http/admin-routes.js";
import { registerAdminServiceHttpRoutes } from "./http/admin-service-routes.js";
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
  registerAccountHttpRoutes,
  type AccountHttpDependencies,
} from "./http/account-routes.js";
import {
  registerPasswordResetHttpRoutes,
  type PasswordResetHttpDependencies,
} from "./http/password-reset-routes.js";
import {
  registerInviteHttpRoutes,
  type InviteHttpDependencies,
} from "./http/invite-routes.js";
import {
  registerTicketHttpRoutes,
  type TicketHttpDependencies,
} from "./http/ticket-routes.js";
import {
  registerPaymentHttpRoutes,
  type PaymentHttpDependencies,
} from "./http/payment-routes.js";
import {
  registerMonitorHttpRoutes,
  type MonitorHttpDependencies,
} from "./http/monitor-routes.js";
import {
  registerReferralHttpRoutes,
  type ReferralHttpDependencies,
} from "./http/referral-routes.js";

interface HealthResponse {
  readonly status: "ok";
}

interface ReadinessResponse {
  readonly status: "ready" | "not_ready";
}

const HEALTH_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ok" },
  },
} as const;

const READY_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ready" },
  },
} as const;

const NOT_READY_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "not_ready" },
  },
} as const;

export interface ReadinessDependencies {
  isReady(): boolean;
}

export interface BuildAppOptions {
  readonly auth?: AuthHttpDependencies;
  readonly registration?: RegistrationHttpDependencies;
  readonly inviteAdmin?: InviteAdminHttpDependencies;
  readonly diagnosis?: DiagnosisHttpDependencies;
  readonly tickets?: TicketHttpDependencies;
  readonly invites?: InviteHttpDependencies;
  readonly account?: AccountHttpDependencies;
  readonly passwordReset?: PasswordResetHttpDependencies;
  readonly payment?: PaymentHttpDependencies;
  readonly monitor?: MonitorHttpDependencies;
  readonly referral?: ReferralHttpDependencies;
  readonly readiness?: ReadinessDependencies;
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

  app.get<{ Reply: ReadinessResponse }>(
    "/ready",
    {
      schema: {
        response: {
          200: READY_RESPONSE_SCHEMA,
          503: NOT_READY_RESPONSE_SCHEMA,
        },
      },
    },
    (_request, reply) => {
      let ready = false;
      try {
        ready = options.readiness?.isReady() === true;
      } catch {
        ready = false;
      }
      reply.header("Cache-Control", "no-store");
      reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? "ready" : "not_ready" });
    },
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
  if (options.referral !== undefined) {
    registerReferralHttpRoutes(app, options.referral);
  }
  if (options.tickets !== undefined) {
    registerTicketHttpRoutes(app, options.tickets);
  }
  if (options.invites !== undefined) {
    registerInviteHttpRoutes(app, options.invites);
  }
  if (options.account !== undefined) {
    registerAccountHttpRoutes(app, options.account);
  }
  if (options.passwordReset !== undefined) {
    registerPasswordResetHttpRoutes(app, options.passwordReset);
  }
  registerMonitorHttpRoutes(app, options.monitor ?? null);
  const payment = options.payment ?? { enabled: false };
  registerPaymentHttpRoutes(app, payment);
  registerPaymentAdminHttpRoutes(app, payment);
  registerAdminServiceHttpRoutes(app, payment);

  return app;
}
