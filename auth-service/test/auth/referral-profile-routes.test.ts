import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { ReferralHttpDependencies } from "../../src/http/referral-routes.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import type { RateLimitKeyring } from "../../src/http/rate-limit.js";
import {
  ensureReferralProfile,
  readReferralProfile,
} from "../../src/referral/profile.js";
import { createReferralPublicRateLimiter } from "../../src/referral/public-resolution.js";
import {
  computeSessionTokenHash,
  type TokenHmacKeyring,
} from "../../src/session/session-token.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const NOW = new Date("2026-09-22T03:04:05.678Z");
const TOKEN_KEYRING: TokenHmacKeyring = {
  version: 1,
  keys: { "1": Buffer.alloc(32, 0x21).toString("base64") },
};
const RATE_LIMIT_KEYRING: RateLimitKeyring = {
  version: 1,
  keys: { "1": Buffer.alloc(32, 0x31).toString("base64") },
};
const CSRF_SIGNING_KEY = Buffer.alloc(32, 0x41);
const ORIGIN = "http://localhost:5173";

function byteSource(...bytes: readonly number[]): (size: number) => Buffer {
  let index = 0;
  return (size) => {
    const byte = bytes[index];
    index += 1;
    if (byte === undefined) throw new Error("unexpected random source call");
    return Buffer.alloc(size, byte);
  };
}

