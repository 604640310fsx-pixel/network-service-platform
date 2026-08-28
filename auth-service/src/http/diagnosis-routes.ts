import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { RuntimeEnvironment } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import {
  BUSINESS_SCENARIOS,
  classifyDiagnosisRequest,
  CONTACT_TYPES,
  CURRENT_NETWORK_TYPES,
  DIAGNOSIS_CLASSIFICATIONS,
  DiagnosisDomainError,
  listDiagnosisRequests,
  normalizeDiagnosisClassification,
  normalizeDiagnosisSubmission,
  PROBLEM_FREQUENCIES,
  PROBLEM_TYPES,
  createDiagnosisRequest,
  type DiagnosisStatus,
} from "../diagnosis/requests.js";
import { readPaymentSession } from "../payment/http-auth.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import { verifyCsrfToken } from "./csrf.js";
import {
  RateLimitExceededError,
  withDiagnosisSubmitRateLimit,
  type RateLimitKeyring,
} from "./rate-limit.js";

const PRODUCTION_ORIGIN = "https://www.siqiapparel.com";
const DEVELOPMENT_ORIGIN = "http://localhost:5173";
const DIAGNOSIS_BODY_LIMIT_BYTES = 16 * 1024;

interface StatusBody {
  readonly status: "ok";
}

interface ErrorBody {
  readonly error: { readonly code: string };
}

export interface DiagnosisHttpDependencies {
  readonly database: DatabaseConnection;
  readonly nodeEnv: RuntimeEnvironment;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly csrfSigningKey: Buffer;
  readonly now?: () => Date;
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

const STATUS_RESPONSE_SCHEMA = {
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

const PUBLIC_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "contactType",
    "contactValue",
    "businessScenario",
    "targetRegion",
    "problemTypes",
    "problemDescription",
    "safetyAcknowledged",
  ],
  properties: {
    contactType: { type: "string", enum: [...CONTACT_TYPES] },
    contactValue: { type: "string", minLength: 1, maxLength: 200 },
    businessScenario: { type: "string", enum: [...BUSINESS_SCENARIOS] },
    targetRegion: { type: "string", minLength: 1, maxLength: 80 },
    problemTypes: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string", enum: [...PROBLEM_TYPES] },
    },
    problemDescription: { type: "string", minLength: 10, maxLength: 2000 },
    safetyAcknowledged: { type: "boolean", const: true },
    currentRegion: { type: "string", minLength: 1, maxLength: 80 },
    currentIsp: { type: "string", minLength: 1, maxLength: 120 },
    currentNetworkType: { type: "string", enum: [...CURRENT_NETWORK_TYPES] },
    problemFrequency: { type: "string", enum: [...PROBLEM_FREQUENCIES] },
    isExistingCustomer: { type: "boolean" },
    preferredContactWindow: { type: "string", minLength: 1, maxLength: 80 },
    extraNotes: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const;

const NULLABLE_STRING_SCHEMA = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const;

const ADMIN_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "contactType",
    "contactValue",
    "businessScenario",
    "targetRegion",
    "problemTypes",
    "problemDescription",
    "currentRegion",
    "currentIsp",
    "currentNetworkType",
    "problemFrequency",
    "isExistingCustomer",
    "preferredContactWindow",
    "extraNotes",
    "status",
    "classification",
    "adminNote",
    "createdAt",
    "handledAt",
  ],
  properties: {
    id: { type: "integer", minimum: 1 },
    contactType: { type: "string", enum: [...CONTACT_TYPES] },
    contactValue: { type: "string" },
    businessScenario: { type: "string", enum: [...BUSINESS_SCENARIOS] },
    targetRegion: { type: "string" },
    problemTypes: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string", enum: [...PROBLEM_TYPES] },
    },
    problemDescription: { type: "string" },
    currentRegion: NULLABLE_STRING_SCHEMA,
    currentIsp: NULLABLE_STRING_SCHEMA,
    currentNetworkType: {
      anyOf: [
        { type: "string", enum: [...CURRENT_NETWORK_TYPES] },
        { type: "null" },
      ],
    },
    problemFrequency: {
      anyOf: [
        { type: "string", enum: [...PROBLEM_FREQUENCIES] },
        { type: "null" },
      ],
    },
    isExistingCustomer: {
      anyOf: [{ type: "boolean" }, { type: "null" }],
    },
    preferredContactWindow: NULLABLE_STRING_SCHEMA,
    extraNotes: NULLABLE_STRING_SCHEMA,
    status: { type: "string", enum: ["new", "handled"] },
    classification: {
      anyOf: [
        { type: "string", enum: [...DIAGNOSIS_CLASSIFICATIONS] },
        { type: "null" },
      ],
    },
    adminNote: NULLABLE_STRING_SCHEMA,
    createdAt: { type: "string" },
    handledAt: NULLABLE_STRING_SCHEMA,
  },
} as const;

const ADMIN_LIST_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: { type: "array", maxItems: 100, items: ADMIN_ITEM_SCHEMA },
  },
} as const;

function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

function allowedOrigin(nodeEnv: RuntimeEnvironment): string {
  return nodeEnv === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
}

