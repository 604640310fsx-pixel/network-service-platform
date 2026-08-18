import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { Argon2BusyError } from "../../src/auth/argon2-gate.js";
import { InvalidCredentialsError } from "../../src/auth/authentication.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { AuthHttpDependencies } from "../../src/http/auth-routes.js";
import {
  WEB_SESSION_COOKIE_MAX_AGE_SECONDS,
  WEB_SESSION_COOKIE_NAME,
} from "../../src/http/cookie.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import {
  consumeLoginRateLimit,
  LOGIN_ACCOUNT_LIMIT,
  type RateLimitKeyring,
} from "../../src/http/rate-limit.js";
import {
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "../../src/session/session-validity.js";
import {
  computeSessionTokenHash,
  type TokenHmacKeyring,
} from "../../src/session/session-token.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const PASSWORD = "local-fixture-password";
const TOKEN_KEYRING: TokenHmacKeyring = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x21).toString("base64"),
    "2": Buffer.alloc(32, 0x22).toString("base64"),
  },
};
const RATE_LIMIT_KEYRING: RateLimitKeyring = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x31).toString("base64"),
    "2": Buffer.alloc(32, 0x32).toString("base64"),
  },
};
const CSRF_SIGNING_KEY = Buffer.alloc(32, 0x41);
const FAMILY_ID = "123e4567-e89b-42d3-a456-426614174000";

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
    loginSessionDependencies: {
      now: () => new Date(NOW),
      familyId: () => FAMILY_ID,
      randomBytes: () => Buffer.alloc(32, 0x51),
    },
    sessionLookupDependencies: { now: () => new Date(NOW) },
    rateLimitDependencies: { now: () => new Date(NOW) },
    ...overrides,
  };
}

const LOGIN_HEADERS = {
  origin: "http://localhost:5173",
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
} as const;

function loginRequest(email: string, password = PASSWORD) {
  return {
    method: "POST" as const,
    url: "/api/auth/login",
    headers: LOGIN_HEADERS,
    payload: { email, password },
  };
}

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(";", 1)[0];
  assert.ok(pair !== undefined);
  assert.ok(pair.startsWith(`${WEB_SESSION_COOKIE_NAME}=`));
  return pair.slice(WEB_SESSION_COOKIE_NAME.length + 1);
}

