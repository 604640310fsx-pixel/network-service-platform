import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateUserCandidate,
  InvalidCredentialsError,
} from "../../src/auth/authentication.js";
import { hashPassword } from "../../src/auth/password.js";
import {
  createLoginSession,
  loginAndCreateSession,
  SESSION_ABSOLUTE_TTL_MS,
} from "../../src/session/login-session.js";
import {
  computeSessionTokenHash,
  type TokenHmacKeyring,
} from "../../src/session/session-token.js";
import type { DatabaseConnection } from "../../src/db.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const NOW = new Date("2026-08-18T04:05:06.789Z");
const FAMILY_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_FAMILY_ID = "223e4567-e89b-42d3-a456-426614174000";
const KEY_V1 = Buffer.alloc(32, 0x31).toString("base64");
const KEY_V2 = Buffer.alloc(32, 0x32).toString("base64");
const KEYRING_V1: TokenHmacKeyring = {
  version: 1,
  keys: { "1": KEY_V1 },
};
const FIXED_RANDOM = Buffer.alloc(32, 0x45);

function count(database: DatabaseConnection, table: string): number {
  const rows = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .all() as Array<{ readonly count: number }>;
  return rows[0]?.count ?? -1;
}

function frozenDependencies(
  familyId = FAMILY_ID,
  random = FIXED_RANDOM,
) {
  return {
    now: () => new Date(NOW),
    familyId: () => familyId,
    randomBytes: (size: number) => {
      assert.equal(size, 32);
      return Buffer.from(random);
    },
  };
}

async function insertActiveUser(
  database: DatabaseConnection,
  password: string,
  email = "login@example.com",
): Promise<{ readonly userId: number; readonly passwordHash: string }> {
  const passwordHash = await hashPassword(password);
  const userId = insertAuthenticationUser(database, {
    email,
    passwordHash,
    status: "active",
  });
  return { userId, passwordHash };
}

test("creates one web family and Session atomically after successful authentication", async () => {
  const password = "login-success-value";

  await withAuthenticationDatabase(async (database) => {
    const { userId } = await insertActiveUser(database, password);
    const result = await loginAndCreateSession(
      database,
      " Login@Example.COM ",
      password,
      KEYRING_V1,
      frozenDependencies(),
    );
    const families = database
      .prepare("SELECT id, user_id, created_at, revoked_at FROM session_families")
      .all() as Array<Record<string, unknown>>;
    const sessions = database
      .prepare(
        `SELECT token_hash, hmac_key_version, user_id, session_family_id,
                audience, created_at, expires_at, last_seen_at, revoked_at
         FROM sessions`,
      )
      .all() as Array<Record<string, unknown>>;
    const token = computeSessionTokenHash(result.rawSessionToken, KEYRING_V1);

    assert.match(
      result.sessionFamilyId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(result.userId, userId);
    assert.equal(result.role, "user");
    assert.deepEqual(families, [{
      id: FAMILY_ID,
      user_id: userId,
      created_at: NOW.toISOString(),
      revoked_at: null,
    }]);
    assert.deepEqual(sessions, [{
      token_hash: token.tokenHash,
      hmac_key_version: 1,
      user_id: userId,
      session_family_id: FAMILY_ID,
      audience: "web",
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + SESSION_ABSOLUTE_TTL_MS).toISOString(),
      last_seen_at: NOW.toISOString(),
      revoked_at: null,
    }]);
    assert.equal(JSON.stringify({ families, sessions }).includes(result.rawSessionToken), false);
    assert.equal(Buffer.from(result.rawSessionToken.split(".")[1] ?? "", "base64url").length, 32);
  });
});

test("returns the role re-read inside the Session creation transaction", async () => {
  const password = "role-reread-value";

  await withAuthenticationDatabase(async (database) => {
    const passwordHash = await hashPassword(password);
    const userId = insertAuthenticationUser(database, {
      email: "role-reread@example.com",
      passwordHash,
      status: "active",
      role: "admin",
    });
    const candidate = await authenticateUserCandidate(
      database,
      "role-reread@example.com",
      password,
    );
    assert.equal(candidate.role, "admin");

    database
      .prepare("UPDATE users SET role = 'user', updated_at = ? WHERE id = ?")
      .run(NOW.toISOString(), userId);

    const result = createLoginSession(
      database,
      candidate,
      KEYRING_V1,
      frozenDependencies(),
    );

    assert.equal(result.role, "user");
    assert.equal(count(database, "session_families"), 1);
    assert.equal(count(database, "sessions"), 1);
  });
});

test("missing, wrong-password, and disabled login attempts create no Session state", async () => {
  const password = "uniform-login-value";
  const passwordHash = await hashPassword(password);

  await withAuthenticationDatabase(async (database) => {
    await assert.rejects(
      loginAndCreateSession(
        database,
        "missing@example.com",
        password,
        KEYRING_V1,
      ),
      InvalidCredentialsError,
    );
    assert.equal(count(database, "session_families"), 0);
    assert.equal(count(database, "sessions"), 0);
  });

  await withAuthenticationDatabase(async (database) => {
    insertAuthenticationUser(database, {
      email: "wrong@example.com",
      passwordHash,
      status: "active",
    });
    await assert.rejects(
      loginAndCreateSession(
        database,
        "wrong@example.com",
        "wrong-login-value",
        KEYRING_V1,
      ),
      InvalidCredentialsError,
    );
    assert.equal(count(database, "session_families"), 0);
    assert.equal(count(database, "sessions"), 0);
  });

  await withAuthenticationDatabase(async (database) => {
    insertAuthenticationUser(database, {
      email: "disabled@example.com",
      passwordHash,
      status: "disabled",
    });
    await assert.rejects(
      loginAndCreateSession(
        database,
        "disabled@example.com",
        password,
        KEYRING_V1,
      ),
      InvalidCredentialsError,
    );
    assert.equal(count(database, "session_families"), 0);
    assert.equal(count(database, "sessions"), 0);
  });
});

