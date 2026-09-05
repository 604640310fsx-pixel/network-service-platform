import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { AuthHttpDependencies } from "../../src/http/auth-routes.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import type { RateLimitKeyring } from "../../src/http/rate-limit.js";
import {
  computeSessionTokenHash,
  type TokenHmacKeyring,
} from "../../src/session/session-token.js";
import { SESSION_IDLE_TTL_MS } from "../../src/session/session-validity.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const NOW = new Date("2026-09-05T02:03:04.567Z");
const TOKEN_KEYRING: TokenHmacKeyring = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x21).toString("base64"),
    "2": Buffer.alloc(32, 0x22).toString("base64"),
  },
};
const RATE_LIMIT_KEYRING: RateLimitKeyring = {
  version: 1,
  keys: { "1": Buffer.alloc(32, 0x31).toString("base64") },
};
const CSRF_SIGNING_KEY = Buffer.alloc(32, 0x41);
const FAMILY_A = "123e4567-e89b-42d3-a456-426614174000";
const FAMILY_B = "223e4567-e89b-42d3-a456-426614174000";
const EXPIRED_COOKIE =
  "__Host-web_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax";
const LOGOUT_HEADERS = {
  origin: "http://localhost:5173",
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
} as const;

function rawToken(byte: number, version = 1): string {
  return `v${version}.${Buffer.alloc(32, byte).toString("base64url")}`;
}

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function authDependencies(
  database: DatabaseConnection,
  overrides: Partial<AuthHttpDependencies> = {},
): AuthHttpDependencies {
  return {
    database,
    nodeEnv: "test",
    tokenHmacKeyring: TOKEN_KEYRING,
    rateLimitKeyring: RATE_LIMIT_KEYRING,
    csrfSigningKey: CSRF_SIGNING_KEY,
    sessionLookupDependencies: { now: () => new Date(NOW) },
    sessionTerminationDependencies: { now: () => new Date(NOW) },
    ...overrides,
  };
}

function insertFamily(
  database: DatabaseConnection,
  userId: number,
  familyId: string,
): void {
  database
    .prepare(
      "INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)",
    )
    .run(familyId, userId, iso(-60_000));
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
  const token = computeSessionTokenHash(options.rawToken, TOKEN_KEYRING);
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
    computeSessionTokenHash(rawSessionToken, TOKEN_KEYRING).tokenHash,
  );
}

function logoutRequest(rawSessionToken?: string, csrfToken?: string) {
  const headers: Record<string, string> = { ...LOGOUT_HEADERS };
  if (rawSessionToken !== undefined) {
    headers.cookie = `__Host-web_session=${rawSessionToken}`;
  }
  if (csrfToken !== undefined) {
    headers["x-csrf-token"] = csrfToken;
  }
  return {
    method: "POST" as const,
    url: "/api/auth/logout",
    headers,
    payload: {},
  };
}

function assertSuccessfulClear(response: {
  readonly statusCode: number;
  readonly headers: Record<string, string | number | string[] | undefined>;
  json(): unknown;
}): void {
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["set-cookie"], EXPIRED_COOKIE);
  assert.doesNotMatch(String(response.headers["set-cookie"]), /Domain=/i);
}

function stateSnapshot(database: DatabaseConnection): string {
  return JSON.stringify({
    sessions: database.prepare("SELECT * FROM sessions ORDER BY id").all(),
    families: database
      .prepare("SELECT * FROM session_families ORDER BY id")
      .all(),
    users: database.prepare("SELECT * FROM users ORDER BY id").all(),
  });
}

test("valid exact Origin, XHR, body, and bound CSRF revoke only the current web Session", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "http-logout@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    insertFamily(database, userId, FAMILY_B);
    const currentRaw = rawToken(0x51);
    const current = insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: currentRaw,
      lastSeenAt: iso(-45_000),
    });
    insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: rawToken(0x52),
    });
    insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: rawToken(0x53),
      audience: "monitor",
    });
    insertSession(database, {
      userId,
      familyId: FAMILY_B,
      rawToken: rawToken(0x54),
    });
    const beforeLastSeen = database
      .prepare("SELECT id, last_seen_at FROM sessions ORDER BY id")
      .all();
    const csrf = csrfFor(currentRaw);
    const app = buildApp({ auth: authDependencies(database) });

    try {
      const response = await app.inject(logoutRequest(currentRaw, csrf));
      assertSuccessfulClear(response);
      for (const identifier of [
        currentRaw,
        current.tokenHash,
        csrf,
        FAMILY_A,
        String(userId),
      ]) {
        assert.equal(response.body.includes(identifier), false);
      }

      const sessions = database
        .prepare("SELECT id, revoked_at, last_seen_at FROM sessions ORDER BY id")
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

      const me = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: `__Host-web_session=${currentRaw}` },
      });
      assert.equal(me.statusCode, 401);
      assert.deepEqual(me.json(), { error: { code: "unauthorized" } });
    } finally {
      await app.close();
    }
  });
});

