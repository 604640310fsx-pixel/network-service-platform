import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDiagnosisRequest,
  createDiagnosisRequest,
  createIdempotentDiagnosisRequestInTransaction,
  DiagnosisDomainError,
  DiagnosisIdempotencyConflictError,
  listDiagnosisRequests,
  normalizeDiagnosisClassification,
  normalizeDiagnosisSubmission,
  parseProblemTypes,
  serializeProblemTypes,
  type DiagnosisSubmission,
} from "../../src/diagnosis/requests.js";
import type { DatabaseConnection } from "../../src/db.js";
import {
  RateLimitExceededError,
  withDiagnosisSubmitRateLimit,
} from "../../src/http/rate-limit.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import {
  RATE_LIMIT_KEYRING,
  diagnosisIdempotencyKey,
  firstNumber,
} from "./helpers.js";

const NOW = new Date("2026-08-28T08:00:00.000Z");

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contactType: "wechat",
    contactValue: " contact-value ",
    businessScenario: "tiktok_content",
    targetRegion: " Japan ",
    problemTypes: ["platform_environment_issue"],
    problemDescription: " unstable platform access ",
    safetyAcknowledged: true,
    ...overrides,
  };
}

function normalizedRequest(overrides: Record<string, unknown> = {}): DiagnosisSubmission {
  const result = normalizeDiagnosisSubmission(validRequest(overrides));
  if (result === null) {
    throw new Error("valid diagnosis fixture was rejected");
  }
  return result;
}

function submitIdempotently(
  database: DatabaseConnection,
  keySequence: number,
  request: DiagnosisSubmission,
  options: {
    readonly ip?: string;
    readonly now?: () => Date;
  } = {},
) {
  const now = options.now ?? (() => new Date(NOW));
  return withDiagnosisSubmitRateLimit(
    database,
    RATE_LIMIT_KEYRING,
    options.ip ?? "192.0.2.40",
    (consumeRateLimit) =>
      createIdempotentDiagnosisRequestInTransaction(
        database,
        diagnosisIdempotencyKey(keySequence),
        request,
        consumeRateLimit,
        now,
      ),
    { now },
  );
}

function diagnosisRateCount(database: DatabaseConnection): number {
  return firstNumber(
    database,
    "SELECT COALESCE(SUM(count), 0) FROM rate_limit_buckets",
  );
}

test("normalizes required and optional diagnosis input without accepting unknown fields", () => {
  assert.deepEqual(
    normalizeDiagnosisSubmission(
      validRequest({
        currentRegion: " Tokyo ",
        currentIsp: " Example ISP ",
        currentNetworkType: "home_broadband",
        problemFrequency: "frequent",
        isExistingCustomer: false,
        preferredContactWindow: " 09:00-12:00 ",
        extraNotes: " browser only ",
      }),
    ),
    {
      contactType: "wechat",
      contactValue: "contact-value",
      businessScenario: "tiktok_content",
      targetRegion: "Japan",
      problemTypes: ["platform_environment_issue"],
      problemDescription: "unstable platform access",
      currentRegion: "Tokyo",
      currentIsp: "Example ISP",
      currentNetworkType: "home_broadband",
      problemFrequency: "frequent",
      isExistingCustomer: false,
      preferredContactWindow: "09:00-12:00",
      extraNotes: "browser only",
    },
  );
  assert.equal(normalizeDiagnosisSubmission(validRequest({ unexpected: true })), null);
  assert.equal(normalizeDiagnosisSubmission(validRequest({ currentRegion: null })), null);
  assert.equal(normalizeDiagnosisSubmission(validRequest({ extraNotes: "   " })), null);
});