function insertSession(
  database: DatabaseConnection,
  userId: number,
  familyId: string,
  tokenByte: number,
): { readonly rawToken: string; readonly tokenHash: string } {
  const rawToken = `v1.${Buffer.alloc(32, tokenByte).toString("base64url")}`;
  const token = computeSessionTokenHash(rawToken, TOKEN_KEYRING);
  database
    .prepare(
      `INSERT INTO session_families (id, user_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(familyId, userId, new Date(NOW.getTime() - 60_000).toISOString());
  database
    .prepare(
      `INSERT INTO sessions (
         token_hash, hmac_key_version, user_id, session_family_id, audience,
         created_at, expires_at, last_seen_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'web', ?, ?, ?, NULL)`,
    )
    .run(
      token.tokenHash,
      token.hmacKeyVersion,
      userId,
      familyId,
      new Date(NOW.getTime() - 60_000).toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
      new Date(NOW.getTime() - 30_000).toISOString(),
    );
  return { rawToken, tokenHash: token.tokenHash };
}

function referralDependencies(
  database: DatabaseConnection,
  overrides: Partial<ReferralHttpDependencies> = {},
): ReferralHttpDependencies {
  return {
    database,
    nodeEnv: "test",
    tokenHmacKeyring: TOKEN_KEYRING,
    rateLimitKeyring: RATE_LIMIT_KEYRING,
    csrfSigningKey: CSRF_SIGNING_KEY,
    publicLink: { enabled: false },
    now: () => new Date(NOW),
    randomBytes: byteSource(0x51, 0x52, 0x53, 0x54),
    ...overrides,
  };
}

function totalChanges(database: DatabaseConnection): number {
  const row = database.prepare("SELECT total_changes() AS count").all()[0] as
    | { readonly count: number }
    | undefined;
  assert.ok(row !== undefined);
  return row.count;
}

function stateRequest(rawToken?: string) {
  return {
    method: "GET" as const,
    url: "/api/me/referral",
    headers:
      rawToken === undefined
        ? undefined
        : { cookie: `__Host-web_session=${rawToken}` },
  };
}

function createRequest(rawToken: string, csrfToken?: string) {
  return {
    method: "POST" as const,
    url: "/api/me/referral/profile",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      cookie: `__Host-web_session=${rawToken}`,
      ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
    },
    payload: {},
  };
}

test("profile issuance is retry-idempotent and retries opaque-code collisions", async () => {
  await withAuthenticationDatabase((database) => {
    const firstUserId = insertAuthenticationUser(database, {
      email: "first-referral@example.test",
      passwordHash: "hash",
      status: "active",
    });
    const secondUserId = insertAuthenticationUser(database, {
      email: "second-referral@example.test",
      passwordHash: "hash",
      status: "active",
    });

    const first = ensureReferralProfile(database, firstUserId, {
      now: () => new Date(NOW),
      randomBytes: byteSource(0x61),
    });
    const retry = ensureReferralProfile(database, firstUserId, {
      now: () => {
        throw new Error("retry must not replace created_at");
      },
      randomBytes: () => {
        throw new Error("retry must not allocate another code");
      },
    });
    assert.deepEqual(retry, first);

    const second = ensureReferralProfile(database, secondUserId, {
      now: () => new Date(NOW),
      randomBytes: byteSource(0x61, 0x62),
    });
    assert.notEqual(second.publicCode, first.publicCode);
    assert.match(first.publicCode, /^[A-Za-z0-9_-]{24}$/);
    assert.match(second.publicCode, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(first.publicCode.includes("first-referral"), false);
    assert.equal(second.publicCode.includes("second-referral"), false);
    assert.equal(
      (database
        .prepare("SELECT COUNT(*) AS count FROM referral_profiles")
        .all()[0] as { readonly count: number }).count,
      2,
    );
  });
});

test("GET is authenticated, session-isolated, and performs zero database writes", async () => {
  await withAuthenticationDatabase(async (database) => {
    const firstUserId = insertAuthenticationUser(database, {
      email: "get-first@example.test",
      passwordHash: "hash",
      status: "active",
    });
    const secondUserId = insertAuthenticationUser(database, {
      email: "get-second@example.test",
      passwordHash: "hash",
      status: "active",
    });
    const firstSession = insertSession(
      database,
      firstUserId,
      "123e4567-e89b-42d3-a456-426614174001",
      0x31,
    );
    const secondSession = insertSession(
      database,
      secondUserId,
      "123e4567-e89b-42d3-a456-426614174002",
      0x32,
    );
    const firstProfile = ensureReferralProfile(database, firstUserId, {
      now: () => new Date(NOW),
      randomBytes: byteSource(0x71),
    });
    const app = buildApp({ referral: referralDependencies(database) });

    try {
      const unauthenticated = await app.inject(stateRequest());
      assert.equal(unauthenticated.statusCode, 401);
      assert.deepEqual(unauthenticated.json(), {
        error: { code: "unauthorized" },
      });

      const before = totalChanges(database);
      const first = await app.inject(stateRequest(firstSession.rawToken));
      assert.equal(first.statusCode, 200);
      assert.equal(first.headers["cache-control"], "no-store");
      assert.equal(totalChanges(database), before);
      assert.deepEqual(first.json().profile, firstProfile);
      assert.deepEqual(first.json().link, {
        status: "unavailable",
        reason: "public_route_unconfigured",
      });

      const second = await app.inject(stateRequest(secondSession.rawToken));
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().profile, null);
      assert.equal(totalChanges(database), before);
      assert.equal(
        (database
          .prepare("SELECT COUNT(*) AS count FROM referral_profiles")
          .all()[0] as { readonly count: number }).count,
        1,
      );
    } finally {
      await app.close();
    }
  });
});

test("trusted public configuration issues a ready link without using request host or origin", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "trusted-referral@example.test",
      passwordHash: "hash",
      status: "active",
    });
    const session = insertSession(
      database,
      userId,
      "123e4567-e89b-42d3-a456-426614174004",
      0x34,
    );
    const profile = ensureReferralProfile(database, userId, {
      now: () => new Date(NOW),
      randomBytes: byteSource(0x72),
    });
    const app = buildApp({
      referral: referralDependencies(database, {
        publicLink: {
          enabled: true,
          origin: "http://127.0.0.1:41783",
          path: "/referral.html",
        },
      }),
    });

    try {
      const response = await app.inject({
        ...stateRequest(session.rawToken),
        headers: {
          cookie: `__Host-web_session=${session.rawToken}`,
          host: "attacker.example",
          origin: "https://attacker.example",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().link, {
        status: "ready",
        url: `http://127.0.0.1:41783/referral.html?code=${profile.publicCode}`,
      });
      assert.equal(response.body.includes("attacker.example"), false);
    } finally {
      await app.close();
    }
  });
});