test("request boundary failures are exact 400 responses with zero database or Cookie side effects", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "boundary@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    const raw = rawToken(0x61);
    insertSession(database, { userId, familyId: FAMILY_A, rawToken: raw });
    const csrf = csrfFor(raw);
    const before = stateSnapshot(database);
    const app = buildApp({ auth: authDependencies(database) });

    const cases = [
      {
        code: "origin_rejected",
        request: { ...logoutRequest(raw, csrf), headers: { ...LOGOUT_HEADERS, cookie: `__Host-web_session=${raw}`, "x-csrf-token": csrf, origin: "https://wrong.example" } },
      },
      {
        code: "origin_rejected",
        request: { ...logoutRequest(raw, csrf), headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", cookie: `__Host-web_session=${raw}`, "x-csrf-token": csrf } },
      },
      {
        code: "invalid_request",
        request: { ...logoutRequest(raw, csrf), headers: { origin: LOGOUT_HEADERS.origin, "content-type": "application/json", cookie: `__Host-web_session=${raw}`, "x-csrf-token": csrf } },
      },
      {
        code: "invalid_request",
        request: { ...logoutRequest(raw, csrf), headers: { ...LOGOUT_HEADERS, "x-requested-with": "fetch", cookie: `__Host-web_session=${raw}`, "x-csrf-token": csrf } },
      },
      {
        code: "invalid_request",
        request: { ...logoutRequest(raw, csrf), headers: { ...LOGOUT_HEADERS, "content-type": "application/json; charset=utf-8", cookie: `__Host-web_session=${raw}`, "x-csrf-token": csrf } },
      },
      {
        code: "invalid_request",
        request: { method: "POST" as const, url: "/api/auth/logout", headers: { origin: LOGOUT_HEADERS.origin, "x-requested-with": "XMLHttpRequest", cookie: `__Host-web_session=${raw}`, "x-csrf-token": csrf }, payload: "{}" },
      },
      {
        code: "invalid_request",
        request: { ...logoutRequest(raw, csrf), payload: undefined },
      },
      {
        code: "invalid_request",
        request: { ...logoutRequest(raw, csrf), payload: [] },
      },
      {
        code: "invalid_request",
        request: { ...logoutRequest(raw, csrf), payload: { extra: true } },
      },
    ] as const;

    try {
      for (const fixture of cases) {
        const response = await app.inject(fixture.request);
        assert.equal(response.statusCode, 400);
        assert.deepEqual(response.json(), { error: { code: fixture.code } });
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(stateSnapshot(database), before);
      }
    } finally {
      await app.close();
    }
  });
});

test("valid Sessions require the exact bound CSRF and retain state on every 403", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "http-csrf@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    const raw = rawToken(0x62);
    insertSession(database, { userId, familyId: FAMILY_A, rawToken: raw });
    const before = stateSnapshot(database);
    const app = buildApp({ auth: authDependencies(database) });

    try {
      for (const csrf of [undefined, "wrong", "A".repeat(43)]) {
        const response = await app.inject(logoutRequest(raw, csrf));
        assert.equal(response.statusCode, 403);
        assert.deepEqual(response.json(), { error: { code: "csrf_invalid" } });
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(stateSnapshot(database), before);
      }
    } finally {
      await app.close();
    }
  });
});

test("no, malformed, duplicate, unknown, expired, idle, revoked, family-revoked, and inactive Cookies are idempotent 200", async () => {
  const cases = [
    "no-cookie",
    "malformed",
    "duplicate",
    "unknown",
    "expired",
    "idle",
    "revoked",
    "family-revoked",
    "inactive-user",
  ] as const;

  for (const fixture of cases) {
    await withAuthenticationDatabase(async (database) => {
      const userId = insertAuthenticationUser(database, {
        email: `${fixture}@example.com`,
        passwordHash: "$argon2id$fixture-only",
        status: "active",
      });
      insertFamily(database, userId, FAMILY_A);
      const storedRaw = rawToken(0x71);
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
      const before = stateSnapshot(database);
      const app = buildApp({ auth: authDependencies(database) });

      try {
        let request = logoutRequest(storedRaw);
        if (fixture === "no-cookie") request = logoutRequest();
        if (fixture === "malformed") request = logoutRequest("malformed");
        if (fixture === "unknown") request = logoutRequest(rawToken(0x72));
        if (fixture === "duplicate") {
          request = logoutRequest();
          request.headers.cookie = `__Host-web_session=${storedRaw}; __Host-web_session=${storedRaw}`;
        }
        const response = await app.inject(request);
        assertSuccessfulClear(response);
        assert.equal(stateSnapshot(database), before);
      } finally {
        await app.close();
      }
    });
  }
});

