import assert from "node:assert/strict";
import test from "node:test";

import type {
  DatabaseConnection,
  DatabaseTransaction,
} from "../../src/db.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import {
  terminateCurrentWebSession,
  type SessionTerminationResult,
} from "../../src/session/session-termination.js";
import {
  computeSessionTokenHash,
  SessionTokenOperationError,
  type TokenHmacKeyring,
} from "../../src/session/session-token.js";
import { SESSION_IDLE_TTL_MS } from "../../src/session/session-validity.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const NOW = new Date("2026-09-05T01:02:03.456Z");
const KEYRING: TokenHmacKeyring = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x31).toString("base64"),
    "2": Buffer.alloc(32, 0x32).toString("base64"),
  },
};
const CSRF_SIGNING_KEY = Buffer.alloc(32, 0x41);
const FAMILY_A = "123e4567-e89b-42d3-a456-426614174000";
const FAMILY_B = "223e4567-e89b-42d3-a456-426614174000";

function rawToken(byte: number, version = 1): string {
  return `v${version}.${Buffer.alloc(32, byte).toString("base64url")}`;
}

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function insertFamily(
  database: DatabaseConnection,
  userId: number,
  familyId: string,
  revokedAt: string | null = null,
): void {
  database
    .prepare(
      `INSERT INTO session_families (id, user_id, created_at, revoked_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(familyId, userId, iso(-60_000), revokedAt);
}

function insertSession(
  database: DatabaseConnection,
  options: {
    readonly userId: number;
    readonly familyId: string;
    readonly rawToken: string;
    readonly audience?: "web" | "monitor";
    readonly expiresAt?: string;
    readonly lastSeenAt?: string;
    readonly revokedAt?: string | null;
  },
): { readonly id: number; readonly tokenHash: string } {
  const token = computeSessionTokenHash(options.rawToken, KEYRING);
  database
    .prepare(
      `INSERT INTO sessions (
        token_hash, hmac_key_version, user_id, session_family_id, audience,
        created_at, expires_at, last_seen_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      token.tokenHash,
      token.hmacKeyVersion,
      options.userId,
      options.familyId,
      options.audience ?? "web",
      iso(-60_000),
      options.expiresAt ?? iso(60_000),
      options.lastSeenAt ?? iso(-30_000),
      options.revokedAt ?? null,
    );
  const rows = database
    .prepare("SELECT id FROM sessions WHERE token_hash = ?")
    .all(token.tokenHash) as Array<{ readonly id: number }>;
  assert.equal(rows.length, 1);
  return { id: rows[0]!.id, tokenHash: token.tokenHash };
}

function csrfFor(rawSessionToken: string): string {
  return issueCsrfToken(
    CSRF_SIGNING_KEY,
    computeSessionTokenHash(rawSessionToken, KEYRING).tokenHash,
  );
}

function terminate(
  database: DatabaseConnection,
  rawSessionToken: string,
  csrfToken: unknown,
  csrfSigningKey = CSRF_SIGNING_KEY,
): SessionTerminationResult {
  return terminateCurrentWebSession(
    database,
    rawSessionToken,
    csrfToken,
    KEYRING,
    csrfSigningKey,
    { now: () => new Date(NOW) },
  );
}

test("revokes only the current web Session and leaves family, sibling, monitor, and last-seen state unchanged", async () => {
  await withAuthenticationDatabase((database) => {
    const userId = insertAuthenticationUser(database, {
      email: "termination@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    insertFamily(database, userId, FAMILY_B);

    const currentRaw = rawToken(0x51);
    const siblingRaw = rawToken(0x52);
    const monitorRaw = rawToken(0x53);
    const otherFamilyRaw = rawToken(0x54);
    const current = insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: currentRaw,
      lastSeenAt: iso(-45_000),
    });
    insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: siblingRaw,
      lastSeenAt: iso(-44_000),
    });
    insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: monitorRaw,
      audience: "monitor",
      lastSeenAt: iso(-43_000),
    });
    insertSession(database, {
      userId,
      familyId: FAMILY_B,
      rawToken: otherFamilyRaw,
      lastSeenAt: iso(-42_000),
    });

    const beforeLastSeen = database
      .prepare("SELECT id, last_seen_at FROM sessions ORDER BY id")
      .all();
    assert.equal(terminate(database, currentRaw, csrfFor(currentRaw)), "terminated");

    const sessions = database
      .prepare(
        "SELECT id, revoked_at, last_seen_at FROM sessions ORDER BY id",
      )
      .all() as Array<{
        readonly id: number;
        readonly revoked_at: string | null;
        readonly last_seen_at: string;
      }>;
    assert.equal(
      sessions.find((row) => row.id === current.id)?.revoked_at,
      NOW.toISOString(),
    );
    assert.equal(
      sessions.filter((row) => row.id !== current.id && row.revoked_at !== null)
        .length,
      0,
    );
    assert.deepEqual(
      sessions.map(({ id, last_seen_at }) => ({ id, last_seen_at })),
      beforeLastSeen,
    );
    assert.deepEqual(
      database
        .prepare("SELECT id, revoked_at FROM session_families ORDER BY id")
        .all(),
      [
        { id: FAMILY_A, revoked_at: null },
        { id: FAMILY_B, revoked_at: null },
      ],
    );

    assert.equal(terminate(database, currentRaw, undefined), "unauthenticated");
    const revoked = database
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NOT NULL",
      )
      .all() as Array<{ readonly count: number }>;
    assert.deepEqual(revoked, [{ count: 1 }]);
  });
});

