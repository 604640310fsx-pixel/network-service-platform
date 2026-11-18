import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const READINESS_FAILURE_SECRET = "must-not-appear-readiness-secret";

function assertReadinessResponse(
  response: Awaited<ReturnType<ReturnType<typeof buildApp>["inject"]>>,
  expected: "ready" | "not_ready",
): void {
  assert.equal(response.statusCode, expected === "ready" ? 200 : 503);
  assert.equal(response.body, `{"status":"${expected}"}`);
  assert.deepEqual(response.json(), { status: expected });
  assert.deepEqual(Object.keys(response.json()), ["status"]);
  assert.match(response.headers["content-type"] ?? "", /^application\/json\b/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.includes(READINESS_FAILURE_SECRET), false);
}

const VALID_ENVIRONMENT: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3101",
  DB_PATH: "/tmp/auth-service-test.sqlite",
  REGISTRATION_ENABLED: "false",
  PAYMENT_ENABLED: "false",
};

test("loopback configuration is accepted", () => {
  assert.deepEqual(loadConfig(VALID_ENVIRONMENT), {
    host: "127.0.0.1",
    port: 3101,
    dbPath: "/tmp/auth-service-test.sqlite",
    nodeEnv: "test",
    registrationEnabled: false,
    paymentEnabled: false,
    referralPublicLink: { enabled: false },
  });
});

test("non-loopback HOST is rejected", () => {
  assert.throws(
    () => loadConfig({ ...VALID_ENVIRONMENT, HOST: "0.0.0.0" }),
    /HOST must be exactly 127\.0\.0\.1/,
  );
});

test("missing production configuration is rejected", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3101",
      }),
    /DB_PATH is required/,
  );
});

test("registration feature flag is required and accepts only exact literals", () => {
  assert.throws(
    () => loadConfig({ ...VALID_ENVIRONMENT, REGISTRATION_ENABLED: undefined }),
    /REGISTRATION_ENABLED must be exactly true or false/,
  );
  assert.throws(
    () => loadConfig({ ...VALID_ENVIRONMENT, REGISTRATION_ENABLED: " true " }),
    /REGISTRATION_ENABLED must be exactly true or false/,
  );
  assert.equal(
    loadConfig({ ...VALID_ENVIRONMENT, REGISTRATION_ENABLED: "true" })
      .registrationEnabled,
    true,
  );
});

test("payment feature flag is required and accepts only exact literals", () => {
  assert.throws(
    () => loadConfig({ ...VALID_ENVIRONMENT, PAYMENT_ENABLED: undefined }),
    /PAYMENT_ENABLED must be exactly true or false/,
  );
  assert.throws(
    () => loadConfig({ ...VALID_ENVIRONMENT, PAYMENT_ENABLED: " true " }),
    /PAYMENT_ENABLED must be exactly true or false/,
  );
  assert.equal(
    loadConfig({ ...VALID_ENVIRONMENT, PAYMENT_ENABLED: "true" })
      .paymentEnabled,
    true,
  );
});

test("GET /health returns only the public health status", async (context) => {
  const app = buildApp();
  context.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.body, '{"status":"ok"}');
  assert.equal(response.headers["cache-control"], undefined);
});

test("GET /ready is exact, uncached, and fails closed for every dependency state", async (context) => {
  const cases = [
    { name: "absent", expected: "not_ready" as const },
    { name: "false", expected: "not_ready" as const, value: false },
    { name: "true", expected: "ready" as const, value: true },
    { name: "throw", expected: "not_ready" as const, throws: true },
  ];

  for (const scenario of cases) {
    let calls = 0;
    const app = buildApp({
      readiness:
        scenario.name === "absent"
          ? undefined
          : {
              isReady: (): boolean => {
                calls += 1;
                if (scenario.throws === true) {
                  throw new Error(READINESS_FAILURE_SECRET);
                }
                return scenario.value === true;
              },
            },
    });
    context.after(async () => app.close());

    const response = await app.inject({ method: "GET", url: "/ready" });
    assertReadinessResponse(response, scenario.expected);
    assert.equal(calls, scenario.name === "absent" ? 0 : 1, scenario.name);
  }
});

test("wrong /ready methods retain Fastify's route-not-found behavior", async (context) => {
  const app = buildApp({ readiness: { isReady: () => true } });
  context.after(async () => app.close());

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    const response = await app.inject({ method, url: "/ready" });
    assert.equal(response.statusCode, 404, method);
    assert.notEqual(response.statusCode, 405, method);
    assert.equal(response.headers["cache-control"], undefined, method);
  }
});

test("concurrent /ready requests make one synchronous predicate call each", async (context) => {
  let calls = 0;
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const app = buildApp({
    readiness: {
      isReady: (): boolean => {
        calls += 1;
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        try {
          return true;
        } finally {
          activeCalls -= 1;
        }
      },
    },
  });
  context.after(async () => app.close());

  const requestCount = 64;
  const responses = await Promise.all(
    Array.from({ length: requestCount }, () =>
      app.inject({ method: "GET", url: "/ready" }),
    ),
  );

  for (const response of responses) {
    assertReadinessResponse(response, "ready");
  }
  assert.equal(calls, requestCount);
  assert.equal(maximumActiveCalls, 1);
  assert.equal(activeCalls, 0);
});