test("database, keyring, CSRF configuration, and internal failures return 503 without clearing Cookie", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "fail-closed@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    const raw = rawToken(0x73);
    insertSession(database, { userId, familyId: FAMILY_A, rawToken: raw });
    const csrf = csrfFor(raw);
    const before = stateSnapshot(database);
    const databaseFailure = {
      pragma: database.pragma.bind(database),
      exec: database.exec.bind(database),
      prepare: database.prepare.bind(database),
      transaction() {
        throw new Error("database unavailable");
      },
      close: () => undefined,
    } as DatabaseConnection;
    const cases: AuthHttpDependencies[] = [
      authDependencies(databaseFailure),
      authDependencies(database, {
        tokenHmacKeyring: { version: 2, keys: {} },
      }),
      authDependencies(database, { csrfSigningKey: Buffer.alloc(31) }),
      authDependencies(database, {
        sessionTerminationOperation: () => {
          throw new Error("internal identifier must not escape");
        },
      }),
    ];

    for (const dependencies of cases) {
      const app = buildApp({ auth: dependencies });
      try {
        const response = await app.inject(logoutRequest(raw, csrf));
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.json(), { error: { code: "auth_unavailable" } });
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.body.includes(raw), false);
        assert.equal(response.body.includes("internal identifier"), false);
        assert.equal(stateSnapshot(database), before);
      } finally {
        await app.close();
      }
    }
  });
});

test("two concurrent requests both succeed while exactly one revocation write occurs", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "concurrent@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    const raw = rawToken(0x74);
    insertSession(database, { userId, familyId: FAMILY_A, rawToken: raw });
    database.exec(`
      CREATE TABLE logout_write_audit (session_id INTEGER NOT NULL);
      CREATE TRIGGER count_logout_writes
      AFTER UPDATE OF revoked_at ON sessions
      WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      BEGIN
        INSERT INTO logout_write_audit (session_id) VALUES (NEW.id);
      END;
    `);
    const app = buildApp({ auth: authDependencies(database) });

    try {
      const csrf = csrfFor(raw);
      const responses = await Promise.all([
        app.inject(logoutRequest(raw, csrf)),
        app.inject(logoutRequest(raw, csrf)),
      ]);
      for (const response of responses) {
        assertSuccessfulClear(response);
        assert.equal(response.body.includes("SQLITE_BUSY"), false);
      }
      assert.deepEqual(
        database.prepare("SELECT session_id FROM logout_write_audit").all(),
        [{ session_id: 1 }],
      );
      assert.deepEqual(
        database.prepare("SELECT revoked_at FROM sessions").all(),
        [{ revoked_at: NOW.toISOString() }],
      );
    } finally {
      await app.close();
    }
  });
});

test("logout responses and logs contain zero raw Session, hash, CSRF, family, or user identifiers", async (context) => {
  const log = context.mock.method(console, "log", () => undefined);
  const errorLog = context.mock.method(console, "error", () => undefined);
  const warn = context.mock.method(console, "warn", () => undefined);

  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "secret-output@example.com",
      passwordHash: "$argon2id$fixture-only",
      status: "active",
    });
    insertFamily(database, userId, FAMILY_A);
    const raw = rawToken(0x75);
    const session = insertSession(database, {
      userId,
      familyId: FAMILY_A,
      rawToken: raw,
    });
    const csrf = csrfFor(raw);
    const app = buildApp({ auth: authDependencies(database) });
    try {
      const response = await app.inject(logoutRequest(raw, csrf));
      const output = [
        response.body,
        ...log.mock.calls.map((call) => JSON.stringify(call.arguments)),
        ...errorLog.mock.calls.map((call) => JSON.stringify(call.arguments)),
        ...warn.mock.calls.map((call) => JSON.stringify(call.arguments)),
      ].join("\n");
      for (const identifier of [raw, session.tokenHash, csrf, FAMILY_A, String(userId)]) {
        assert.equal(output.includes(identifier), false);
      }
    } finally {
      await app.close();
    }
  });

  assert.equal(log.mock.callCount(), 0);
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
});