test("enforces diagnosis enums, acknowledgement, lengths, and problem type uniqueness", () => {
  for (const [field, value] of [
    ["contactType", "phone"],
    ["businessScenario", "unknown-scenario"],
    ["currentNetworkType", "mobile"],
    ["problemFrequency", "daily"],
  ] as const) {
    assert.equal(normalizeDiagnosisSubmission(validRequest({ [field]: value })), null);
  }
  assert.equal(normalizeDiagnosisSubmission(validRequest({ safetyAcknowledged: false })), null);
  assert.equal(normalizeDiagnosisSubmission(validRequest({ problemTypes: [] })), null);
  assert.equal(
    normalizeDiagnosisSubmission(
      validRequest({ problemTypes: ["access_failure", "access_failure"] }),
    ),
    null,
  );
  assert.equal(
    normalizeDiagnosisSubmission(
      validRequest({ problemTypes: Array.from({ length: 9 }, (_, index) => `value-${index}`) }),
    ),
    null,
  );
  assert.equal(
    normalizeDiagnosisSubmission(validRequest({ problemTypes: ["unknown_problem"] })),
    null,
  );
  assert.equal(normalizeDiagnosisSubmission(validRequest({ contactValue: " ".repeat(3) })), null);
  assert.notEqual(
    normalizeDiagnosisSubmission(
      validRequest({
        contactValue: "x".repeat(200),
        targetRegion: "x".repeat(80),
        problemDescription: "x".repeat(2000),
        currentRegion: "x".repeat(80),
        currentIsp: "x".repeat(120),
        preferredContactWindow: "x".repeat(80),
        extraNotes: "x".repeat(1000),
      }),
    ),
    null,
  );
  for (const [field, value] of [
    ["contactValue", "x".repeat(201)],
    ["targetRegion", "x".repeat(81)],
    ["problemDescription", "x".repeat(2001)],
    ["currentRegion", "x".repeat(81)],
    ["currentIsp", "x".repeat(121)],
    ["preferredContactWindow", "x".repeat(81)],
    ["extraNotes", "x".repeat(1001)],
  ] as const) {
    assert.equal(normalizeDiagnosisSubmission(validRequest({ [field]: value })), null);
  }
});

test("problem types use strict canonical JSON round trips and reject corrupted storage", () => {
  const values = ["access_failure", "new_network_plan"] as const;
  const stored = serializeProblemTypes(values);
  assert.equal(stored, '["access_failure","new_network_plan"]');
  assert.deepEqual(parseProblemTypes(stored), values);
  for (const invalid of [
    "not-json",
    "{}",
    "[]",
    '["access_failure","access_failure"]',
    '["unknown_problem"]',
    JSON.stringify([...values, ...values, ...values, ...values, "other_or_unsure"]),
  ]) {
    assert.throws(() => parseProblemTypes(invalid), /database invariant/);
  }
});

test("persists trimmed diagnosis data with omitted optionals as NULL and lists strict output", async () => {
  await withAuthenticationDatabase((database) => {
    createDiagnosisRequest(database, normalizedRequest(), () => new Date(NOW));
    const stored = database.prepare("SELECT * FROM diagnosis_requests").all()[0] as Record<
      string,
      unknown
    >;
    assert.equal(stored.contact_value, "contact-value");
    assert.equal(stored.target_region, "Japan");
    assert.equal(stored.problem_description, "unstable platform access");
    assert.equal(stored.safety_ack, 1);
    for (const field of [
      "current_region",
      "current_isp",
      "current_network_type",
      "problem_frequency",
      "is_existing_customer",
      "preferred_contact_window",
      "extra_notes",
    ]) {
      assert.equal(stored[field], null);
    }
    const listed = listDiagnosisRequests(database, "new");
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]?.problemTypes, ["platform_environment_issue"]);
    assert.equal(listed[0]?.createdAt, NOW.toISOString());
  });
});

test("creates once and replays the same normalized diagnosis without consuming quota", async () => {
  await withAuthenticationDatabase((database) => {
    const request = normalizedRequest({
      currentRegion: " Tokyo ",
      isExistingCustomer: false,
    });
    assert.equal(submitIdempotently(database, 1, request), "created");
    for (let delivery = 0; delivery < 6; delivery += 1) {
      assert.equal(submitIdempotently(database, 1, request), "replayed");
    }

    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 1);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      1,
    );
    assert.equal(diagnosisRateCount(database), 1);
    assert.deepEqual(
      database
        .prepare(
          `SELECT mapping.created_at AS mapping_created_at,
                  request.created_at AS request_created_at
           FROM diagnosis_request_idempotency AS mapping
           JOIN diagnosis_requests AS request
             ON request.id = mapping.diagnosis_request_id`,
        )
        .all(),
      [
        {
          mapping_created_at: NOW.toISOString(),
          request_created_at: NOW.toISOString(),
        },
      ],
    );
  });
});

