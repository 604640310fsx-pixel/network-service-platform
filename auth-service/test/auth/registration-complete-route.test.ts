import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerRegistrationCompleteRoute } from "../../src/http/registration-routes.js";

const REGISTRATION_TOKEN = `v1.${Buffer.alloc(32, 0x41).toString("base64url")}`;
const HEADERS = {
  origin: "http://localhost:5173",
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
};

test("matching passwords continue to the injected complete operation", async () => {
  const app = Fastify({ logger: false });
  let calls = 0;
  registerRegistrationCompleteRoute(app, {
    nodeEnv: "test",
    completeRegistration: async () => {
      calls += 1;
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register/complete",
      headers: HEADERS,
      payload: {
        registrationToken: REGISTRATION_TOKEN,
        password: "matching-password",
        confirmPassword: "matching-password",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test("password mismatch returns frozen 422 before the complete operation", async () => {
  const app = Fastify({ logger: false });
  let calls = 0;
  registerRegistrationCompleteRoute(app, {
    nodeEnv: "test",
    completeRegistration: async () => {
      calls += 1;
      throw new Error("Argon2-backed operation must not run");
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register/complete",
      headers: HEADERS,
      payload: {
        registrationToken: REGISTRATION_TOKEN,
        password: "matching-password",
        confirmPassword: "different-password",
      },
    });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json(), {
      error: { code: "password_policy_violation" },
    });
    assert.equal(calls, 0);
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});
