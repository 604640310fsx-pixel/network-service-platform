import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { withAuthenticationDatabase } from "./helpers.js";

const REGISTRATION_TOKEN = `v1.${Buffer.alloc(32, 0x41).toString("base64url")}`;
const HEADERS = {
  origin: "http://localhost:5173",
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
};
const KEY_V1 = Buffer.alloc(32, 0x31).toString("base64");
const KEYRING = { version: 1, keys: { "1": KEY_V1 } };

test("matching passwords continue to the frozen registration lookup", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        tokenHmacKeyring: KEYRING,
        inviteHmacKeyring: KEYRING,
        mailPayloadEncKeyring: KEYRING,
        rateLimitKeyring: KEYRING,
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
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: { code: "invalid_or_expired" },
      });
    } finally {
      await app.close();
    }
  });
});

test("password mismatch returns frozen 422 before registration lookup", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        tokenHmacKeyring: KEYRING,
        inviteHmacKeyring: KEYRING,
        mailPayloadEncKeyring: KEYRING,
        rateLimitKeyring: KEYRING,
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
      assert.equal(response.headers["cache-control"], "no-store");
    } finally {
      await app.close();
    }
  });
});