test("logs in, sets the frozen host-only Cookie, and serves /me", async () => {
  await withAuthenticationDatabase(async (database) => {
    const passwordHash = await hashPassword(PASSWORD);
    insertAuthenticationUser(database, {
      email: "user@example.com",
      passwordHash,
      status: "active",
      role: "admin",
    });
    const app = buildApp({ auth: authDependencies(database) });

    try {
      const login = await app.inject(loginRequest(" USER@EXAMPLE.COM "));
      assert.equal(login.statusCode, 200);
      assert.deepEqual(login.json(), { status: "ok" });
      assert.equal(login.headers["cache-control"], "no-store");
      assert.equal(login.headers["retry-after"], undefined);

      const setCookie = login.headers["set-cookie"];
      assert.equal(typeof setCookie, "string");
      const serialized = setCookie as string;
      assert.match(serialized, /^__Host-web_session=v2\.[A-Za-z0-9_-]{43};/);
      assert.match(serialized, /; Path=\//);
      assert.match(serialized, /; HttpOnly/);
      assert.match(serialized, /; Secure/);
      assert.match(serialized, /; SameSite=Lax/);
      assert.match(
        serialized,
        new RegExp(`; Max-Age=${WEB_SESSION_COOKIE_MAX_AGE_SECONDS}`),
      );
      assert.doesNotMatch(serialized, /; Domain=/i);

      const rawToken = cookieValue(serialized);
      assert.equal(login.body.includes(rawToken), false);
      assert.equal(
        JSON.stringify(database.prepare("SELECT * FROM sessions").all()).includes(
          rawToken,
        ),
        false,
      );

      database
        .prepare("UPDATE sessions SET last_seen_at = ?")
        .run(
          new Date(NOW.getTime() - SESSION_TOUCH_INTERVAL_MS * 2).toISOString(),
        );
      const me = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${rawToken}` },
      });
      const tokenHash = computeSessionTokenHash(rawToken, TOKEN_KEYRING).tokenHash;
      assert.equal(me.statusCode, 200);
      assert.equal(me.headers["cache-control"], "no-store");
      assert.deepEqual(me.json(), {
        user: { email: "user@example.com", role: "admin" },
        csrfToken: issueCsrfToken(CSRF_SIGNING_KEY, tokenHash),
      });
      assert.equal(me.body.includes(rawToken), false);
      assert.equal("sessionId" in me.json(), false);
      assert.equal("tokenHash" in me.json(), false);

      const lastSeenRows = database
        .prepare("SELECT last_seen_at FROM sessions")
        .all() as Array<{ readonly last_seen_at: string }>;
      assert.equal(lastSeenRows[0]?.last_seen_at, NOW.toISOString());
    } finally {
      await app.close();
    }
  });
});

test("enforces the environment-specific exact Origin", async () => {
  await withAuthenticationDatabase(async (database) => {
    const result = {
      rawSessionToken: `v2.${Buffer.alloc(32, 0x61).toString("base64url")}`,
      sessionFamilyId: FAMILY_ID,
      userId: 1,
      role: "user" as const,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const loginOperation = async () => result;
    const development = buildApp({
      auth: authDependencies(database, { loginOperation }),
    });
    const production = buildApp({
      auth: authDependencies(database, {
        nodeEnv: "production",
        loginOperation,
      }),
    });

    try {
      for (const origin of [
        undefined,
        "null",
        "https://wrong.example",
        "https://www.siqiapparel.com",
      ]) {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-requested-with": "XMLHttpRequest",
        };
        if (origin !== undefined) {
          headers.origin = origin;
        }
        const response = await development.inject({
          method: "POST",
          url: "/api/auth/login",
          headers,
          payload: { email: "user@example.com", password: PASSWORD },
        });
        assert.equal(response.statusCode, 400);
        assert.deepEqual(response.json(), {
          error: { code: "origin_rejected" },
        });
      }

      const developmentAccepted = await development.inject(
        loginRequest("user@example.com"),
      );
      assert.equal(developmentAccepted.statusCode, 200);

      const productionAccepted = await production.inject({
        ...loginRequest("production@example.com"),
        headers: {
          ...LOGIN_HEADERS,
          origin: "https://www.siqiapparel.com",
        },
      });
      assert.equal(productionAccepted.statusCode, 200);

      const productionRejectsDevelopment = await production.inject(
        loginRequest("production-2@example.com"),
      );
      assert.equal(productionRejectsDevelopment.statusCode, 400);
    } finally {
      await development.close();
      await production.close();
    }
  });
});

test("rejects non-frozen Login headers and additional body fields", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = buildApp({
      auth: authDependencies(database, {
        loginOperation: async () => {
          throw new Error("must not run after request validation");
        },
      }),
    });

    try {
      const missingRequestedWith = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          origin: "http://localhost:5173",
          "content-type": "application/json",
        },
        payload: { email: "user@example.com", password: PASSWORD },
      });
      const contentTypeWithParameters = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          ...LOGIN_HEADERS,
          "content-type": "application/json; charset=utf-8",
        },
        payload: { email: "user@example.com", password: PASSWORD },
      });
      const additionalBodyField = await app.inject({
        ...loginRequest("user@example.com"),
        payload: {
          email: "user@example.com",
          password: PASSWORD,
          extra: true,
        },
      });

      for (const response of [
        missingRequestedWith,
        contentTypeWithParameters,
        additionalBodyField,
      ]) {
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.includes(PASSWORD), false);
      }
    } finally {
      await app.close();
    }
  });
});

test("maps Login failures without exposing infrastructure details", async () => {
  await withAuthenticationDatabase(async (database) => {
    const cases = [
      {
        error: new InvalidCredentialsError(),
        status: 401,
        code: "invalid_credentials",
        retryAfter: undefined,
      },
      {
        error: new Argon2BusyError(),
        status: 503,
        code: "busy",
        retryAfter: "2",
      },
      {
        error: new Error("SQLite fixture detail must not escape"),
        status: 503,
        code: "auth_unavailable",
        retryAfter: undefined,
      },
    ] as const;

    for (const fixture of cases) {
      const app = buildApp({
        auth: authDependencies(database, {
          loginOperation: async () => {
            throw fixture.error;
          },
        }),
      });
      try {
        const response = await app.inject(loginRequest("failure@example.com"));
        assert.equal(response.statusCode, fixture.status);
        assert.deepEqual(response.json(), { error: { code: fixture.code } });
        assert.equal(response.headers["retry-after"], fixture.retryAfter);
        assert.equal(response.body.includes("SQLite"), false);
      } finally {
        await app.close();
      }
    }
  });
});

test("returns uniform invalid credentials for missing, wrong, and disabled users", async () => {
  await withAuthenticationDatabase(async (database) => {
    const passwordHash = await hashPassword(PASSWORD);
    insertAuthenticationUser(database, {
      email: "active@example.com",
      passwordHash,
      status: "active",
    });
    insertAuthenticationUser(database, {
      email: "disabled@example.com",
      passwordHash,
      status: "disabled",
    });
    const app = buildApp({ auth: authDependencies(database) });

    try {
      const responses = await Promise.all([
        app.inject(loginRequest("missing@example.com")),
        app.inject(loginRequest("active@example.com", "wrong-password")),
        app.inject(loginRequest("disabled@example.com")),
      ]);
      for (const response of responses) {
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), {
          error: { code: "invalid_credentials" },
        });
      }
    } finally {
      await app.close();
    }
  });
});

test("maps account rate-limit exhaustion to the frozen 429 response", async () => {
  await withAuthenticationDatabase(async (database) => {
    for (let count = 0; count < LOGIN_ACCOUNT_LIMIT; count += 1) {
      consumeLoginRateLimit(
        database,
        RATE_LIMIT_KEYRING,
        { ip: "127.0.0.1", canonicalEmail: "limited@example.com" },
        { now: () => new Date(NOW) },
      );
    }
    const app = buildApp({
      auth: authDependencies(database, {
        loginOperation: async () => {
          throw new Error("must not run after rate limit");
        },
      }),
    });

    try {
      const response = await app.inject(loginRequest("limited@example.com"));
      assert.equal(response.statusCode, 429);
      assert.deepEqual(response.json(), { error: { code: "rate_limited" } });
      assert.equal(response.headers["retry-after"], undefined);
    } finally {
      await app.close();
    }
  });
});

test("maps every invalid web Session state to the same /me response", async () => {
  await withAuthenticationDatabase(async (database) => {
    const passwordHash = await hashPassword(PASSWORD);
    insertAuthenticationUser(database, {
      email: "session-http@example.com",
      passwordHash,
      status: "active",
    });
    const app = buildApp({ auth: authDependencies(database) });

    try {
      const noCookie = await app.inject({ method: "GET", url: "/api/auth/me" });
      const malformed = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=malformed` },
      });
      for (const response of [noCookie, malformed]) {
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { error: { code: "unauthorized" } });
        assert.equal(response.headers["cache-control"], "no-store");
      }

      const login = await app.inject(loginRequest("session-http@example.com"));
      const setCookie = login.headers["set-cookie"] as string;
      const rawToken = cookieValue(setCookie);
      const requestMe = () =>
        app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${rawToken}` },
        });
      const expectUnauthorized = async (): Promise<void> => {
        const response = await requestMe();
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { error: { code: "unauthorized" } });
      };

      database.prepare("UPDATE sessions SET revoked_at = ?").run(NOW.toISOString());
      await expectUnauthorized();
      database.prepare("UPDATE sessions SET revoked_at = NULL").run();

      database.prepare("UPDATE sessions SET expires_at = ?").run(NOW.toISOString());
      await expectUnauthorized();
      database
        .prepare("UPDATE sessions SET expires_at = ?")
        .run(new Date(NOW.getTime() + 60_000).toISOString());

      database
        .prepare("UPDATE sessions SET last_seen_at = ?")
        .run(new Date(NOW.getTime() - SESSION_IDLE_TTL_MS).toISOString());
      await expectUnauthorized();
      database.prepare("UPDATE sessions SET last_seen_at = ?").run(NOW.toISOString());

      database
        .prepare("UPDATE session_families SET revoked_at = ?")
        .run(NOW.toISOString());
      await expectUnauthorized();
      database.prepare("UPDATE session_families SET revoked_at = NULL").run();

      database.prepare("UPDATE users SET status = 'disabled'").run();
      await expectUnauthorized();
    } finally {
      await app.close();
    }
  });
});

test("does not write HTTP authentication secrets to console logs", async (context) => {
  const log = context.mock.method(console, "log", () => undefined);
  const errorLog = context.mock.method(console, "error", () => undefined);
  const warn = context.mock.method(console, "warn", () => undefined);

  await withAuthenticationDatabase(async (database) => {
    const app = buildApp({
      auth: authDependencies(database, {
        loginOperation: async () => {
          throw new Error("internal-only");
        },
      }),
    });
    try {
      await app.inject(loginRequest("logs@example.com"));
      await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=v2.${Buffer.alloc(32, 0x71).toString("base64url")}`,
        },
      });
    } finally {
      await app.close();
    }
  });

  assert.equal(log.mock.callCount(), 0);
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
});
