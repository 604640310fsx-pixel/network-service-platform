import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateUserCandidate,
  InvalidCredentialsError,
} from "../../src/auth/authentication.js";
import { argon2Gate } from "../../src/auth/argon2-gate.js";
import { hashPassword } from "../../src/auth/password.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

function captureInvalidCredentials(
  operation: Promise<unknown>,
): Promise<InvalidCredentialsError> {
  return operation.then(
    () => {
      throw new Error("expected invalid credentials");
    },
    (error: unknown) => {
      assert.ok(error instanceof InvalidCredentialsError);
      return error;
    },
  );
}

test("returns an internal candidate only for active users with a valid password", async () => {
  const password = "candidate-value-123";
  const passwordHash = await hashPassword(password);

  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "active@example.com",
      passwordHash,
      status: "active",
    });

    const candidate = await authenticateUserCandidate(
      database,
      " Active@Example.COM ",
      password,
    );
    assert.deepEqual(candidate, {
      id: userId,
      email: "active@example.com",
      role: "user",
      verifiedPasswordHash: passwordHash,
    });
  });
});

test("missing, wrong-password, and disabled paths share invalid_credentials", async () => {
  const password = "uniform-value-123";
  const passwordHash = await hashPassword(password);

  await withAuthenticationDatabase(async (database) => {
    insertAuthenticationUser(database, {
      email: "active@example.com",
      passwordHash,
      status: "active",
    });

    const disabledDirectory = await withAuthenticationDatabase(async (disabledDb) => {
      insertAuthenticationUser(disabledDb, {
        email: "disabled@example.com",
        passwordHash,
        status: "disabled",
      });

      const beforeDisabled = argon2Gate.getSnapshot().operationsStarted;
      const disabled = await captureInvalidCredentials(
        authenticateUserCandidate(
          disabledDb,
          "disabled@example.com",
          password,
        ),
      );
      assert.equal(
        argon2Gate.getSnapshot().operationsStarted - beforeDisabled,
        1,
      );
      return disabled;
    });

    const beforeMissing = argon2Gate.getSnapshot().operationsStarted;
    const missing = await captureInvalidCredentials(
      authenticateUserCandidate(database, "missing@example.com", password),
    );
    assert.equal(
      argon2Gate.getSnapshot().operationsStarted - beforeMissing,
      1,
    );

    const beforeWrong = argon2Gate.getSnapshot().operationsStarted;
    const wrong = await captureInvalidCredentials(
      authenticateUserCandidate(
        database,
        "active@example.com",
        "wrong-value-123",
      ),
    );
    assert.equal(
      argon2Gate.getSnapshot().operationsStarted - beforeWrong,
      1,
    );

    const publicShapes = [missing, wrong, disabledDirectory].map((error) => ({
      name: error.name,
      code: error.code,
      message: error.message,
    }));
    assert.deepEqual(publicShapes[0], publicShapes[1]);
    assert.deepEqual(publicShapes[1], publicShapes[2]);

    for (const error of [missing, wrong, disabledDirectory]) {
      const serialized = JSON.stringify({
        name: error.name,
        code: error.code,
        message: error.message,
      });
      assert.doesNotMatch(serialized, /uniform-value-123/);
      assert.doesNotMatch(serialized, /\$argon2id\$/);
      assert.doesNotMatch(serialized, /disabled/);
    }
  });
});

test("password operations and authentication failures do not write sensitive logs", async (context) => {
  const log = context.mock.method(console, "log", () => undefined);
  const errorLog = context.mock.method(console, "error", () => undefined);
  const warn = context.mock.method(console, "warn", () => undefined);
  const password = "log-safety-value";
  const passwordHash = await hashPassword(password);

  await withAuthenticationDatabase(async (database) => {
    insertAuthenticationUser(database, {
      email: "log-safe@example.com",
      passwordHash,
      status: "active",
    });

    const error = await captureInvalidCredentials(
      authenticateUserCandidate(
        database,
        "log-safe@example.com",
        "wrong-log-value",
      ),
    );
    const rendered = `${error.name}:${error.code}:${error.message}`;

    assert.doesNotMatch(rendered, /log-safety-value|wrong-log-value/);
    assert.doesNotMatch(rendered, /\$argon2id\$/);
  });

  assert.equal(log.mock.callCount(), 0);
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
});