test("maps absent and every inactive Session state to unauthenticated without writes", async () => {
  const cases = [
    "unknown",
    "expired",
    "idle",
    "revoked",
    "family-revoked",
    "inactive-user",
  ] as const;

  for (const fixture of cases) {
    await withAuthenticationDatabase((database) => {
      const userId = insertAuthenticationUser(database, {
        email: `${fixture}@example.com`,
        passwordHash: "$argon2id$fixture-only",
        status: "active",
      });
      insertFamily(database, userId, FAMILY_A);
      const storedRaw = rawToken(0x61);
      insertSession(database, {
        userId,
        familyId: FAMILY_A,
        rawToken: storedRaw,
        expiresAt: fixture === "expired" ? NOW.toISOString() : undefined,
        lastSeenAt:
          fixture === "idle" ? iso(-SESSION_IDLE_TTL_MS) : undefined,
        revokedAt: fixture === "revoked" ? iso(-1) : undefined,
      });
      if (fixture === "family-revoked") {
        database
          .prepare("UPDATE session_families SET revoked_at = ?")
          .run(iso(-1));
      }
      if (fixture === "inactive-user") {
        database.prepare("UPDATE users SET status = 'disabled'").run();
      }

      const before = JSON.stringify({
        sessions: database.prepare("SELECT * FROM sessions").all(),
        families: database.prepare("SELECT * FROM session_families").all(),
        users: database.prepare("SELECT * FROM users").all(),
      });
      const presentedRaw =
        fixture === "unknown" ? rawToken(0x62) : storedRaw;
      assert.equal(
        terminate(database, presentedRaw, "A".repeat(43)),
        "unauthenticated",
      );
      assert.equal(
        JSON.stringify({
          sessions: database.prepare("SELECT * FROM sessions").all(),
          families: database.prepare("SELECT * FROM session_families").all(),
          users: database.prepare("SELECT * FROM users").all(),
        }),
        before,
      );
    });
  }
});

test("treats malformed raw tokens as unauthenticated before database or keyring access", () => {
  const unavailable = new Proxy({} as DatabaseConnection, {
    get() {
      throw new Error("database must not be reached");
    },
  });
  assert.equal(
    terminateCurrentWebSession(
      unavailable,
      "malformed",
      undefined,
      { version: 1, keys: {} },
      Buffer.alloc(0),
    ),
    "unauthenticated",
  );
});

test("fails closed when a syntactically legal token cannot be hashed", async () => {
  await withAuthenticationDatabase((database) => {
    assert.throws(
      () =>
        terminateCurrentWebSession(
          database,
          rawToken(0x71, 9),
          "A".repeat(43),
          KEYRING,
          CSRF_SIGNING_KEY,
        ),
      SessionTokenOperationError,
    );
  });
});

test("valid Session CSRF failures never revoke or touch the Session", async () => {
  await withAuthenticationDatabase((database) => {
    const userId = insertAuthenticationUser(database, {
      email: "csrf@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    const currentRaw = rawToken(0x72);
    insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: currentRaw,
    });
    const before = database.prepare("SELECT * FROM sessions").all();

    for (const candidate of [undefined, "wrong", "A".repeat(43)]) {
      assert.equal(terminate(database, currentRaw, candidate), "csrf_invalid");
      assert.deepEqual(database.prepare("SELECT * FROM sessions").all(), before);
    }

    assert.throws(() =>
      terminate(database, currentRaw, "A".repeat(43), Buffer.alloc(31)),
    );
    assert.deepEqual(database.prepare("SELECT * FROM sessions").all(), before);
  });
});

interface FakeDatabaseEvidence {
  immediateCalls: number;
  ordinaryCalls: number;
  selectSql: string;
  updateSql: string;
  selectParameters: readonly unknown[];
  updateParameters: readonly unknown[];
}