test("reset committed after Argon2 verification makes Login CAS fail without state", async () => {
  const password = "before-reset-value";
  const newPasswordHash = await hashPassword("after-reset-value");

  await withAuthenticationDatabase(async (database) => {
    const { userId } = await insertActiveUser(database, password);
    const candidate = await authenticateUserCandidate(
      database,
      "login@example.com",
      password,
    );
    const reset = database.transaction(() => {
      database
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(newPasswordHash, NOW.toISOString(), userId);
      database
        .prepare(
          "UPDATE session_families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        )
        .run(NOW.toISOString(), userId);
    });

    reset.immediate();

    assert.throws(
      () =>
        createLoginSession(
          database,
          candidate,
          KEYRING_V1,
          frozenDependencies(),
        ),
      InvalidCredentialsError,
    );
    assert.equal(count(database, "session_families"), 0);
    assert.equal(count(database, "sessions"), 0);
  });
});

test("rechecks disabled status inside the same immediate transaction", async () => {
  const password = "status-race-value";

  await withAuthenticationDatabase(async (database) => {
    const { userId } = await insertActiveUser(database, password);
    const candidate = await authenticateUserCandidate(
      database,
      "login@example.com",
      password,
    );
    database
      .prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(NOW.toISOString(), userId);

    assert.throws(
      () => createLoginSession(database, candidate, KEYRING_V1),
      InvalidCredentialsError,
    );
    assert.equal(count(database, "session_families"), 0);
    assert.equal(count(database, "sessions"), 0);
  });
});

test("rolls back the whole transaction on family primary-key collision", async () => {
  const password = "family-collision-value";

  await withAuthenticationDatabase(async (database) => {
    const { userId } = await insertActiveUser(database, password);
    const candidate = await authenticateUserCandidate(
      database,
      "login@example.com",
      password,
    );
    database
      .prepare("INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)")
      .run(FAMILY_ID, userId, NOW.toISOString());

    assert.throws(() =>
      createLoginSession(
        database,
        candidate,
        KEYRING_V1,
        frozenDependencies(FAMILY_ID),
      ),
    );
    assert.equal(count(database, "session_families"), 1);
    assert.equal(count(database, "sessions"), 0);
  });
});

test("rolls back the new family when Session insertion fails", async () => {
  const password = "session-rollback-value";

  await withAuthenticationDatabase(async (database) => {
    const { userId } = await insertActiveUser(database, password);
    const candidate = await authenticateUserCandidate(
      database,
      "login@example.com",
      password,
    );
    const rawToken = `v1.${FIXED_RANDOM.toString("base64url")}`;
    const { tokenHash } = computeSessionTokenHash(rawToken, KEYRING_V1);
    database
      .prepare("INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)")
      .run(FAMILY_ID, userId, NOW.toISOString());
    database
      .prepare(
        `INSERT INTO sessions (
          token_hash, hmac_key_version, user_id, session_family_id, audience,
          created_at, expires_at, last_seen_at
        ) VALUES (?, 1, ?, ?, 'web', ?, ?, ?)`,
      )
      .run(
        tokenHash,
        userId,
        FAMILY_ID,
        NOW.toISOString(),
        new Date(NOW.getTime() + SESSION_ABSOLUTE_TTL_MS).toISOString(),
        NOW.toISOString(),
      );

    assert.throws(() =>
      createLoginSession(
        database,
        candidate,
        KEYRING_V1,
        frozenDependencies(OTHER_FAMILY_ID),
      ),
    );
    assert.equal(count(database, "session_families"), 1);
    assert.equal(count(database, "sessions"), 1);
    assert.equal(
      count(
        database,
        "session_families WHERE id = '223e4567-e89b-42d3-a456-426614174000'",
      ),
      0,
    );
  });
});

test("uses the token prefix to locate a legal Session after key rotation", async () => {
  const password = "old-key-version-value";

  await withAuthenticationDatabase(async (database) => {
    await insertActiveUser(database, password);
    const result = await loginAndCreateSession(
      database,
      "login@example.com",
      password,
      KEYRING_V1,
      frozenDependencies(),
    );
    const rotatedKeyring: TokenHmacKeyring = {
      version: 2,
      keys: { "1": KEY_V1, "2": KEY_V2 },
    };
    const oldToken = computeSessionTokenHash(
      result.rawSessionToken,
      rotatedKeyring,
    );
    const rows = database
      .prepare(
        `SELECT id FROM sessions
         WHERE token_hash = ? AND hmac_key_version = ? AND audience = 'web'`,
      )
      .all(oldToken.tokenHash, oldToken.hmacKeyVersion);

    assert.equal(oldToken.hmacKeyVersion, 1);
    assert.equal(rows.length, 1);
  });
});

test("does not write password, hash, or raw Session token to console", async (context) => {
  const log = context.mock.method(console, "log", () => undefined);
  const errorLog = context.mock.method(console, "error", () => undefined);
  const warn = context.mock.method(console, "warn", () => undefined);
  const password = "no-session-log-value";

  await withAuthenticationDatabase(async (database) => {
    await insertActiveUser(database, password);
    const result = await loginAndCreateSession(
      database,
      "login@example.com",
      password,
      KEYRING_V1,
    );
    const rows = database.prepare("SELECT * FROM sessions").all();

    assert.equal(JSON.stringify(rows).includes(result.rawSessionToken), false);
  });

  assert.equal(log.mock.callCount(), 0);
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
});