test("rejects a different normalized diagnosis for the same key without a write", async () => {
  await withAuthenticationDatabase((database) => {
    assert.equal(
      submitIdempotently(database, 2, normalizedRequest()),
      "created",
    );
    assert.throws(
      () =>
        submitIdempotently(
          database,
          2,
          normalizedRequest({ targetRegion: "Singapore" }),
        ),
      (error: unknown) => error instanceof DiagnosisIdempotencyConflictError,
    );
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 1);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      1,
    );
    assert.equal(diagnosisRateCount(database), 1);
  });
});

test("Promise.all same-body submissions converge on one request and one quota unit", async () => {
  await withAuthenticationDatabase(async (database) => {
    const request = normalizedRequest();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        Promise.resolve().then(() => submitIdempotently(database, 3, request)),
      ),
    );
    assert.equal(results.filter((result) => result === "created").length, 1);
    assert.equal(results.filter((result) => result === "replayed").length, 5);
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 1);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      1,
    );
    assert.equal(diagnosisRateCount(database), 1);
  });
});

test("Promise.all different-body submissions allow one body and reject the other", async () => {
  await withAuthenticationDatabase(async (database) => {
    const settled = await Promise.allSettled([
      Promise.resolve().then(() =>
        submitIdempotently(
          database,
          4,
          normalizedRequest({ targetRegion: "Example A" }),
        ),
      ),
      Promise.resolve().then(() =>
        submitIdempotently(
          database,
          4,
          normalizedRequest({ targetRegion: "Example B" }),
        ),
      ),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
    const rejected = settled.find((result) => result.status === "rejected");
    assert.ok(
      rejected?.status === "rejected" &&
        rejected.reason instanceof DiagnosisIdempotencyConflictError,
    );
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 1);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      1,
    );
    assert.equal(diagnosisRateCount(database), 1);
  });
});

test("replay bypasses a full bucket while a sixth distinct key remains limited", async () => {
  await withAuthenticationDatabase((database) => {
    const first = normalizedRequest({ contactValue: "contact-0" });
    assert.equal(submitIdempotently(database, 10, first), "created");
    for (let count = 1; count < 5; count += 1) {
      assert.equal(
        submitIdempotently(
          database,
          10 + count,
          normalizedRequest({ contactValue: `contact-${count}` }),
        ),
        "created",
      );
    }
    assert.equal(diagnosisRateCount(database), 5);
    assert.equal(submitIdempotently(database, 10, first), "replayed");
    assert.equal(diagnosisRateCount(database), 5);
    assert.throws(
      () =>
        submitIdempotently(
          database,
          15,
          normalizedRequest({ contactValue: "contact-5" }),
        ),
      (error: unknown) => error instanceof RateLimitExceededError,
    );
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 5);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      5,
    );
    assert.equal(diagnosisRateCount(database), 5);
  });
});

