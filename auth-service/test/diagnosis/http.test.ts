import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDiagnosisRequest,
  createDiagnosisRequest,
  normalizeDiagnosisSubmission,
  type DiagnosisSubmission,
} from "../../src/diagnosis/requests.js";
import { withAuthenticationDatabase } from "../auth/helpers.js";
import {
  DIAGNOSIS_NOW,
  PUBLIC_HEADERS,
  createSession,
  diagnosisApp,
  firstNumber,
  publicBody,
} from "./helpers.js";

function submission(overrides: Record<string, unknown> = {}): DiagnosisSubmission {
  const value = normalizeDiagnosisSubmission(publicBody(overrides));
  if (value === null) {
    throw new Error("valid diagnosis fixture was rejected");
  }
  return value;
}

test("public POST accepts complete and required-only requests with a minimal response", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      const complete = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: PUBLIC_HEADERS,
        payload: publicBody({
          currentRegion: " Tokyo ",
          currentIsp: " Example ISP ",
          currentNetworkType: "home_broadband",
          problemFrequency: "frequent",
          isExistingCustomer: false,
          preferredContactWindow: " 09:00-12:00 ",
          extraNotes: " browser only ",
        }),
      });
      assert.equal(complete.statusCode, 200);
      assert.deepEqual(complete.json(), { status: "ok" });
      assert.deepEqual(Object.keys(complete.json()), ["status"]);
      assert.equal(complete.headers["cache-control"], "no-store");

      const requiredOnly = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: PUBLIC_HEADERS,
        payload: publicBody({ contactValue: "second-contact" }),
      });
      assert.equal(requiredOnly.statusCode, 200);
      assert.deepEqual(requiredOnly.json(), { status: "ok" });

      const rows = database
        .prepare(
          `SELECT contact_value, target_region, problem_description,
                  current_region, current_isp, current_network_type,
                  problem_frequency, is_existing_customer,
                  preferred_contact_window, extra_notes
           FROM diagnosis_requests ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0], {
        contact_value: "contact-value",
        target_region: "Japan",
        problem_description: "unstable platform access",
        current_region: "Tokyo",
        current_isp: "Example ISP",
        current_network_type: "home_broadband",
        problem_frequency: "frequent",
        is_existing_customer: 0,
        preferred_contact_window: "09:00-12:00",
        extra_notes: "browser only",
      });
      for (const value of Object.values(rows[1]!).slice(3)) {
        assert.equal(value, null);
      }
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM orders"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM payments"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM services"), 0);
    } finally {
      await app.close();
    }
  });
});

test("diagnosis remains available with payment disabled and registration absent", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: PUBLIC_HEADERS,
        payload: publicBody(),
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: "ok" });
    } finally {
      await app.close();
    }
  });
});

test("public POST enforces exact environment Origin, XHR, and JSON content type", async () => {
  await withAuthenticationDatabase(async (database) => {
    const development = diagnosisApp(database);
    const production = diagnosisApp(database, { nodeEnv: "production" });
    try {
      for (const headers of [
        {
          "content-type": "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
        { ...PUBLIC_HEADERS, origin: "https://wrong.example.test" },
      ]) {
        const response = await development.inject({
          method: "POST",
          url: "/api/diagnosis/requests",
          headers,
          payload: publicBody(),
        });
        assert.equal(response.statusCode, 400);
        assert.deepEqual(response.json(), { error: { code: "origin_rejected" } });
        assert.equal(response.headers["cache-control"], "no-store");
      }

      const missingXhr = await development.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: {
          origin: PUBLIC_HEADERS.origin,
          "content-type": "application/json",
        },
        payload: publicBody(),
      });
      assert.equal(missingXhr.statusCode, 400);
      assert.deepEqual(missingXhr.json(), { error: { code: "invalid_request" } });

      const wrongContentType = await development.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: {
          origin: PUBLIC_HEADERS.origin,
          "content-type": "text/plain",
          "x-requested-with": "XMLHttpRequest",
        },
        payload: JSON.stringify(publicBody()),
      });
      assert.equal(wrongContentType.statusCode, 400);
      assert.deepEqual(wrongContentType.json(), {
        error: { code: "invalid_request" },
      });

      const productionRejected = await production.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: PUBLIC_HEADERS,
        payload: publicBody(),
      });
      assert.equal(productionRejected.statusCode, 400);
      assert.deepEqual(productionRejected.json(), {
        error: { code: "origin_rejected" },
      });
      const productionAccepted = await production.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: {
          ...PUBLIC_HEADERS,
          origin: "https://www.siqiapparel.com",
        },
        payload: publicBody(),
      });
      assert.equal(productionAccepted.statusCode, 200);
    } finally {
      await development.close();
      await production.close();
    }
  });
});

test("public POST rejects unknown fields, nulls, enums, acknowledgement, arrays, and trimmed bounds", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      const invalidBodies = [
        publicBody({ unexpected: true }),
        publicBody({ safetyAcknowledged: false }),
        publicBody({ contactType: "phone" }),
        publicBody({ businessScenario: "invalid" }),
        publicBody({ currentNetworkType: "invalid" }),
        publicBody({ problemFrequency: "invalid" }),
        publicBody({ problemTypes: [] }),
        publicBody({ problemTypes: ["access_failure", "access_failure"] }),
        publicBody({
          problemTypes: [
            "access_failure",
            "performance_instability",
            "dns_ipv4_ipv6_udp_issue",
            "platform_environment_issue",
            "live_content_account_environment",
            "existing_network_suitability",
            "new_network_plan",
            "other_or_unsure",
            "unknown",
          ],
        }),
        publicBody({ problemTypes: ["unknown"] }),
        publicBody({ contactValue: "   " }),
        publicBody({ targetRegion: "   " }),
        publicBody({ problemDescription: " short " }),
        publicBody({ currentRegion: null }),
        publicBody({ currentIsp: "" }),
        publicBody({ preferredContactWindow: "   " }),
        publicBody({ extraNotes: null }),
      ];
      for (const payload of invalidBodies) {
        const response = await app.inject({
          method: "POST",
          url: "/api/diagnosis/requests",
          headers: PUBLIC_HEADERS,
          payload,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.deepEqual(response.json(), { error: { code: "invalid_request" } });
      }
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM rate_limit_buckets"), 0);
    } finally {
      await app.close();
    }
  });
});

test("public POST accepts every maximum boundary and rejects each overflow", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      const minimum = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: PUBLIC_HEADERS,
        payload: publicBody({
          contactValue: "x",
          targetRegion: "x",
          problemDescription: "x".repeat(10),
          currentRegion: "x",
          currentIsp: "x",
          preferredContactWindow: "x",
          extraNotes: "x",
        }),
      });
      assert.equal(minimum.statusCode, 200);

      const maximum = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: PUBLIC_HEADERS,
        payload: publicBody({
          contactValue: "x".repeat(200),
          targetRegion: "x".repeat(80),
          problemDescription: "x".repeat(2000),
          currentRegion: "x".repeat(80),
          currentIsp: "x".repeat(120),
          currentNetworkType: "other",
          problemFrequency: "unknown",
          isExistingCustomer: true,
          preferredContactWindow: "x".repeat(80),
          extraNotes: "x".repeat(1000),
        }),
      });
      assert.equal(maximum.statusCode, 200);

      for (const [field, value] of [
        ["contactValue", "x".repeat(201)],
        ["targetRegion", "x".repeat(81)],
        ["problemDescription", "x".repeat(2001)],
        ["currentRegion", "x".repeat(81)],
        ["currentIsp", "x".repeat(121)],
        ["preferredContactWindow", "x".repeat(81)],
        ["extraNotes", "x".repeat(1001)],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/api/diagnosis/requests",
          headers: PUBLIC_HEADERS,
          payload: publicBody({ [field]: value }),
        });
        assert.equal(response.statusCode, 400, field);
        assert.deepEqual(response.json(), { error: { code: "invalid_request" } });
      }
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 2);
    } finally {
      await app.close();
    }
  });
});

test("public POST rejects malformed JSON and bodies above 16 KiB without a write", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      for (const payload of [
        '{"contactType":',
        JSON.stringify(publicBody({ extraNotes: "x".repeat(17_000) })),
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/diagnosis/requests",
          headers: PUBLIC_HEADERS,
          payload,
        });
        assert.equal(response.statusCode, 400);
        assert.deepEqual(response.json(), { error: { code: "invalid_request" } });
        assert.equal(response.headers["cache-control"], "no-store");
      }
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 0);
    } finally {
      await app.close();
    }
  });
});

test("public rate limit permits five submissions, rejects the sixth, and isolates IPs", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      for (let count = 0; count < 5; count += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/diagnosis/requests",
          headers: { ...PUBLIC_HEADERS, "x-forwarded-for": "192.0.2.10" },
          payload: publicBody({ contactValue: `contact-${count}` }),
        });
        assert.equal(response.statusCode, 200);
      }
      const limited = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: { ...PUBLIC_HEADERS, "x-forwarded-for": "192.0.2.10" },
        payload: publicBody({ contactValue: "limited-contact" }),
      });
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json(), { error: { code: "rate_limited" } });
      const otherIp = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: { ...PUBLIC_HEADERS, "x-forwarded-for": "192.0.2.11" },
        payload: publicBody({ contactValue: "other-contact" }),
      });
      assert.equal(otherIp.statusCode, 200);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 6);

      const buckets = JSON.stringify(
        database.prepare("SELECT * FROM rate_limit_buckets").all(),
      );
      assert.doesNotMatch(buckets, /192\.0\.2\./);
      const diagnosisColumns = database.prepare("PRAGMA table_info(diagnosis_requests)").all() as Array<{
        readonly name: string;
      }>;
      assert.equal(
        diagnosisColumns.some((column) => /(^|_)ip($|_)/i.test(column.name)),
        false,
      );
    } finally {
      await app.close();
    }
  });
});

test("IPv4-mapped IPv6 and canonical IPv4 share the diagnosis limit", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      for (let count = 0; count < 5; count += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/diagnosis/requests",
          headers: { ...PUBLIC_HEADERS, "x-forwarded-for": "192.0.2.30" },
          payload: publicBody({ contactValue: `mapped-${count}` }),
        });
        assert.equal(response.statusCode, 200);
      }
      const response = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: { ...PUBLIC_HEADERS, "x-forwarded-for": "::ffff:192.0.2.30" },
        payload: publicBody({ contactValue: "mapped-limit" }),
      });
      assert.equal(response.statusCode, 429);
      assert.deepEqual(response.json(), { error: { code: "rate_limited" } });
    } finally {
      await app.close();
    }
  });
});

test("public insert failure returns fail-closed 503 without echo or partial diagnosis data", async () => {
  await withAuthenticationDatabase(async (database) => {
    database.exec(`
      CREATE TRIGGER reject_diagnosis_insert
      BEFORE INSERT ON diagnosis_requests
      BEGIN
        SELECT RAISE(ABORT, 'insert failure');
      END;
    `);
    const app = diagnosisApp(database);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/diagnosis/requests",
        headers: PUBLIC_HEADERS,
        payload: publicBody({ contactValue: "private-contact-value" }),
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        error: { code: "diagnosis_unavailable" },
      });
      assert.doesNotMatch(response.body, /private-contact-value/);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM rate_limit_buckets"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM orders"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM payments"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM services"), 0);
    } finally {
      await app.close();
    }
  });
});

test("there is no public diagnosis GET endpoint", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = diagnosisApp(database);
    try {
      const response = await app.inject({ method: "GET", url: "/api/diagnosis/requests" });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

test("admin GET reuses Session and role checks, defaults to new, and returns exact fields", async () => {
  await withAuthenticationDatabase(async (database) => {
    const user = createSession(database, "user", "user@example.test");
    const admin = createSession(database, "admin", "admin@example.test");
    createDiagnosisRequest(database, submission(), () => new Date(DIAGNOSIS_NOW));
    const app = diagnosisApp(database);
    try {
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests",
      });
      assert.equal(unauthenticated.statusCode, 401);
      assert.deepEqual(unauthenticated.json(), { error: { code: "unauthorized" } });
      const forbidden = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests",
        headers: { cookie: user.cookie },
      });
      assert.equal(forbidden.statusCode, 403);
      assert.deepEqual(forbidden.json(), { error: { code: "forbidden" } });

      const explicit = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests?status=new",
        headers: { cookie: admin.cookie },
      });
      const defaulted = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests",
        headers: { cookie: admin.cookie },
      });
      assert.equal(explicit.statusCode, 200);
      assert.equal(defaulted.statusCode, 200);
      assert.deepEqual(defaulted.json(), explicit.json());
      assert.equal(defaulted.headers["cache-control"], "no-store");
      const item = (defaulted.json() as { items: Array<Record<string, unknown>> }).items[0]!;
      assert.deepEqual(Object.keys(item).sort(), [
        "adminNote",
        "businessScenario",
        "classification",
        "contactType",
        "contactValue",
        "createdAt",
        "currentIsp",
        "currentNetworkType",
        "currentRegion",
        "extraNotes",
        "handledAt",
        "id",
        "isExistingCustomer",
        "preferredContactWindow",
        "problemDescription",
        "problemFrequency",
        "problemTypes",
        "status",
        "targetRegion",
      ]);
      assert.equal("safetyAck" in item, false);
      assert.equal("handledByAdminId" in item, false);

      const invalid = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests?status=unknown",
        headers: { cookie: admin.cookie },
      });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(invalid.json(), { error: { code: "invalid_status" } });
    } finally {
      await app.close();
    }
  });
});

test("admin GET returns handled items and fails the whole response on corrupt data", async () => {
  await withAuthenticationDatabase(async (database) => {
    const admin = createSession(database, "admin", "admin@example.test");
    createDiagnosisRequest(database, submission(), () => new Date(DIAGNOSIS_NOW));
    const requestId = firstNumber(database, "SELECT id FROM diagnosis_requests");
    classifyDiagnosisRequest(database, {
      requestId,
      classification: "formal_diagnosis",
      adminNote: null,
      adminUserId: admin.userId,
      adminEmail: "admin@example.test",
      now: () => new Date(DIAGNOSIS_NOW.getTime() + 1000),
    });
    const app = diagnosisApp(database);
    try {
      const handled = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests?status=handled",
        headers: { cookie: admin.cookie },
      });
      assert.equal(handled.statusCode, 200);
      assert.equal((handled.json() as { items: unknown[] }).items.length, 1);

      database.pragma("ignore_check_constraints = ON");
      database.prepare("UPDATE diagnosis_requests SET problem_types = 'not-json'").run();
      const corrupt = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests?status=handled",
        headers: { cookie: admin.cookie },
      });
      assert.equal(corrupt.statusCode, 503);
      assert.deepEqual(corrupt.json(), {
        error: { code: "diagnosis_unavailable" },
      });
      assert.equal(corrupt.body.includes("contact-value"), false);

      database
        .prepare("UPDATE diagnosis_requests SET problem_types = ?, handled_at = ?")
        .run('["platform_environment_issue"]', "2026-08-21 00:00:01");
      const corruptTime = await app.inject({
        method: "GET",
        url: "/api/admin/diagnosis/requests?status=handled",
        headers: { cookie: admin.cookie },
      });
      assert.equal(corruptTime.statusCode, 503);
      assert.deepEqual(corruptTime.json(), {
        error: { code: "diagnosis_unavailable" },
      });
    } finally {
      await app.close();
    }
  });
});

test("admin PATCH enforces Session, role, CSRF, id, and body validation", async () => {
  await withAuthenticationDatabase(async (database) => {
    const user = createSession(database, "user", "user@example.test");
    const admin = createSession(database, "admin", "admin@example.test");
    createDiagnosisRequest(database, submission(), () => new Date(DIAGNOSIS_NOW));
    const requestId = firstNumber(database, "SELECT id FROM diagnosis_requests");
    const app = diagnosisApp(database);
    const url = `/api/admin/diagnosis/requests/${requestId}`;
    try {
      const unauthenticated = await app.inject({
        method: "PATCH",
        url,
        payload: { classification: "formal_diagnosis" },
      });
      assert.equal(unauthenticated.statusCode, 401);
      const forbidden = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie: user.cookie },
        payload: { classification: "formal_diagnosis" },
      });
      assert.equal(forbidden.statusCode, 403);

      for (const csrf of [undefined, "x".repeat(43)]) {
        const headers: Record<string, string> = { cookie: admin.cookie };
        if (csrf !== undefined) {
          headers["x-csrf-token"] = csrf;
        }
        const response = await app.inject({
          method: "PATCH",
          url,
          headers,
          payload: { classification: "formal_diagnosis" },
        });
        assert.equal(response.statusCode, 403);
        assert.deepEqual(response.json(), { error: { code: "csrf_invalid" } });
      }

      for (const invalidId of ["0", "-1", "abc", "9007199254740992"]) {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/admin/diagnosis/requests/${invalidId}`,
          headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
          payload: { classification: "formal_diagnosis" },
        });
        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.json(), { error: { code: "not_found" } });
      }
      const missing = await app.inject({
        method: "PATCH",
        url: "/api/admin/diagnosis/requests/999999",
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { classification: "formal_diagnosis" },
      });
      assert.equal(missing.statusCode, 404);

      for (const payload of [
        {},
        { classification: "unknown" },
        { classification: "formal_diagnosis", adminNote: "" },
        { classification: "formal_diagnosis", adminNote: "   " },
        { classification: "formal_diagnosis", adminNote: null },
        { classification: "formal_diagnosis", adminNote: "x".repeat(501) },
        { classification: "formal_diagnosis", unexpected: true },
      ]) {
        const response = await app.inject({
          method: "PATCH",
          url,
          headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
          payload,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.deepEqual(response.json(), { error: { code: "invalid_request" } });
      }
      assert.equal(responseStatus(database, requestId), "new");
    } finally {
      await app.close();
    }
  });
});

