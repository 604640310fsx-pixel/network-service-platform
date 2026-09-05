import assert from "node:assert/strict";
import test from "node:test";

import {
  CSRF_TOKEN_LENGTH,
  issueCsrfToken,
} from "../../src/http/csrf.js";
import {
  computeRateLimitBucketKey,
  consumeLoginRateLimit,
  consumeRegistrationResendRateLimit,
  withRegistrationStartRateLimit,
  LOGIN_ACCOUNT_LIMIT,
  LOGIN_IP_LIMIT,
  REGISTRATION_RESEND_EMAIL_LIMIT,
  REGISTRATION_START_EMAIL_LIMIT,
  RateLimitExceededError,
  type RateLimitKeyring,
} from "../../src/http/rate-limit.js";
import { withAuthenticationDatabase } from "./helpers.js";

const NOW = new Date("2026-08-18T12:02:03.000Z");
const KEYRING: RateLimitKeyring = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x31).toString("base64"),
    "2": Buffer.alloc(32, 0x32).toString("base64"),
  },
};

test("matches frozen CSRF and rate-limit derivation vectors", () => {
  const csrf = issueCsrfToken(
    Buffer.alloc(32, 0x33),
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  assert.equal(csrf, "GIhObSAHxvxYv0ePFMOrDMRwqdmbSTi03GrR8yD2FYk");
  assert.equal(csrf.length, CSRF_TOKEN_LENGTH);

  const bucket = computeRateLimitBucketKey(
    KEYRING,
    2,
    "login:account",
    "user@example.com",
  );
  assert.equal(bucket, "gHeGioL7_wHps7P49VGXRWqA56MJ_RswAD7IgjKHzPw");
  assert.equal(bucket.length, 43);
});

test("registration start silently suppresses email excess and rolls back callback failures", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = { now: () => new Date(NOW) };
    for (let count = 0; count < REGISTRATION_START_EMAIL_LIMIT; count += 1) {
      assert.deepEqual(
        withRegistrationStartRateLimit(
          database,
          KEYRING,
          {
            ip: `192.0.2.${count + 1}`,
            inviteHashIdentifiers: [`invite-${count}`],
          },
          (control) => control.consumeEmail("registration@example.com"),
          dependencies,
        ),
        { emailSilenced: false },
      );
    }
    assert.deepEqual(
      withRegistrationStartRateLimit(
        database,
        KEYRING,
        {
          ip: "192.0.2.250",
          inviteHashIdentifiers: ["unused-invite"],
        },
        (control) => control.consumeEmail("registration@example.com"),
        dependencies,
      ),
      { emailSilenced: true },
    );
    const rowsBefore = database
      .prepare("SELECT COUNT(*) AS total FROM rate_limit_buckets")
      .all()[0] as { readonly total: number };
    assert.throws(
      () =>
        withRegistrationStartRateLimit(
          database,
          KEYRING,
          {
            ip: "192.0.2.251",
            inviteHashIdentifiers: ["rollback-invite"],
          },
          () => {
            throw new Error("rollback probe");
          },
          dependencies,
        ),
      /rollback probe/,
    );
    const rowsAfter = database
      .prepare("SELECT COUNT(*) AS total FROM rate_limit_buckets")
      .all()[0] as { readonly total: number };
    assert.equal(rowsAfter.total, rowsBefore.total);
  });
});

test("registration resend silently suppresses email excess while retaining IP accounting", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = { now: () => new Date(NOW) };
    for (let count = 0; count < REGISTRATION_RESEND_EMAIL_LIMIT; count += 1) {
      assert.deepEqual(
        consumeRegistrationResendRateLimit(
          database,
          KEYRING,
          { ip: "192.0.2.90", canonicalEmail: "resend@example.com" },
          dependencies,
        ),
        { emailSilenced: false },
      );
    }
    assert.deepEqual(
      consumeRegistrationResendRateLimit(
        database,
        KEYRING,
        { ip: "192.0.2.90", canonicalEmail: "resend@example.com" },
        dependencies,
      ),
      { emailSilenced: true },
    );
    const ipKey = computeRateLimitBucketKey(
      KEYRING,
      KEYRING.version,
      "register:resend:ip",
      "192.0.2.90",
    );
    const row = database
      .prepare(
        "SELECT count FROM rate_limit_buckets WHERE bucket_key = ?",
      )
      .all(ipKey)[0] as { readonly count: number };
    assert.equal(row.count, REGISTRATION_RESEND_EMAIL_LIMIT + 1);
  });
});

test("enforces account and IP limits with independent buckets", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = { now: () => new Date(NOW) };

    for (let count = 0; count < LOGIN_ACCOUNT_LIMIT; count += 1) {
      consumeLoginRateLimit(
        database,
        KEYRING,
        { ip: "192.0.2.10", canonicalEmail: "first@example.com" },
        dependencies,
      );
    }
    assert.throws(
      () =>
        consumeLoginRateLimit(
          database,
          KEYRING,
          { ip: "192.0.2.10", canonicalEmail: "first@example.com" },
          dependencies,
        ),
      RateLimitExceededError,
    );

    for (let count = LOGIN_ACCOUNT_LIMIT; count < LOGIN_IP_LIMIT; count += 1) {
      consumeLoginRateLimit(
        database,
        KEYRING,
        {
          ip: "192.0.2.10",
          canonicalEmail: `other-${count}@example.com`,
        },
        dependencies,
      );
    }
    assert.throws(
      () =>
        consumeLoginRateLimit(
          database,
          KEYRING,
          { ip: "192.0.2.10", canonicalEmail: "last@example.com" },
          dependencies,
        ),
      RateLimitExceededError,
    );

    assert.doesNotThrow(() =>
      consumeLoginRateLimit(
        database,
        KEYRING,
        { ip: "192.0.2.11", canonicalEmail: "last@example.com" },
        dependencies,
      ),
    );
  });
});

test("reads only current and nearest previous keys and writes current buckets", async () => {
  await withAuthenticationDatabase((database) => {
    const requested: string[] = [];
    const keys = new Proxy(
      {
        "0": Buffer.alloc(32, 0x30).toString("base64"),
        "1": Buffer.alloc(32, 0x31).toString("base64"),
        "2": Buffer.alloc(32, 0x32).toString("base64"),
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            requested.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const keyring: RateLimitKeyring = { version: 2, keys };

    consumeLoginRateLimit(
      database,
      keyring,
      { ip: "::ffff:192.0.2.20", canonicalEmail: "user@example.com" },
      { now: () => new Date(NOW) },
    );

    assert.equal(requested.includes("0"), false);
    assert.equal(requested.includes("1"), true);
    assert.equal(requested.includes("2"), true);
    const rows = database
      .prepare("SELECT bucket_key, window_start, count FROM rate_limit_buckets")
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      new Set(rows.map((row) => row.window_start)),
      new Set(["2026-08-18T12:00:00.000Z"]),
    );
    assert.deepEqual(new Set(rows.map((row) => row.count)), new Set([1]));
  });
});
