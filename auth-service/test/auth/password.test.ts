import assert from "node:assert/strict";
import test from "node:test";

import { argon2Gate } from "../../src/auth/argon2-gate.js";
import {
  ARGON2_PARAMETERS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPasswordHash,
} from "../../src/auth/password.js";
import {
  assertLoginPassword,
  assertRegistrationPassword,
  PasswordPolicyError,
} from "../../src/auth/password-policy.js";

test("uses JavaScript UTF-16 code units for frozen password boundaries", () => {
  assert.throws(
    () => assertRegistrationPassword(`${"a".repeat(9)}🔐`),
    PasswordPolicyError,
  );
  assert.doesNotThrow(() =>
    assertRegistrationPassword(`${"a".repeat(10)}🔐`),
  );
  assert.doesNotThrow(() => assertRegistrationPassword("a".repeat(256)));
  assert.throws(
    () => assertRegistrationPassword("a".repeat(257)),
    PasswordPolicyError,
  );

  assert.throws(() => assertLoginPassword(""), PasswordPolicyError);
  assert.doesNotThrow(() => assertLoginPassword("a"));
  assert.doesNotThrow(() => assertLoginPassword("a".repeat(256)));
  assert.throws(
    () => assertLoginPassword("a".repeat(257)),
    PasswordPolicyError,
  );
});

test("hashes and verifies Unicode without normalization or trimming", async () => {
  const composed = "é".repeat(12);
  const decomposed = "e\u0301".repeat(12);
  const encoded = await hashPassword(composed);

  assert.equal(await verifyPasswordHash(encoded, composed), true);
  assert.equal(await verifyPasswordHash(encoded, decomposed), false);

  const spaced = "  secretvalue  ";
  const spacedHash = await hashPassword(spaced);
  assert.equal(await verifyPasswordHash(spacedHash, spaced), true);
  assert.equal(await verifyPasswordHash(spacedHash, spaced.trim()), false);
});

test("uses frozen Argon2id parameters and a random salt", async () => {
  const password = "frozen-value-123";
  const first = await hashPassword(password);
  const second = await hashPassword(password);

  assert.notEqual(first, second);
  assert.match(first, /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
  assert.deepEqual(ARGON2_PARAMETERS, {
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    type: 2,
  });
  assert.equal(await verifyPasswordHash(first, password), true);
  assert.equal(await verifyPasswordHash(first, "wrong-value-123"), false);
});

test("dummy hash is fixed Argon2id m=65536,t=3,p=1", async () => {
  assert.match(
    DUMMY_PASSWORD_HASH,
    /^\$argon2id\$v=19\$m=65536,p=1,t=3\$[^$]+\$[^$]+$/,
  );
  assert.equal(
    await verifyPasswordHash(DUMMY_PASSWORD_HASH, "unrelated-value"),
    false,
  );
});

test("malformed stored hashes fail closed without exposing argon2 errors", async () => {
  assert.equal(
    await verifyPasswordHash("malformed-internal-hash", "presented-value"),
    false,
  );
});

test("all hash and verify operations pass through the shared gate", async () => {
  const before = argon2Gate.getSnapshot().operationsStarted;
  const encoded = await hashPassword("shared-gate-value");
  await verifyPasswordHash(encoded, "shared-gate-value");
  const after = argon2Gate.getSnapshot().operationsStarted;

  assert.equal(after - before, 2);
});