function strictRow(rawSessionToken: string): Record<string, unknown> {
  const token = computeSessionTokenHash(rawSessionToken, KEYRING);
  return {
    session_id: 7,
    token_hash: token.tokenHash,
    hmac_key_version: token.hmacKeyVersion,
    session_user_id: 11,
    session_family_id: FAMILY_A,
    audience: "web",
    expires_at: iso(60_000),
    last_seen_at: iso(-30_000),
    session_revoked_at: null,
    family_id: FAMILY_A,
    family_user_id: 11,
    family_revoked_at: null,
    user_id: 11,
    user_status: "active",
  };
}

function fakeDatabase(
  rows: readonly unknown[],
  changes = 1,
): { readonly database: DatabaseConnection; readonly evidence: FakeDatabaseEvidence } {
  const evidence: FakeDatabaseEvidence = {
    immediateCalls: 0,
    ordinaryCalls: 0,
    selectSql: "",
    updateSql: "",
    selectParameters: [],
    updateParameters: [],
  };
  const database = {
    pragma: () => undefined,
    exec: () => undefined,
    prepare(source: string) {
      if (/^\s*SELECT/.test(source)) {
        evidence.selectSql = source;
        return {
          all(...parameters: readonly unknown[]) {
            evidence.selectParameters = parameters;
            return [...rows];
          },
          run() {
            throw new Error("unexpected SELECT run");
          },
        };
      }
      evidence.updateSql = source;
      return {
        all() {
          throw new Error("unexpected UPDATE all");
        },
        run(...parameters: readonly unknown[]) {
          evidence.updateParameters = parameters;
          return { changes };
        },
      };
    },
    transaction<Result>(operation: () => Result): DatabaseTransaction<Result> {
      const transaction = (() => {
        evidence.ordinaryCalls += 1;
        return operation();
      }) as DatabaseTransaction<Result>;
      transaction.immediate = () => {
        evidence.immediateCalls += 1;
        return operation();
      };
      return transaction;
    },
    close: () => undefined,
  } satisfies DatabaseConnection;
  return { database, evidence };
}

test("runs SELECT, CSRF, and an exact conditional UPDATE in one IMMEDIATE transaction", () => {
  const raw = rawToken(0x73);
  const token = computeSessionTokenHash(raw, KEYRING);
  const { database, evidence } = fakeDatabase([strictRow(raw)]);

  assert.equal(terminate(database, raw, csrfFor(raw)), "terminated");
  assert.equal(evidence.immediateCalls, 1);
  assert.equal(evidence.ordinaryCalls, 0);
  assert.deepEqual(evidence.selectParameters, [token.tokenHash, 1, "web"]);
  assert.deepEqual(evidence.updateParameters, [
    NOW.toISOString(),
    7,
    token.tokenHash,
    1,
    11,
    FAMILY_A,
  ]);
  assert.match(evidence.updateSql, /WHERE id = \?/);
  assert.match(evidence.updateSql, /token_hash = \?/);
  assert.match(evidence.updateSql, /hmac_key_version = \?/);
  assert.match(evidence.updateSql, /session_family_id = \?/);
  assert.match(evidence.updateSql, /audience = 'web'/);
  assert.match(evidence.updateSql, /revoked_at IS NULL/);
  assert.doesNotMatch(evidence.updateSql, /last_seen_at/);
});

test("fails closed on multiple, corrupt, unexpected, identity-mismatched, and update-count anomalies", () => {
  const raw = rawToken(0x74);
  const row = strictRow(raw);
  const anomalies = [
    { rows: [row, row], changes: 1 },
    { rows: [{ ...row, unexpected: true }], changes: 1 },
    { rows: [{ ...row, expires_at: "not-a-timestamp" }], changes: 1 },
    { rows: [{ ...row, family_user_id: 12 }], changes: 1 },
    { rows: [row], changes: 0 },
    { rows: [row], changes: 2 },
  ] as const;

  for (const anomaly of anomalies) {
    const { database } = fakeDatabase(anomaly.rows, anomaly.changes);
    assert.throws(() => terminate(database, raw, csrfFor(raw)));
  }
});

test("does not write Session, CSRF, family, or user identifiers to console", async (context) => {
  const log = context.mock.method(console, "log", () => undefined);
  const errorLog = context.mock.method(console, "error", () => undefined);
  const warn = context.mock.method(console, "warn", () => undefined);

  await withAuthenticationDatabase((database) => {
    const userId = insertAuthenticationUser(database, {
      email: "no-log@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    const raw = rawToken(0x75);
    insertSession(database, { userId, familyId: FAMILY_A, rawToken: raw });
    assert.equal(terminate(database, raw, csrfFor(raw)), "terminated");
  });

  assert.equal(log.mock.callCount(), 0);
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
});