test("public resolution is read-only, non-enumerating beyond validity, and returns no PII", async () => {
  await withAuthenticationDatabase(async (database) => {
    const email = "public-resolution@example.test";
    const userId = insertAuthenticationUser(database, {
      email,
      passwordHash: "hash",
      status: "active",
    });
    const profile = ensureReferralProfile(database, userId, {
      now: () => new Date(NOW),
      randomBytes: byteSource(0x73),
    });
    database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId);
    const app = buildApp({ referral: referralDependencies(database) });

    try {
      const before = totalChanges(database);
      const valid = await app.inject({
        method: "GET",
        url: `/api/public/referral?code=${profile.publicCode}`,
        headers: {
          host: "attacker.example",
          origin: "https://attacker.example",
        },
      });
      assert.equal(valid.statusCode, 200);
      assert.equal(valid.headers["cache-control"], "no-store");
      assert.deepEqual(valid.json(), { valid: true });
      assert.equal(valid.headers.location, undefined);
      assert.equal(valid.headers["set-cookie"], undefined);
      assert.equal(valid.body.includes(email), false);
      assert.equal(valid.body.includes(profile.publicCode), false);
      assert.equal(valid.body.includes(NOW.toISOString()), false);

      const invalidRequests = [
        "/api/public/referral",
        "/api/public/referral?code=short",
        `/api/public/referral?code=${"Z".repeat(24)}`,
        `/api/public/referral?code=${profile.publicCode}&next=https%3A%2F%2Fattacker.example`,
        `/api/public/referral?code=${profile.publicCode}&code=${profile.publicCode}`,
      ];
      const invalidResponses = await Promise.all(
        invalidRequests.map((url) =>
          app.inject({ method: "GET", url, headers: { host: "attacker.example" } }),
        ),
      );
      for (const response of invalidResponses) {
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { valid: false });
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers.location, undefined);
        assert.equal(response.headers["set-cookie"], undefined);
      }
      assert.equal(totalChanges(database), before);
    } finally {
      await app.close();
    }
  });
});

test("public resolution rate limit is identical for valid and invalid codes and writes no database rows", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "public-rate-limit@example.test",
      passwordHash: "hash",
      status: "active",
    });
    const profile = ensureReferralProfile(database, userId, {
      now: () => new Date(NOW),
      randomBytes: byteSource(0x74),
    });
    const limiter = createReferralPublicRateLimiter(RATE_LIMIT_KEYRING, {
      limit: 2,
      now: () => new Date(NOW),
    });
    const app = buildApp({
      referral: referralDependencies(database, { publicRateLimiter: limiter }),
    });

    try {
      const before = totalChanges(database);
      const headers = { "x-forwarded-for": "192.0.2.10" };
      assert.equal(
        (await app.inject({
          method: "GET",
          url: `/api/public/referral?code=${profile.publicCode}`,
          headers,
        })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({
          method: "GET",
          url: "/api/public/referral?code=malformed",
          headers,
        })).statusCode,
        200,
      );
      const limitedValid = await app.inject({
        method: "GET",
        url: `/api/public/referral?code=${profile.publicCode}`,
        headers,
      });
      const limitedInvalid = await app.inject({
        method: "GET",
        url: "/api/public/referral?code=malformed",
        headers,
      });
      assert.equal(limitedValid.statusCode, 429);
      assert.equal(limitedInvalid.statusCode, 429);
      assert.deepEqual(limitedValid.json(), { error: { code: "rate_limited" } });
      assert.deepEqual(limitedInvalid.json(), limitedValid.json());
      assert.equal(totalChanges(database), before);
    } finally {
      await app.close();
    }
  });
});

