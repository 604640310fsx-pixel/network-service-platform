import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseConnection } from "../../src/db.js";
import {
  lookupAuthenticatedPrincipal,
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
const FAMILY_ID = "123e4567-e89b-42d3-a456-426614174000";
const RAW_TOKEN_V1 = `v1.${Buffer.alloc(32, 0x41).toString("base64url")}`;
const RAW_TOKEN_V2 = `v2.${Buffer.alloc(32, 0x42).toString("base64url")}`;
const KEY_V1 = Buffer.alloc(32, 0x31).toString("base64");
const KEY_V2 = Buffer.alloc(32, 0x32).toString("base64");
const KEYRING: TokenHmacKeyring = {
  version: 2,
  keys: { "1": KEY_V1, "2": KEY_V2 },
};

interface SessionFixture {
  readonly rawToken?: string;
  readonly audience?: "web" | "monitor";
  readonly expiresAt?: string;
  readonly lastSeenAt?: string;
  readonly sessionRevokedAt?: string | null;
  readonly familyRevokedAt?: string | null;
  readonly userStatus?: "active" | "disabled";
  readonly role?: "user" | "admin";
}

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function insertSessionFixture(
  database: DatabaseConnection,
  fixture: SessionFixture = {},
): { readonly userId: number; readonly rawToken: string } {
  const rawToken = fixture.rawToken ?? RAW_TOKEN_V1;
  const userId = insertAuthenticationUser(database, {
    email: "session@example.com",
    passwordHash: "$argon2id$fixture-only",
    status: fixture.userStatus ?? "active",
    role: fixture.role ?? "admin",
  });
  database
    .prepare(
      `INSERT INTO session_families (id, user_id, created_at, revoked_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      FAMILY_ID,
      userId,
      iso(-SESSION_TOUCH_INTERVAL_MS * 3),
      fixture.familyRevokedAt ?? null,
    );
  const token = computeSessionTokenHash(rawToken, KEYRING);
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
      userId,
      FAMILY_ID,
      fixture.audience ?? "web",
      iso(-SESSION_TOUCH_INTERVAL_MS * 3),
      fixture.expiresAt ?? iso(60_000),
      fixture.lastSeenAt ?? iso(-SESSION_TOUCH_INTERVAL_MS * 2),
      fixture.sessionRevokedAt ?? null,
    );

  return { userId, rawToken };
}

function lookup(
  database: DatabaseConnection,
  rawToken: string,
  audience: "web" | "monitor" = "web",
  keyring: TokenHmacKeyring = KEYRING,
) {
  return lookupAuthenticatedPrincipal(
    database,
    rawToken,
    audience,
    keyring,
    { now: () => new Date(NOW) },
  );
}

function readLastSeen(database: DatabaseConnection): string {
  const rows = database
    .prepare("SELECT last_seen_at FROM sessions")
    .all() as Array<{ readonly last_seen_at: string }>;
  assert.equal(rows.length, 1);
  return rows[0]?.last_seen_at ?? "";
}

test("looks up a valid web Session and returns only the internal principal", async () => {
  await withAuthenticationDatabase((database) => {
    const { userId, rawToken } = insertSessionFixture(database);
    const principal = lookup(database, rawToken);

    assert.deepEqual(principal, {
      sessionId: 1,
      userId,
      sessionFamilyId: FAMILY_ID,
      audience: "web",
      email: "session@example.com",
      role: "admin",
    });
    assert.equal("rawToken" in (principal ?? {}), false);
    assert.equal("tokenHash" in (principal ?? {}), false);
    assert.equal(readLastSeen(database), NOW.toISOString());
    assert.equal(
      JSON.stringify(database.prepare("SELECT * FROM sessions").all()).includes(rawToken),
      false,
    );
  });
});

test("fails closed for malformed tokens, unknown versions, and hash mismatches", async () => {
  await withAuthenticationDatabase((database) => {
    insertSessionFixture(database);
    const unknownVersion = `v9.${Buffer.alloc(32, 0x49).toString("base64url")}`;
    const mismatched = `v1.${Buffer.alloc(32, 0x48).toString("base64url")}`;

    assert.equal(lookup(database, "invalid"), null);
    assert.equal(lookup(database, unknownVersion), null);
    assert.equal(lookup(database, mismatched), null);
  });
});

test("binds lookup to the requested audience without fallback", async () => {
  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database, { audience: "web" });

    assert.equal(lookup(database, rawToken, "monitor"), null);
    assert.equal(lookup(database, rawToken, "web")?.audience, "web");
  });
});

test("rejects expiry and idle values exactly at their strict cutoffs", async () => {
  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database, {
      expiresAt: NOW.toISOString(),
    });
    assert.equal(lookup(database, rawToken), null);
  });

  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database, {
      lastSeenAt: iso(-SESSION_IDLE_TTL_MS),
    });
    assert.equal(lookup(database, rawToken), null);
  });
});

test("rejects revoked Sessions and revoked families", async () => {
  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database, {
      sessionRevokedAt: iso(-1),
    });
    assert.equal(lookup(database, rawToken), null);
  });

  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database, {
      familyRevokedAt: iso(-1),
    });
    assert.equal(lookup(database, rawToken), null);
  });
});

test("rejects a Session owned by a non-active user", async () => {
  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database, {
      userStatus: "disabled",
    });
    assert.equal(lookup(database, rawToken), null);
  });
});

test("verifies a legal old-version Session with only its prefixed key", async () => {
  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database, {
      rawToken: RAW_TOKEN_V1,
    });
    const requestedKeys: string[] = [];
    const keys = new Proxy(KEYRING.keys, {
      get(target, property, receiver) {
        if (typeof property === "string") {
          requestedKeys.push(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const rotatedKeyring: TokenHmacKeyring = { version: 2, keys };

    assert.equal(lookup(database, rawToken, "web", rotatedKeyring)?.userId, 1);
    assert.deepEqual(requestedKeys, ["1"]);
  });
});

test("does not touch last_seen_at at the exact touch cutoff or when fresher", async () => {
  await withAuthenticationDatabase((database) => {
    const cutoff = iso(-SESSION_TOUCH_INTERVAL_MS);
    const { rawToken } = insertSessionFixture(database, { lastSeenAt: cutoff });

    assert.notEqual(lookup(database, rawToken), null);
    assert.equal(readLastSeen(database), cutoff);
  });

  await withAuthenticationDatabase((database) => {
    const fresh = iso(-SESSION_TOUCH_INTERVAL_MS + 1);
    const { rawToken } = insertSessionFixture(database, { lastSeenAt: fresh });

    assert.notEqual(lookup(database, rawToken), null);
    assert.equal(readLastSeen(database), fresh);
  });
});

test("does not log raw Session tokens on success or failure", async (context) => {
  const log = context.mock.method(console, "log", () => undefined);
  const errorLog = context.mock.method(console, "error", () => undefined);
  const warn = context.mock.method(console, "warn", () => undefined);

  await withAuthenticationDatabase((database) => {
    const { rawToken } = insertSessionFixture(database);
    assert.notEqual(lookup(database, rawToken), null);
    assert.equal(lookup(database, RAW_TOKEN_V2), null);
  });

  assert.equal(log.mock.callCount(), 0);
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
});
