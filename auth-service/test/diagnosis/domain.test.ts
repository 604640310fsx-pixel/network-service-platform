import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDiagnosisRequest,
  createDiagnosisRequest,
  DiagnosisDomainError,
  listDiagnosisRequests,
  normalizeDiagnosisClassification,
  normalizeDiagnosisSubmission,
  parseProblemTypes,
  serializeProblemTypes,
  type DiagnosisSubmission,
} from "../../src/diagnosis/requests.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";

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
