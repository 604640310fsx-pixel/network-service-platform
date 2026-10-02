import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DiagnosisApiError,
  DiagnosisSubmissionAttemptManager,
  isCanonicalDiagnosisIdempotencyKey,
  submitDiagnosisRequest,
  type DiagnosisSubmission,
} from "../app/lib/diagnosis-api.ts";

function key(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence
    .toString(16)
    .padStart(12, "0")}`;
}

function submission(
  overrides: Partial<DiagnosisSubmission> = {},
): DiagnosisSubmission {
  return {
    contactType: "email",
    contactValue: "contact@example.test",
    businessScenario: "ai_development",
    targetRegion: "Example Region",
    problemTypes: ["access_failure"],
    problemDescription: "sanitized diagnosis details",
    safetyAcknowledged: true,
    ...overrides,
  };
}

test("accepts only canonical lowercase UUID v4 idempotency values", () => {
  assert.equal(isCanonicalDiagnosisIdempotencyKey(crypto.randomUUID()), true);
  const valid = key(1);
  assert.equal(isCanonicalDiagnosisIdempotencyKey(valid), true);
  for (const invalid of [
    key(10).toUpperCase(),
    ` ${valid}`,
    `${valid} `,
    `${valid},${valid}`,
    valid.replace("-4000-", "-5000-"),
    valid.replace("-8000-", "-7000-"),
    valid.replace(/.$/, "g"),
    valid.slice(1),
    [valid],
    undefined,
  ]) {
    assert.equal(isCanonicalDiagnosisIdempotencyKey(invalid), false);
  }
});

test("same normalized attempt survives retryable failures and changes with the body", () => {
  const manager = new DiagnosisSubmissionAttemptManager();
  let generated = 0;
  const generate = () => {
    generated += 1;
    return key(generated);
  };
  const original = submission();
  const first = manager.prepare(original, generate);

  for (const error of [
    new DiagnosisApiError("network_error"),
    new DiagnosisApiError("invalid_response", 200),
    new DiagnosisApiError("rate_limited", 429),
    new DiagnosisApiError("diagnosis_unavailable", 503),
    new DiagnosisApiError("request_failed", 400),
  ]) {
    manager.handleFailure(error);
    assert.ok(manager.prepare({ ...original }, generate) === first);
  }
  assert.equal(generated, 1);
  assert.equal(manager.hasPendingAttempt(), true);

  const changed = manager.prepare(
    submission({ targetRegion: "Different Region" }),
    generate,
  );
  assert.ok(changed !== first);
  assert.equal(generated, 2);
});

test("required and conflict failures discard the attempt; clear covers success and reset", () => {
  const manager = new DiagnosisSubmissionAttemptManager();
  let generated = 10;
  const generate = () => {
    generated += 1;
    return key(generated);
  };
  const body = submission();

  const first = manager.prepare(body, generate);
  manager.handleFailure(new DiagnosisApiError("idempotency_key_required", 400));
  assert.equal(manager.hasPendingAttempt(), false);
  const second = manager.prepare(body, generate);
  assert.ok(second !== first);

  manager.handleFailure(new DiagnosisApiError("idempotency_key_conflict", 409));
  assert.equal(manager.hasPendingAttempt(), false);
  const third = manager.prepare(body, generate);
  assert.ok(third !== second);

  manager.clear();
  assert.equal(manager.hasPendingAttempt(), false);
  const fourth = manager.prepare(body, generate);
  assert.ok(fourth !== third);
});

test("malformed generated UUID fails before fetch and leaves no attempt", async () => {
  const manager = new DiagnosisSubmissionAttemptManager();
  assert.throws(
    () => manager.prepare(submission(), () => "invalid"),
    (error: unknown) =>
      error instanceof DiagnosisApiError &&
      error.code === "idempotency_key_required",
  );
  assert.equal(manager.hasPendingAttempt(), false);

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(
      submitDiagnosisRequest(submission(), "invalid"),
      (error: unknown) =>
        error instanceof DiagnosisApiError &&
        error.code === "idempotency_key_required",
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submit sends one exact header without changing the request contract", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let capturedUrl: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url, init) => {
    calls += 1;
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const body = submission();
  const idempotencyKey = key(100);
  try {
    await submitDiagnosisRequest(body, idempotencyKey);
    assert.equal(calls, 1);
    assert.equal(capturedUrl, "/api/diagnosis/requests");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.credentials, "same-origin");
    assert.equal(capturedInit?.body, JSON.stringify(body));
    const headers = capturedInit?.headers as Record<string, string>;
    assert.deepEqual(Object.keys(headers).sort(), [
      "Accept",
      "Content-Type",
      "Idempotency-Key",
      "X-Requested-With",
    ]);
    assert.ok(headers["Idempotency-Key"] === idempotencyKey);
    assert.equal(headers["X-Requested-With"], "XMLHttpRequest");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DiagnosisPage keeps attempts in refs and never exposes or persists them", () => {
  const page = readFileSync(
    new URL("../app/components/diagnosis/DiagnosisPage.tsx", import.meta.url),
    "utf8",
  );
  const api = readFileSync(
    new URL("../app/lib/diagnosis-api.ts", import.meta.url),
    "utf8",
  );
  assert.match(page, /useRef<DiagnosisSubmissionAttemptManager/);
  assert.match(page, /submittingRef\.current \|\| submitting/);
  assert.match(page, /window\.crypto\.randomUUID\(\)/);
  assert.match(page, /attemptManager\.clear\(\);\n\s+setSubmitted\(true\)/);
  assert.match(page, /\(\) => \(\) => \{[\s\S]*attemptManager\.clear\(\);/);
  assert.match(page, /return messages\.idempotency;/);
  assert.match(readFileSync(new URL("../app/i18n/zh.ts", import.meta.url), "utf8"), /idempotency: "本次提交凭证已失效，请重新点击提交。"/);

  const combined = `${page}\n${api}`;
  assert.doesNotMatch(
    combined,
    /localStorage|sessionStorage|indexedDB|document\.cookie|console\./,
  );
  const jsx = page.slice(page.indexOf("  return ("));
  assert.doesNotMatch(jsx, /idempotencyKey/);
  assert.doesNotMatch(api, /`[^`]*\$\{idempotencyKey\}[^`]*`/);
});