function responseStatus(database: Parameters<typeof firstNumber>[0], id: number): string {
  const row = database
    .prepare("SELECT status FROM diagnosis_requests WHERE id = ?")
    .all(id)[0] as { readonly status: string };
  return row.status;
}

test("admin PATCH handles once and writes complete state plus a PII-free audit entry", async () => {
  await withAuthenticationDatabase(async (database) => {
    const admin = createSession(database, "admin", "admin@example.test");
    createDiagnosisRequest(
      database,
      submission({
        contactValue: "private-contact",
        problemDescription: "private problem detail",
        extraNotes: "private extra note",
      }),
      () => new Date(DIAGNOSIS_NOW),
    );
    const requestId = firstNumber(database, "SELECT id FROM diagnosis_requests");
    const app = diagnosisApp(database);
    const url = `/api/admin/diagnosis/requests/${requestId}`;
    try {
      const response = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: {
          classification: "formal_diagnosis",
          adminNote: " follow up privately ",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: "ok" });
      assert.equal(response.headers["cache-control"], "no-store");
      const row = database
        .prepare(
          `SELECT status, classification, admin_note, handled_by_admin_id,
                  handled_at, updated_at FROM diagnosis_requests WHERE id = ?`,
        )
        .all(requestId)[0];
      assert.deepEqual(row, {
        status: "handled",
        classification: "formal_diagnosis",
        admin_note: "follow up privately",
        handled_by_admin_id: admin.userId,
        handled_at: DIAGNOSIS_NOW.toISOString(),
        updated_at: DIAGNOSIS_NOW.toISOString(),
      });
      const audit = database
        .prepare("SELECT actor, action, target_ref, created_at FROM audit_log")
        .all()[0];
      assert.deepEqual(audit, {
        actor: "admin@example.test",
        action: "diagnosis.classify",
        target_ref: `diagnosis_request:${requestId}`,
        created_at: DIAGNOSIS_NOW.toISOString(),
      });
      const auditText = JSON.stringify(audit);
      for (const forbidden of [
        "private-contact",
        "private problem detail",
        "private extra note",
        "follow up privately",
      ]) {
        assert.equal(auditText.includes(forbidden), false);
      }

      const repeated = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { classification: "out_of_scope" },
      });
      assert.equal(repeated.statusCode, 409);
      assert.deepEqual(repeated.json(), {
        error: { code: "invalid_transition" },
      });
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 1);
    } finally {
      await app.close();
    }
  });
});

