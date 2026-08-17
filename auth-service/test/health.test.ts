import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const VALID_ENVIRONMENT: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3101",
  DB_PATH: "/tmp/auth-service-test.sqlite",
};

test("loopback configuration is accepted", () => {
  assert.deepEqual(loadConfig(VALID_ENVIRONMENT), {
    host: "127.0.0.1",
    port: 3101,
    dbPath: "/tmp/auth-service-test.sqlite",
    nodeEnv: "test",
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

test("GET /health returns only the public health status", async (context) => {
  const app = buildApp();
  context.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.body, '{"status":"ok"}');
});
