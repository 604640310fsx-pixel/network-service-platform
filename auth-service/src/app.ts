import Fastify, { type FastifyInstance } from "fastify";

import {
  registerAuthHttpRoutes,
  type AuthHttpDependencies,
} from "./http/auth-routes.js";

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

  return app;
}