test("POST requires exact origin, XHR, authenticated CSRF and is concurrent-idempotent", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "post-referral@example.test",
      passwordHash: "hash",
      status: "active",
    });
    const session = insertSession(
      database,
      userId,
      "123e4567-e89b-42d3-a456-426614174003",
      0x33,
    );
    const csrfToken = issueCsrfToken(CSRF_SIGNING_KEY, session.tokenHash);
    const app = buildApp({ referral: referralDependencies(database) });

    try {
      const unauthenticated = await app.inject(
        createRequest(
          `v1.${Buffer.alloc(32, 0x7a).toString("base64url")}`,
          "A".repeat(43),
        ),
      );
      assert.equal(unauthenticated.statusCode, 401);
      assert.deepEqual(unauthenticated.json(), {
        error: { code: "unauthorized" },
      });

      const noCsrf = await app.inject(createRequest(session.rawToken));
      assert.equal(noCsrf.statusCode, 403);
      assert.equal(readReferralProfile(database, userId), null);

      const noXhrRequest = createRequest(session.rawToken, csrfToken);
      const { "x-requested-with": _discarded, ...noXhrHeaders } =
        noXhrRequest.headers;
      const noXhr = await app.inject({
        ...noXhrRequest,
        headers: noXhrHeaders,
      });
      assert.equal(noXhr.statusCode, 400);
      assert.deepEqual(noXhr.json(), { error: { code: "invalid_request" } });
      assert.equal(readReferralProfile(database, userId), null);

      const wrongOriginRequest = createRequest(session.rawToken, csrfToken);
      const wrongOrigin = await app.inject({
        ...wrongOriginRequest,
        headers: { ...wrongOriginRequest.headers, origin: "https://wrong.example" },
      });
      assert.equal(wrongOrigin.statusCode, 400);
      assert.equal(readReferralProfile(database, userId), null);

      const responses = await Promise.all(
        Array.from({ length: 16 }, () =>
          app.inject(createRequest(session.rawToken, csrfToken)),
        ),
      );
      const bodies = responses.map((response) => {
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["cache-control"], "no-store");
        return response.json();
      });
      assert.ok(bodies.every((body) => body.profile.publicCode === bodies[0].profile.publicCode));
      assert.equal(
        (database
          .prepare("SELECT COUNT(*) AS count FROM referral_profiles")
          .all()[0] as { readonly count: number }).count,
        1,
      );

      const responseText = JSON.stringify(bodies[0]);
      assert.equal(responseText.includes("post-referral@example.test"), false);
      assert.equal(responseText.includes(session.rawToken), false);
      assert.equal(responseText.includes(session.tokenHash), false);
      assert.equal(responseText.includes(csrfToken), false);
      assert.deepEqual(bodies[0].program.productCap, { status: "unconfigured" });
      assert.deepEqual(bodies[0].program.withdrawn, { status: "not_integrated" });
      assert.deepEqual(bodies[0].program.commission, { status: "not_integrated" });
      assert.deepEqual(bodies[0].program.refunds, { status: "not_integrated" });
      assert.deepEqual(bodies[0].program.settlement, { status: "not_integrated" });
      assert.equal("withdrawnFen" in bodies[0].program, false);
      assert.deepEqual(
        bodies[0].program.tiers.map(
          (tier: { minSalesFen: number; maxSalesFen: number | null; rateBps: number }) => tier,
        ),
        [
          { minSalesFen: 5_900, maxSalesFen: 99_899, rateBps: 1_000 },
          { minSalesFen: 99_900, maxSalesFen: 199_899, rateBps: 1_500 },
          { minSalesFen: 199_900, maxSalesFen: 399_899, rateBps: 2_000 },
          { minSalesFen: 399_900, maxSalesFen: null, rateBps: 3_000 },
        ],
      );
      assert.equal(bodies[0].program.withdrawalThresholdFen, 100_000);
    } finally {
      await app.close();
    }
  });
});