async function requireDiagnosisOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  nodeEnv: RuntimeEnvironment,
): Promise<void> {
  if (request.headers.origin !== allowedOrigin(nodeEnv)) {
    await reply.code(400).send(errorBody("origin_rejected"));
  }
}

async function diagnosisErrorHandler(
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
  return reply.code(503).send(errorBody("diagnosis_unavailable"));
}

interface AdminIdentity {
  readonly userId: number;
  readonly email: string;
  readonly sessionTokenHash: string;
}

type AdminAuthOutcome =
  | { readonly ok: true; readonly admin: AdminIdentity }
  | { readonly ok: false; readonly statusCode: 401 | 403 | 503; readonly code: string };

function authorizeAdmin(
  request: FastifyRequest,
  dependencies: DiagnosisHttpDependencies,
): AdminAuthOutcome {
  let session;
  try {
    session = readPaymentSession(request, dependencies);
  } catch {
    return { ok: false, statusCode: 503, code: "diagnosis_unavailable" };
  }
  if (session === null) {
    return { ok: false, statusCode: 401, code: "unauthorized" };
  }
  if (session.principal.role !== "admin") {
    return { ok: false, statusCode: 403, code: "forbidden" };
  }
  return {
    ok: true,
    admin: {
      userId: session.principal.userId,
      email: session.principal.email,
      sessionTokenHash: session.sessionTokenHash,
    },
  };
}

function verifyAdminCsrf(
  request: FastifyRequest,
  dependencies: DiagnosisHttpDependencies,
  sessionTokenHash: string,
): boolean {
  return verifyCsrfToken(
    dependencies.csrfSigningKey,
    sessionTokenHash,
    request.headers["x-csrf-token"],
  );
}

function parseStatusQuery(query: unknown): DiagnosisStatus | null {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return null;
  }
  const value = query as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "status")) {
    return null;
  }
  if (value.status === undefined || value.status === "new") {
    return "new";
  }
  return value.status === "handled" ? "handled" : null;
}

function parseRequestId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function registerDiagnosisHttpRoutes(
  app: FastifyInstance,
  dependencies: DiagnosisHttpDependencies,
): void {
  app.post<{ Body: unknown; Reply: StatusBody | ErrorBody }>(
    "/api/diagnosis/requests",
    {
      bodyLimit: DIAGNOSIS_BODY_LIMIT_BYTES,
      onRequest: async (_request, reply) => setNoStore(reply),
      preValidation: async (request, reply) =>
        requireDiagnosisOrigin(request, reply, dependencies.nodeEnv),
      errorHandler: diagnosisErrorHandler,
      schema: {
        headers: MUTATION_HEADERS_SCHEMA,
        body: PUBLIC_REQUEST_SCHEMA,
        response: {
          200: STATUS_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const submission = normalizeDiagnosisSubmission(request.body);
      if (submission === null) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        withDiagnosisSubmitRateLimit(
          dependencies.database,
          dependencies.rateLimitKeyring,
          request.ip,
          () =>
            createDiagnosisRequest(
              dependencies.database,
              submission,
              dependencies.now ?? (() => new Date()),
            ),
          dependencies.now ? { now: dependencies.now } : {},
        );
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          return reply.code(429).send(errorBody("rate_limited"));
        }
        return reply.code(503).send(errorBody("diagnosis_unavailable"));
      }
    },
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/admin/diagnosis/requests",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      errorHandler: diagnosisErrorHandler,
      schema: {
        response: {
          200: ADMIN_LIST_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const auth = authorizeAdmin(request, dependencies);
      if (!auth.ok) {
        return reply.code(auth.statusCode).send(errorBody(auth.code));
      }
      const status = parseStatusQuery(request.query);
      if (status === null) {
        return reply.code(400).send(errorBody("invalid_status"));
      }
      try {
        return reply
          .code(200)
          .send({ items: listDiagnosisRequests(dependencies.database, status) });
      } catch {
        return reply.code(503).send(errorBody("diagnosis_unavailable"));
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown; Reply: StatusBody | ErrorBody }>(
    "/api/admin/diagnosis/requests/:id",
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      errorHandler: diagnosisErrorHandler,
      schema: {
        response: {
          200: STATUS_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const auth = authorizeAdmin(request, dependencies);
      if (!auth.ok) {
        return reply.code(auth.statusCode).send(errorBody(auth.code));
      }
      if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
        return reply.code(403).send(errorBody("csrf_invalid"));
      }
      const requestId = parseRequestId(request.params.id);
      if (requestId === null) {
        return reply.code(404).send(errorBody("not_found"));
      }
      const classification = normalizeDiagnosisClassification(request.body);
      if (classification === null) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        classifyDiagnosisRequest(dependencies.database, {
          requestId,
          classification: classification.classification,
          adminNote: classification.adminNote,
          adminUserId: auth.admin.userId,
          adminEmail: auth.admin.email,
          now: dependencies.now,
        });
        return reply.code(200).send({ status: "ok" });
      } catch (error) {
        if (error instanceof DiagnosisDomainError) {
          return reply.code(error.statusCode).send(errorBody(error.code));
        }
        return reply.code(503).send(errorBody("diagnosis_unavailable"));
      }
    },
  );
}