test("admin PATCH rolls back classification when the audit insert fails", async () => {
  await withAuthenticationDatabase(async (database) => {
    const admin = createSession(database, "admin", "admin@example.test");
    createDiagnosisRequest(database, submission(), () => new Date(DIAGNOSIS_NOW));
    const requestId = firstNumber(database, "SELECT id FROM diagnosis_requests");
    database.exec(`
      CREATE TRIGGER fail_diagnosis_audit_http
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'diagnosis.classify'
      BEGIN
        SELECT RAISE(ABORT, 'audit failure');
      END;
    `);
    const app = diagnosisApp(database);
    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/admin/diagnosis/requests/${requestId}`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { classification: "formal_diagnosis" },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        error: { code: "diagnosis_unavailable" },
      });
      assert.equal(responseStatus(database, requestId), "new");
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 0);
    } finally {
      await app.close();
    }
  });
});

test("concurrent admin PATCH attempts allow at most one classification", async () => {
  await withAuthenticationDatabase(async (database) => {
    const admin = createSession(database, "admin", "admin@example.test");
    createDiagnosisRequest(database, submission(), () => new Date(DIAGNOSIS_NOW));
    const requestId = firstNumber(database, "SELECT id FROM diagnosis_requests");
    const app = diagnosisApp(database);
    const request = (classification: "network_plan" | "out_of_scope") =>
      app.inject({
        method: "PATCH",
        url: `/api/admin/diagnosis/requests/${requestId}`,
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        payload: { classification },
      });
    try {
      const responses = await Promise.all([request("network_plan"), request("out_of_scope")]);
      assert.deepEqual(
        responses.map((response) => response.statusCode).sort(),
        [200, 409],
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 1);
    } finally {
      await app.close();
    }
  });
});