test("rate, diagnosis, mapping, and timestamp failures roll the transaction back", async () => {
  const scenarios = [
    `CREATE TRIGGER fail_diagnosis_rate_increment
     BEFORE INSERT ON rate_limit_buckets
     BEGIN SELECT RAISE(ABORT, 'rate failure'); END;`,
    `CREATE TRIGGER fail_diagnosis_request_insert
     BEFORE INSERT ON diagnosis_requests
     BEGIN SELECT RAISE(ABORT, 'request failure'); END;`,
    `CREATE TRIGGER fail_diagnosis_mapping_insert
     BEFORE INSERT ON diagnosis_request_idempotency
     BEGIN SELECT RAISE(ABORT, 'mapping failure'); END;`,
  ];

  for (const [index, trigger] of scenarios.entries()) {
    await withAuthenticationDatabase((database) => {
      database.exec(trigger);
      assert.throws(() =>
        submitIdempotently(database, 20 + index, normalizedRequest()),
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 0);
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM diagnosis_request_idempotency",
        ),
        0,
      );
      assert.equal(diagnosisRateCount(database), 0);
    });
  }

  await withAuthenticationDatabase((database) => {
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls === 1 ? new Date(NOW) : new Date(Number.NaN);
    };
    assert.throws(
      () => submitIdempotently(database, 30, normalizedRequest(), { now }),
      /time source is invalid/,
    );
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 0);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      0,
    );
    assert.equal(diagnosisRateCount(database), 0);
  });
});

test("corrupt mapping, linked row, and orphaned mapping fail closed before quota", async () => {
  await withAuthenticationDatabase((database) => {
    const request = normalizedRequest();
    submitIdempotently(database, 40, request);
    database
      .prepare("UPDATE diagnosis_request_idempotency SET created_at = ?")
      .run("2026-08-28 08:00:00");
    assert.throws(
      () => submitIdempotently(database, 40, request),
      /database invariant/,
    );
    assert.equal(diagnosisRateCount(database), 1);
  });

  await withAuthenticationDatabase((database) => {
    const request = normalizedRequest();
    submitIdempotently(database, 41, request);
    database.pragma("ignore_check_constraints = ON");
    database
      .prepare("UPDATE diagnosis_requests SET problem_types = 'not-json'")
      .run();
    assert.throws(
      () => submitIdempotently(database, 41, request),
      /database invariant/,
    );
    assert.equal(diagnosisRateCount(database), 1);
  });

  await withAuthenticationDatabase((database) => {
    const request = normalizedRequest();
    submitIdempotently(database, 42, request);
    database.pragma("foreign_keys = OFF");
    database
      .prepare(
        "UPDATE diagnosis_request_idempotency SET diagnosis_request_id = 999999",
      )
      .run();
    assert.throws(
      () => submitIdempotently(database, 42, request),
      /database invariant/,
    );
    assert.equal(diagnosisRateCount(database), 1);
  });
});

test("lists new oldest first, handled newest first, and caps results at 100", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    for (let index = 0; index < 102; index += 1) {
      createDiagnosisRequest(
        database,
        normalizedRequest({ contactValue: `contact-${index}` }),
        () => new Date(NOW.getTime() + index * 1000),
      );
    }
    const pending = listDiagnosisRequests(database, "new");
    assert.equal(pending.length, 100);
    assert.equal(pending[0]?.contactValue, "contact-0");
    assert.equal(pending[99]?.contactValue, "contact-99");

    classifyDiagnosisRequest(database, {
      requestId: pending[0]!.id,
      classification: "continue_as_is",
      adminNote: null,
      adminUserId: adminId,
      adminEmail: "admin@example.test",
      now: () => new Date(NOW.getTime() + 200_000),
    });
    classifyDiagnosisRequest(database, {
      requestId: pending[1]!.id,
      classification: "need_more_info",
      adminNote: "follow up",
      adminUserId: adminId,
      adminEmail: "admin@example.test",
      now: () => new Date(NOW.getTime() + 201_000),
    });
    const handled = listDiagnosisRequests(database, "handled");
    assert.deepEqual(
      handled.map((item) => item.contactValue),
      ["contact-1", "contact-0"],
    );
  });
});

test("fails the whole admin list on corrupted problem JSON or non-canonical time", async () => {
  await withAuthenticationDatabase((database) => {
    createDiagnosisRequest(database, normalizedRequest(), () => new Date(NOW));
    database.pragma("ignore_check_constraints = ON");
    database.prepare("UPDATE diagnosis_requests SET problem_types = 'not-json'").run();
    assert.throws(() => listDiagnosisRequests(database, "new"), /database invariant/);
    database
      .prepare("UPDATE diagnosis_requests SET problem_types = ?, created_at = ?")
      .run('["access_failure"]', "2026-08-28 08:00:00");
    assert.throws(() => listDiagnosisRequests(database, "new"), /database invariant/);
  });
});

test("normalizes classification input and rejects empty, null, long, or extra values", () => {
  assert.deepEqual(
    normalizeDiagnosisClassification({
      classification: "formal_diagnosis",
      adminNote: " follow up ",
    }),
    { classification: "formal_diagnosis", adminNote: "follow up" },
  );
  assert.deepEqual(normalizeDiagnosisClassification({ classification: "network_plan" }), {
    classification: "network_plan",
    adminNote: null,
  });
  for (const value of [
    { classification: "unknown" },
    { classification: "network_plan", adminNote: "" },
    { classification: "network_plan", adminNote: null },
    { classification: "network_plan", adminNote: "x".repeat(501) },
    { classification: "network_plan", extra: true },
  ]) {
    assert.equal(normalizeDiagnosisClassification(value), null);
  }
});

test("classifies once and writes a PII-free audit row atomically", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createDiagnosisRequest(
      database,
      normalizedRequest({
        contactValue: "sensitive-contact",
        problemDescription: "sensitive problem detail",
        extraNotes: "sensitive extra note",
      }),
      () => new Date(NOW),
    );
    const id = (database.prepare("SELECT id FROM diagnosis_requests").all()[0] as { id: number }).id;
    classifyDiagnosisRequest(database, {
      requestId: id,
      classification: "formal_diagnosis",
      adminNote: "sensitive admin note",
      adminUserId: adminId,
      adminEmail: "admin@example.test",
      now: () => new Date(NOW.getTime() + 1000),
    });
    const stored = database
      .prepare(
        `SELECT status, classification, admin_note, handled_by_admin_id,
                handled_at, updated_at FROM diagnosis_requests WHERE id = ?`,
      )
      .all(id)[0] as Record<string, unknown>;
    assert.deepEqual(stored, {
      status: "handled",
      classification: "formal_diagnosis",
      admin_note: "sensitive admin note",
      handled_by_admin_id: adminId,
      handled_at: "2026-08-28T08:00:01.000Z",
      updated_at: "2026-08-28T08:00:01.000Z",
    });
    const audit = database.prepare("SELECT actor, action, target_ref FROM audit_log").all()[0];
    assert.deepEqual(audit, {
      actor: "admin@example.test",
      action: "diagnosis.classify",
      target_ref: `diagnosis_request:${id}`,
    });
    assert.doesNotMatch(JSON.stringify(audit), /sensitive/);
    assert.throws(
      () =>
        classifyDiagnosisRequest(database, {
          requestId: id,
          classification: "out_of_scope",
          adminNote: null,
          adminUserId: adminId,
          adminEmail: "admin@example.test",
        }),
      (error: unknown) =>
        error instanceof DiagnosisDomainError && error.code === "invalid_transition",
    );
  });
});

test("rolls classification back when audit insertion fails", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    createDiagnosisRequest(database, normalizedRequest(), () => new Date(NOW));
    const id = (database.prepare("SELECT id FROM diagnosis_requests").all()[0] as { id: number }).id;
    database.exec(`
      CREATE TRIGGER fail_diagnosis_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'diagnosis.classify'
      BEGIN
        SELECT RAISE(ABORT, 'audit failure');
      END;
    `);
    assert.throws(() =>
      classifyDiagnosisRequest(database, {
        requestId: id,
        classification: "formal_diagnosis",
        adminNote: null,
        adminUserId: adminId,
        adminEmail: "admin@example.test",
      }),
    );
    const stored = database
      .prepare("SELECT status, classification, handled_at FROM diagnosis_requests WHERE id = ?")
      .all(id)[0];
    assert.deepEqual(stored, { status: "new", classification: null, handled_at: null });
    const auditCount = database.prepare("SELECT COUNT(*) AS count FROM audit_log").all()[0] as {
      readonly count: number;
    };
    assert.equal(auditCount.count, 0);
  });
});
