import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { computeInviteCodeHash } from "../../src/registration/invite-code.js";
import {
  computeMailRecipientAuditHmac,
  decryptRegistrationOtpPayload,
} from "../../src/registration/mail-outbox.js";
import {
  computeRegistrationOtpHash,
  computeRegistrationTokenHash,
  generateRegistrationToken,
} from "../../src/registration/registration-crypto.js";
import type { RegistrationServiceKeyrings } from "../../src/registration/registration-service.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const INVITE_CODE = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567";
const EMAIL = "registration.user@example.com";
const PASSWORD = "temporary-password-123";
const TOKEN_KEYS = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x11).toString("base64"),
    "2": Buffer.alloc(32, 0x12).toString("base64"),
  },
};
const INVITE_KEYS = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x21).toString("base64"),
    "2": Buffer.alloc(32, 0x22).toString("base64"),
  },
};
const MAIL_KEYS = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x31).toString("base64"),
    "2": Buffer.alloc(32, 0x32).toString("base64"),
  },
};
const RATE_KEYS = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x41).toString("base64"),
    "2": Buffer.alloc(32, 0x42).toString("base64"),
  },
};
const KEYRINGS: RegistrationServiceKeyrings = {
  tokenHmacKeyring: TOKEN_KEYS,
  inviteHmacKeyring: INVITE_KEYS,
  mailPayloadEncKeyring: MAIL_KEYS,
  rateLimitKeyring: RATE_KEYS,
};
const HEADERS = {
  origin: "http://localhost:5173",
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
};
const TEST_INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface OutboxRow {
  readonly idempotency_key: string;
  readonly to_email: string;
  readonly template: "verification_code";
  readonly key_version: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

function firstNumber(database: DatabaseConnection, source: string): number {
  const row = database.prepare(source).all()[0] as
    | Record<string, unknown>
    | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "number") {
    throw new TypeError("query did not return a number");
  }
  return value;
}

function insertInvite(
  database: DatabaseConnection,
  recipientEmail = EMAIL,
  inviteCode = INVITE_CODE,
  expiresAt = "2026-08-21T00:00:00.000Z",
): number {
  const creatorRows = database
    .prepare("SELECT id FROM users WHERE email = 'registration-admin@example.com'")
    .all() as Array<{ readonly id: number }>;
  const creatorId =
    creatorRows[0]?.id ??
    insertAuthenticationUser(database, {
      email: "registration-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
  const codeHash = computeInviteCodeHash(
    inviteCode,
    INVITE_KEYS,
    INVITE_KEYS.version,
  );
  database
    .prepare(
      `INSERT INTO invite_codes (
         code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
         expires_at, revoked_at, note, created_at, recipient_email
       ) VALUES (?, 0, ?, 1, 0, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      codeHash,
      creatorId,
      expiresAt,
      "2026-08-20T00:00:00.000Z",
      recipientEmail,
    );
  return firstNumber(
    database,
    `SELECT id FROM invite_codes WHERE code_hash = '${codeHash}'`,
  );
}

function inviteCodeForIndex(index: number): string {
  const character = TEST_INVITE_ALPHABET[index];
  if (character === undefined) {
    throw new RangeError("test invite index is out of range");
  }
  return Array.from({ length: 7 }, () => character.repeat(4)).join("-");
}

function insertVerifiedPending(
  database: DatabaseConnection,
  options: {
    readonly email: string;
    readonly inviteCode: string;
    readonly tokenByte: number;
    readonly expiresAt?: string;
  },
): {
  readonly inviteCodeId: number;
  readonly registrationToken: string;
} {
  const inviteCodeId = insertInvite(
    database,
    options.email,
    options.inviteCode,
    options.expiresAt,
  );
  const token = generateRegistrationToken(
    TOKEN_KEYS,
    (size) => Buffer.alloc(size, options.tokenByte),
  );
  const now = "2026-08-20T12:00:00.000Z";
  database
    .prepare(
      `INSERT INTO pending_registrations (
         email, registration_token_hash, registration_token_key_version,
         invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
         verified_at, attempts, resend_count, last_sent_at, expires_at,
         consumed_at, superseded_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'verified', ?, 0, 1, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      options.email,
      token.tokenHash,
      token.hmacKeyVersion,
      inviteCodeId,
      computeRegistrationOtpHash("123456", TOKEN_KEYS.version, TOKEN_KEYS),
      TOKEN_KEYS.version,
      now,
      now,
      "2026-08-20T12:10:00.000Z",
      now,
    );
  return {
    inviteCodeId,
    registrationToken: token.rawToken,
  };
}

function latestOtp(database: DatabaseConnection): string {
  const row = database
    .prepare(
      `SELECT idempotency_key, to_email, template, key_version,
              nonce, ciphertext, tag
       FROM mail_outbox ORDER BY idempotency_key DESC LIMIT 1`,
    )
    .all()[0] as OutboxRow | undefined;
  assert.ok(row);
  return decryptRegistrationOtpPayload(
    {
      idempotencyKey: row.idempotency_key,
      toEmail: row.to_email,
      template: row.template,
      keyVersion: row.key_version,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      tag: row.tag,
    },
    MAIL_KEYS,
  );
}

test("runs start, resend, verify, and complete through the frozen HTTP state machine", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sourceUserId = insertAuthenticationUser(database, {
      email: "referral.source@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const referralCode = "R".repeat(24);
    database
      .prepare(
        `INSERT INTO referral_profiles (user_id, public_code, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(sourceUserId, referralCode, "2026-08-20T00:00:00.000Z");
    insertInvite(database);
    let now = new Date("2026-08-20T12:00:00.000Z");
    let tokenCounter = 0x50;
    const otpValues = [123_456, 654_321];
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date(now),
          randomBytes: (size) => Buffer.alloc(size, tokenCounter++),
          randomInt: () => otpValues.shift() ?? 111_111,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0x61),
        },
      },
    });

    try {
      const start = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: {
          email: `  ${EMAIL.toUpperCase()}  `,
          inviteCode: INVITE_CODE,
          referralCode,
        },
      });
      assert.equal(start.statusCode, 200);
      assert.equal(start.headers["cache-control"], "no-store");
      const firstToken = start.json<{ registrationToken: string }>()
        .registrationToken;
      assert.match(firstToken, /^v2\.[A-Za-z0-9_-]{43}$/);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 1);
      assert.equal(
        firstNumber(
          database,
          `SELECT COUNT(*) FROM pending_registrations
           WHERE referral_source_profile_id = (
             SELECT id FROM referral_profiles WHERE public_code = '${referralCode}'
           )`,
        ),
        1,
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 1);
      assert.equal(latestOtp(database), "123456");

      const immediateResend = await app.inject({
        method: "POST",
        url: "/api/auth/register/resend-code",
        headers: HEADERS,
        payload: { registrationToken: firstToken },
      });
      assert.equal(immediateResend.statusCode, 200);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 1);

      now = new Date("2026-08-20T12:02:00.000Z");
      const resend = await app.inject({
        method: "POST",
        url: "/api/auth/register/resend-code",
        headers: HEADERS,
        payload: { registrationToken: firstToken },
      });
      assert.equal(resend.statusCode, 200);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 2);
      assert.equal(latestOtp(database), "654321");

      const wrongOtp = await app.inject({
        method: "POST",
        url: "/api/auth/register/verify-code",
        headers: HEADERS,
        payload: { registrationToken: firstToken, otp: "000000" },
      });
      assert.equal(wrongOtp.statusCode, 400);
      assert.deepEqual(wrongOtp.json(), {
        error: { code: "invalid_or_expired" },
      });

      const verify = await app.inject({
        method: "POST",
        url: "/api/auth/register/verify-code",
        headers: HEADERS,
        payload: { registrationToken: firstToken, otp: "654321" },
      });
      assert.equal(verify.statusCode, 200);
      const verifiedToken = verify.json<{ registrationToken: string }>()
        .registrationToken;
      assert.notEqual(verifiedToken, firstToken);

      const oldToken = await app.inject({
        method: "POST",
        url: "/api/auth/register/complete",
        headers: HEADERS,
        payload: {
          registrationToken: firstToken,
          password: PASSWORD,
          confirmPassword: PASSWORD,
        },
      });
      assert.equal(oldToken.statusCode, 400);

      const complete = await app.inject({
        method: "POST",
        url: "/api/auth/register/complete",
        headers: HEADERS,
        payload: {
          registrationToken: verifiedToken,
          password: PASSWORD,
          confirmPassword: PASSWORD,
        },
      });
      assert.equal(complete.statusCode, 200);
      assert.deepEqual(complete.json(), { status: "ok" });
      assert.equal(
        firstNumber(
          database,
          `SELECT COUNT(*) FROM users WHERE email = '${EMAIL}'`,
        ),
        1,
      );
      assert.equal(
        firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"),
        1,
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT source_profile_id, status, created_at
             FROM referral_attribution_candidates`,
          )
          .all(),
        [
          {
            source_profile_id: firstNumber(
              database,
              "SELECT id FROM referral_profiles WHERE public_code = ?",
              referralCode,
            ),
            status: "pending",
            created_at: now.toISOString(),
          },
        ],
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 1);
      assert.deepEqual(
        database
          .prepare(
            `SELECT actor, action, target_ref, result_class, recipient_hmac
             FROM audit_log`,
          )
          .all(),
        [
          {
            actor: "system:invite",
            action: "invite_code.redeem",
            target_ref: null,
            result_class: "redeemed",
            recipient_hmac: computeMailRecipientAuditHmac(
              EMAIL,
              MAIL_KEYS,
              MAIL_KEYS.version,
            ),
          },
        ],
      );
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM pending_registrations WHERE phase = 'completed' AND consumed_at IS NOT NULL",
        ),
        1,
      );
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM invite_codes WHERE used_count = 1",
        ),
        1,
      );
      assert.equal(
        firstNumber(
          database,
          `SELECT COUNT(*) FROM pending_registrations
           WHERE registration_token_hash IN ('${firstToken}', '${verifiedToken}')`,
        ),
        0,
      );
      assert.equal(
        computeRegistrationTokenHash(verifiedToken, TOKEN_KEYS).tokenHash.length,
        43,
      );
    } finally {
      await app.close();
    }
  });
});

test("returns a format-valid fake token for an unusable invite without persistence", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date("2026-08-20T12:00:00.000Z"),
          randomBytes: (size) => Buffer.alloc(size, 0x71),
          randomInt: () => 123_456,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0x72),
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: {
          email: EMAIL,
          inviteCode: "2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.match(
        response.json<{ registrationToken: string }>().registrationToken,
        /^v2\.[A-Za-z0-9_-]{43}$/,
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 0);
    } finally {
      await app.close();
    }
  });
});

test("ignores an invalid referral code without changing invite-gated registration", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertInvite(database);
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date("2026-08-20T12:00:00.000Z"),
          randomBytes: (size) => Buffer.alloc(size, 0x74),
          randomInt: () => 123_456,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0x75),
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: {
          email: EMAIL,
          inviteCode: INVITE_CODE,
          referralCode: "not-a-public-code",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 1);
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM pending_registrations WHERE referral_source_profile_id IS NULL",
        ),
        1,
      );
      assert.equal(
        firstNumber(database, "SELECT COUNT(*) FROM referral_attribution_candidates"),
        0,
      );
    } finally {
      await app.close();
    }
  });
});

test("rejects mutation contract violations before registration state changes", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertInvite(database);
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
      },
    });
    try {
      const wrongOrigin = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: { ...HEADERS, origin: "https://example.invalid" },
        payload: { email: EMAIL, inviteCode: INVITE_CODE },
      });
      assert.equal(wrongOrigin.statusCode, 400);
      assert.deepEqual(wrongOrigin.json(), {
        error: { code: "origin_rejected" },
      });

      const malformedInvite = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: { email: EMAIL, inviteCode: INVITE_CODE.toLowerCase() },
      });
      assert.equal(malformedInvite.statusCode, 400);
      const injectedIdentity = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: {
          email: EMAIL,
          inviteCode: INVITE_CODE,
          referrer_user_id: 1,
        },
      });
      assert.equal(injectedIdentity.statusCode, 400);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 0);
    } finally {
      await app.close();
    }
  });
});

test("rolls back complete when the invite becomes unusable after verification", async () => {
  await withAuthenticationDatabase(async (database) => {
    const inviteId = insertInvite(database, "rollback@example.com");
    const token = generateRegistrationToken(
      TOKEN_KEYS,
      (size) => Buffer.alloc(size, 0x73),
    );
    const now = "2026-08-20T12:00:00.000Z";
    database
      .prepare(
        `INSERT INTO pending_registrations (
           email, registration_token_hash, registration_token_key_version,
           invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
           verified_at, attempts, resend_count, last_sent_at, expires_at,
           consumed_at, superseded_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'verified', ?, 0, 1, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        "rollback@example.com",
        token.tokenHash,
        token.hmacKeyVersion,
        inviteId,
        computeRegistrationOtpHash("123456", TOKEN_KEYS.version, TOKEN_KEYS),
        TOKEN_KEYS.version,
        now,
        now,
        "2026-08-20T12:10:00.000Z",
        now,
      );
    database
      .prepare("UPDATE invite_codes SET revoked_at = ? WHERE id = ?")
      .run("2026-08-20T12:00:30.000Z", inviteId);

    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date("2026-08-20T12:01:00.000Z"),
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register/complete",
        headers: HEADERS,
        payload: {
          registrationToken: token.rawToken,
          password: PASSWORD,
          confirmPassword: PASSWORD,
        },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: { code: "invalid_or_expired" },
      });
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM users WHERE email = 'rollback@example.com'",
        ),
        0,
      );
      assert.equal(
        firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"),
        0,
      );
      assert.equal(
        firstNumber(database, "SELECT used_count FROM invite_codes LIMIT 1"),
        0,
      );
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM pending_registrations WHERE phase = 'verified' AND consumed_at IS NULL",
        ),
        1,
      );
    } finally {
      await app.close();
    }
  });
});

test("bound matching invite states remain indistinguishable through verify and fail only at complete", async () => {
  const projections: Array<Record<string, unknown>> = [];
  for (const state of ["usable", "revoked", "expired", "exhausted"] as const) {
    await withAuthenticationDatabase(async (database) => {
      const inviteId = insertInvite(
        database,
        EMAIL,
        INVITE_CODE,
        state === "expired"
          ? "2026-08-20T11:59:59.999Z"
          : "2026-08-21T00:00:00.000Z",
      );
      if (state === "revoked") {
        database
          .prepare("UPDATE invite_codes SET revoked_at = ? WHERE id = ?")
          .run("2026-08-20T11:00:00.000Z", inviteId);
      } else if (state === "exhausted") {
        database
          .prepare("UPDATE invite_codes SET used_count = 1 WHERE id = ?")
          .run(inviteId);
      }

      let now = new Date("2026-08-20T12:00:00.000Z");
      let tokenByte = 0x44;
      const app = buildApp({
        registration: {
          database,
          nodeEnv: "test",
          ...KEYRINGS,
          serviceDependencies: {
            now: () => new Date(now),
            randomBytes: (size) => Buffer.alloc(size, tokenByte++),
            randomInt: () => 234_567,
            outboxRandomBytes: (size) => Buffer.alloc(size, 0x62),
            hashPassword: async () => "test-password-hash",
          },
        },
      });
      try {
        const start = await app.inject({
          method: "POST",
          url: "/api/auth/register/start",
          headers: HEADERS,
          payload: {
            email: ` ${EMAIL.toUpperCase()} `,
            inviteCode: INVITE_CODE,
          },
        });
        assert.equal(start.statusCode, 200, state);
        const startToken = start.json<{ registrationToken: string }>()
          .registrationToken;
        assert.match(startToken, /^v2\.[A-Za-z0-9_-]{43}$/, state);
        assert.equal(
          firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"),
          1,
          state,
        );
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 1, state);
        assert.equal(latestOtp(database), "234567", state);

        const firstMail = database
          .prepare(
            `SELECT to_email, template, status, attempts
             FROM mail_outbox ORDER BY idempotency_key LIMIT 1`,
          )
          .all()[0] as Record<string, unknown>;
        projections.push({
          response: start.json(),
          mail: firstMail,
          otp: latestOtp(database),
        });

        now = new Date("2026-08-20T12:01:00.000Z");
        const resend = await app.inject({
          method: "POST",
          url: "/api/auth/register/resend-code",
          headers: HEADERS,
          payload: { registrationToken: startToken },
        });
        assert.equal(resend.statusCode, 200, state);
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 2, state);

        const verify = await app.inject({
          method: "POST",
          url: "/api/auth/register/verify-code",
          headers: HEADERS,
          payload: { registrationToken: startToken, otp: "234567" },
        });
        assert.equal(verify.statusCode, 200, state);
        const verifiedToken = verify.json<{ registrationToken: string }>()
          .registrationToken;

        const complete = await app.inject({
          method: "POST",
          url: "/api/auth/register/complete",
          headers: HEADERS,
          payload: {
            registrationToken: verifiedToken,
            password: PASSWORD,
            confirmPassword: PASSWORD,
          },
        });
        if (state === "usable") {
          assert.equal(complete.statusCode, 200, state);
          assert.equal(
            firstNumber(
              database,
              `SELECT COUNT(*) FROM users WHERE email = '${EMAIL}'`,
            ),
            1,
          );
        } else {
          assert.equal(complete.statusCode, 400, state);
          assert.deepEqual(
            complete.json(),
            { error: { code: "invalid_or_expired" } },
            state,
          );
          assert.equal(
            firstNumber(
              database,
              `SELECT COUNT(*) FROM users WHERE email = '${EMAIL}'`,
            ),
            0,
          );
        }
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM sessions"), 0);
      } finally {
        await app.close();
      }
    });
  }
  assert.equal(projections.length, 4);
  for (const projection of projections.slice(1)) {
    assert.deepEqual(projection, projections[0]);
  }
});

test("unknown, mismatched, bootstrap, unbound, shared, and multi-use invites stay fake and stateless", async () => {
  const cases = [
    "unknown",
    "mismatch",
    "bootstrap",
    "unbound",
    "shared",
    "multiuse",
  ] as const;

  for (const [index, kind] of cases.entries()) {
    await withAuthenticationDatabase(async (database) => {
      const inviteCode = inviteCodeForIndex(index + 1);
      const codeHash = computeInviteCodeHash(
        inviteCode,
        INVITE_KEYS,
        INVITE_KEYS.version,
      );
      if (kind === "mismatch") {
        insertInvite(database, "different@example.com", inviteCode);
      } else if (kind === "bootstrap") {
        database
          .prepare(
            `INSERT INTO invite_codes (
               code_hash, is_bootstrap, created_by_admin_id, max_uses,
               used_count, expires_at, revoked_at, note, created_at,
               recipient_email
             ) VALUES (?, 1, NULL, 1, 0, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            codeHash,
            "2026-08-21T00:00:00.000Z",
            "2026-08-20T00:00:00.000Z",
            "2026-08-20T00:00:00.000Z",
          );
      } else if (kind !== "unknown") {
        const creatorId = insertAuthenticationUser(database, {
          email: "legacy-admin@example.com",
          passwordHash: "hash",
          status: "active",
          role: "admin",
        });
        database.exec("DROP TRIGGER trg_invite_codes_insert_prebound_single_use");
        database
          .prepare(
            `INSERT INTO invite_codes (
               code_hash, is_bootstrap, created_by_admin_id, max_uses,
               used_count, expires_at, revoked_at, note, created_at,
               recipient_email
             ) VALUES (?, 0, ?, ?, 0, ?, ?, NULL, ?, ?)`,
          )
          .run(
            codeHash,
            creatorId,
            kind === "unbound" ? 1 : 2,
            "2026-08-21T00:00:00.000Z",
            kind === "multiuse" ? null : "2026-08-20T00:00:00.000Z",
            "2026-08-20T00:00:00.000Z",
            kind === "multiuse" ? EMAIL : null,
          );
      }

      let tokenByte = 0x70;
      const app = buildApp({
        registration: {
          database,
          nodeEnv: "test",
          ...KEYRINGS,
          serviceDependencies: {
            now: () => new Date("2026-08-20T12:00:00.000Z"),
            randomBytes: (size) => Buffer.alloc(size, tokenByte++),
            randomInt: () => 123_456,
            outboxRandomBytes: (size) => Buffer.alloc(size, 0x71),
          },
        },
      });
      try {
        const tokens: string[] = [];
        const requestCount = kind === "unknown" ? 2 : 1;
        for (let request = 0; request < requestCount; request += 1) {
          const response = await app.inject({
            method: "POST",
            url: "/api/auth/register/start",
            headers: HEADERS,
            payload: { email: EMAIL, inviteCode },
          });
          assert.equal(response.statusCode, 200, kind);
          const token = response.json<{ registrationToken: string }>()
            .registrationToken;
          assert.match(token, /^v2\.[A-Za-z0-9_-]{43}$/, kind);
          tokens.push(token);
        }
        if (tokens.length === 2) assert.notEqual(tokens[0], tokens[1]);
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 0, kind);
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 0, kind);
      } finally {
        await app.close();
      }
    });
  }
});

test("start enforces the IP ceiling and the silent invite/email ceiling with an exact cooldown edge", async () => {
  await withAuthenticationDatabase(async (database) => {
    let tokenByte = 0x20;
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date("2026-08-20T12:00:00.000Z"),
          randomBytes: (size) => Buffer.alloc(size, tokenByte++),
          randomInt: () => 123_456,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0x22),
        },
      },
    });
    try {
      const unknownCode = inviteCodeForIndex(9);
      for (let count = 0; count < 10; count += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/register/start",
          headers: HEADERS,
          payload: { email: EMAIL, inviteCode: unknownCode },
        });
        assert.equal(response.statusCode, 200, `IP request ${count + 1}`);
      }
      const limited = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: { email: EMAIL, inviteCode: unknownCode },
      });
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json(), { error: { code: "rate_limited" } });
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 0);
    } finally {
      await app.close();
    }
  });

  await withAuthenticationDatabase(async (database) => {
    insertInvite(database);
    let now = new Date("2026-08-20T12:00:00.000Z");
    let tokenByte = 0x30;
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date(now),
          randomBytes: (size) => Buffer.alloc(size, tokenByte++),
          randomInt: () => 123_456,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0x32),
        },
      },
    });
    try {
      const start = async () =>
        app.inject({
          method: "POST",
          url: "/api/auth/register/start",
          headers: HEADERS,
          payload: { email: EMAIL, inviteCode: INVITE_CODE },
        });
      assert.equal((await start()).statusCode, 200);
      now = new Date("2026-08-20T12:00:59.999Z");
      assert.equal((await start()).statusCode, 200);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 1);
      now = new Date("2026-08-20T12:01:00.000Z");
      assert.equal((await start()).statusCode, 200);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 2);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 2);
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM pending_registrations WHERE superseded_at IS NOT NULL",
        ),
        1,
      );
    } finally {
      await app.close();
    }
  });

  await withAuthenticationDatabase(async (database) => {
    insertInvite(database);
    let now = new Date("2026-08-20T12:00:00.000Z");
    let tokenByte = 0x40;
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date(now),
          randomBytes: (size) => Buffer.alloc(size, tokenByte++),
          randomInt: () => 123_456,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0x42),
        },
      },
    });
    try {
      for (let count = 0; count < 6; count += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/register/start",
          headers: { ...HEADERS, "x-forwarded-for": `192.0.2.${count + 1}` },
          payload: { email: EMAIL, inviteCode: INVITE_CODE },
        });
        assert.equal(response.statusCode, 200, `silent request ${count + 1}`);
        now = new Date(now.getTime() + 61_000);
      }
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 5);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 5);
      assert.equal(
        firstNumber(
          database,
          "SELECT COALESCE(SUM(count), 0) FROM rate_limit_buckets",
        ),
        16,
      );
    } finally {
      await app.close();
    }
  });
});

test("resend permits exactly five successful sends and only the twenty-first IP request is 429", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertInvite(database);
    let now = new Date("2026-08-20T12:00:00.000Z");
    let tokenByte = 0x50;
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date(now),
          randomBytes: (size) => Buffer.alloc(size, tokenByte++),
          randomInt: () => 123_456,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0x52),
        },
      },
    });
    try {
      const started = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: { email: EMAIL, inviteCode: INVITE_CODE },
      });
      const registrationToken = started.json<{ registrationToken: string }>()
        .registrationToken;
      for (let resend = 1; resend <= 6; resend += 1) {
        now = new Date(`2026-08-20T12:0${resend}:00.000Z`);
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/register/resend-code",
          headers: HEADERS,
          payload: { registrationToken },
        });
        assert.equal(response.statusCode, 200, `resend ${resend}`);
      }
      assert.equal(firstNumber(database, "SELECT resend_count FROM pending_registrations"), 6);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 6);
    } finally {
      await app.close();
    }
  });

  await withAuthenticationDatabase(async (database) => {
    const missing = generateRegistrationToken(
      TOKEN_KEYS,
      (size) => Buffer.alloc(size, 0x66),
    ).rawToken;
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date("2026-08-20T12:00:00.000Z"),
        },
      },
    });
    try {
      for (let count = 0; count < 20; count += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/register/resend-code",
          headers: HEADERS,
          payload: { registrationToken: missing },
        });
        assert.equal(response.statusCode, 200, `IP resend ${count + 1}`);
      }
      const limited = await app.inject({
        method: "POST",
        url: "/api/auth/register/resend-code",
        headers: HEADERS,
        payload: { registrationToken: missing },
      });
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json(), { error: { code: "rate_limited" } });
    } finally {
      await app.close();
    }
  });
});

test("concurrent complete has one winner and replay cannot duplicate any account state", async () => {
  await withAuthenticationDatabase(async (database) => {
    const prepared = insertVerifiedPending(database, {
      email: "concurrent@example.com",
      inviteCode: inviteCodeForIndex(12),
      tokenByte: 0x71,
    });
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date("2026-08-20T12:01:00.000Z"),
          hashPassword: async () => {
            await Promise.resolve();
            return "concurrent-password-hash";
          },
        },
      },
    });
    const payload = {
      registrationToken: prepared.registrationToken,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    };
    try {
      const responses = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/auth/register/complete",
          headers: HEADERS,
          payload,
        }),
        app.inject({
          method: "POST",
          url: "/api/auth/register/complete",
          headers: HEADERS,
          payload,
        }),
      ]);
      assert.deepEqual(
        responses.map((response) => response.statusCode).sort(),
        [200, 400],
      );
      const failed = responses.find((response) => response.statusCode === 400);
      assert.deepEqual(failed?.json(), {
        error: { code: "invalid_or_expired" },
      });

      const replay = await app.inject({
        method: "POST",
        url: "/api/auth/register/complete",
        headers: HEADERS,
        payload,
      });
      assert.equal(replay.statusCode, 400);
      assert.deepEqual(replay.json(), { error: { code: "invalid_or_expired" } });
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM users WHERE email = 'concurrent@example.com'",
        ),
        1,
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 1);
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM audit_log WHERE action = 'invite_code.redeem'",
        ),
        1,
      );
      assert.equal(
        firstNumber(
          database,
          `SELECT used_count FROM invite_codes WHERE id = ${prepared.inviteCodeId}`,
        ),
        1,
      );
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM pending_registrations WHERE phase = 'completed' AND consumed_at IS NOT NULL",
        ),
        1,
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM sessions"), 0);
    } finally {
      await app.close();
    }
  });
});

test("complete rejects every frozen invite predicate with one generic response", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (database: DatabaseConnection, inviteCodeId: number) => void;
    readonly expectedUsedCount?: number;
  }> = [
    {
      name: "recipient",
      mutate(database, inviteCodeId) {
        database.exec("DROP TRIGGER trg_invite_codes_binding_immutable");
        database
          .prepare("UPDATE invite_codes SET recipient_email = ? WHERE id = ?")
          .run("other@example.com", inviteCodeId);
      },
    },
    {
      name: "revoked",
      mutate(database, inviteCodeId) {
        database
          .prepare("UPDATE invite_codes SET revoked_at = ? WHERE id = ?")
          .run("2026-08-20T12:00:30.000Z", inviteCodeId);
      },
    },
    {
      name: "expired",
      mutate(database, inviteCodeId) {
        database
          .prepare("UPDATE invite_codes SET expires_at = ? WHERE id = ?")
          .run("2026-08-20T12:00:59.999Z", inviteCodeId);
      },
    },
    {
      name: "used",
      expectedUsedCount: 1,
      mutate(database, inviteCodeId) {
        database
          .prepare("UPDATE invite_codes SET used_count = 1 WHERE id = ?")
          .run(inviteCodeId);
      },
    },
    {
      name: "max uses",
      mutate(database, inviteCodeId) {
        database.exec("DROP TRIGGER trg_invite_codes_binding_immutable");
        database
          .prepare("UPDATE invite_codes SET max_uses = 2 WHERE id = ?")
          .run(inviteCodeId);
      },
    },
    {
      name: "bootstrap",
      mutate(database, inviteCodeId) {
        database.exec(`
          DROP INDEX idx_invite_codes_bootstrap_unique;
          DROP TRIGGER trg_invite_codes_binding_immutable;
        `);
        database
          .prepare(
            `UPDATE invite_codes
             SET is_bootstrap = 1, created_by_admin_id = NULL,
                 recipient_email = NULL, revoked_at = ?
             WHERE id = ?`,
          )
          .run("2026-08-20T12:00:30.000Z", inviteCodeId);
      },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await withAuthenticationDatabase(async (database) => {
      const email = `predicate-${index}@example.com`;
      const prepared = insertVerifiedPending(database, {
        email,
        inviteCode: inviteCodeForIndex(index + 15),
        tokenByte: 0x80 + index,
      });
      fixture.mutate(database, prepared.inviteCodeId);
      const app = buildApp({
        registration: {
          database,
          nodeEnv: "test",
          ...KEYRINGS,
          serviceDependencies: {
            now: () => new Date("2026-08-20T12:01:00.000Z"),
            hashPassword: async () => "predicate-password-hash",
          },
        },
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/register/complete",
          headers: HEADERS,
          payload: {
            registrationToken: prepared.registrationToken,
            password: PASSWORD,
            confirmPassword: PASSWORD,
          },
        });
        assert.equal(response.statusCode, 400, fixture.name);
        assert.deepEqual(
          response.json(),
          { error: { code: "invalid_or_expired" } },
          fixture.name,
        );
        assert.equal(
          firstNumber(
            database,
            `SELECT used_count FROM invite_codes WHERE id = ${prepared.inviteCodeId}`,
          ),
          fixture.expectedUsedCount ?? 0,
          fixture.name,
        );
        assert.equal(
          firstNumber(database, `SELECT COUNT(*) FROM users WHERE email = '${email}'`),
          0,
          fixture.name,
        );
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 0, fixture.name);
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 0, fixture.name);
        assert.equal(
          firstNumber(
            database,
            "SELECT COUNT(*) FROM pending_registrations WHERE phase = 'verified' AND consumed_at IS NULL",
          ),
          1,
          fixture.name,
        );
      } finally {
        await app.close();
      }
    });
  }
});

test("complete rolls back invite, user, redemption, audit, pending, and rate state at every write failure", async () => {
  const failures: ReadonlyArray<{
    readonly name: string;
    readonly trigger: (email: string) => string;
  }> = [
    {
      name: "user",
      trigger: (email) => `
        CREATE TRIGGER fail_complete_user BEFORE INSERT ON users
        FOR EACH ROW WHEN NEW.email = '${email}'
        BEGIN SELECT RAISE(ABORT,'fail_complete_user'); END;`,
    },
    {
      name: "redemption",
      trigger: () => `
        CREATE TRIGGER fail_complete_redemption
        BEFORE INSERT ON invite_code_redemptions
        BEGIN SELECT RAISE(ABORT,'fail_complete_redemption'); END;`,
    },
    {
      name: "audit",
      trigger: () => `
        CREATE TRIGGER fail_complete_audit BEFORE INSERT ON audit_log
        FOR EACH ROW WHEN NEW.action = 'invite_code.redeem'
        BEGIN SELECT RAISE(ABORT,'fail_complete_audit'); END;`,
    },
    {
      name: "pending",
      trigger: () => `
        CREATE TRIGGER fail_complete_pending
        BEFORE UPDATE OF phase, consumed_at ON pending_registrations
        FOR EACH ROW WHEN NEW.phase = 'completed'
        BEGIN SELECT RAISE(ABORT,'fail_complete_pending'); END;`,
    },
  ];

  for (const [index, failure] of failures.entries()) {
    await withAuthenticationDatabase(async (database) => {
      const email = `rollback-${failure.name}@example.com`;
      const prepared = insertVerifiedPending(database, {
        email,
        inviteCode: inviteCodeForIndex(index + 22),
        tokenByte: 0x90 + index,
      });
      database.exec(failure.trigger(email));
      const app = buildApp({
        registration: {
          database,
          nodeEnv: "test",
          ...KEYRINGS,
          serviceDependencies: {
            now: () => new Date("2026-08-20T12:01:00.000Z"),
            hashPassword: async () => "rollback-password-hash",
          },
        },
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/register/complete",
          headers: HEADERS,
          payload: {
            registrationToken: prepared.registrationToken,
            password: PASSWORD,
            confirmPassword: PASSWORD,
          },
        });
        assert.equal(response.statusCode, 503, failure.name);
        assert.deepEqual(
          response.json(),
          { error: { code: "auth_unavailable" } },
          failure.name,
        );
        assert.equal(
          firstNumber(
            database,
            `SELECT used_count FROM invite_codes WHERE id = ${prepared.inviteCodeId}`,
          ),
          0,
          failure.name,
        );
        assert.equal(firstNumber(database, `SELECT COUNT(*) FROM users WHERE email = '${email}'`), 0, failure.name);
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 0, failure.name);
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 0, failure.name);
        assert.equal(
          firstNumber(
            database,
            "SELECT COUNT(*) FROM pending_registrations WHERE phase = 'verified' AND consumed_at IS NULL",
          ),
          1,
          failure.name,
        );
        assert.equal(firstNumber(database, "SELECT COALESCE(SUM(count), 0) FROM rate_limit_buckets"), 0, failure.name);
        assert.equal(firstNumber(database, "SELECT COUNT(*) FROM sessions"), 0, failure.name);
      } finally {
        await app.close();
      }
    });
  }
});

test("password hashing failure and start outbox failure leave no partial database state", async () => {
  await withAuthenticationDatabase(async (database) => {
    const email = "crypto-failure@example.com";
    const prepared = insertVerifiedPending(database, {
      email,
      inviteCode: inviteCodeForIndex(27),
      tokenByte: 0xa1,
    });
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date("2026-08-20T12:01:00.000Z"),
          hashPassword: async () => {
            throw new Error("test hash failure");
          },
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register/complete",
        headers: HEADERS,
        payload: {
          registrationToken: prepared.registrationToken,
          password: PASSWORD,
          confirmPassword: PASSWORD,
        },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: { code: "auth_unavailable" } });
      assert.equal(
        firstNumber(
          database,
          `SELECT used_count FROM invite_codes WHERE id = ${prepared.inviteCodeId}`,
        ),
        0,
      );
      assert.equal(firstNumber(database, `SELECT COUNT(*) FROM users WHERE email = '${email}'`), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 0);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 0);
      assert.equal(firstNumber(database, "SELECT COALESCE(SUM(count), 0) FROM rate_limit_buckets"), 0);
    } finally {
      await app.close();
    }
  });

  await withAuthenticationDatabase(async (database) => {
    insertInvite(database);
    let now = new Date("2026-08-20T12:00:00.000Z");
    let tokenByte = 0xb0;
    const app = buildApp({
      registration: {
        database,
        nodeEnv: "test",
        ...KEYRINGS,
        serviceDependencies: {
          now: () => new Date(now),
          randomBytes: (size) => Buffer.alloc(size, tokenByte++),
          randomInt: () => 123_456,
          outboxRandomBytes: (size) => Buffer.alloc(size, 0xb1),
        },
      },
    });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: { email: EMAIL, inviteCode: INVITE_CODE },
      });
      assert.equal(first.statusCode, 200);
      const rateBefore = firstNumber(
        database,
        "SELECT COALESCE(SUM(count), 0) FROM rate_limit_buckets",
      );
      database.exec(`
        CREATE TRIGGER fail_start_outbox BEFORE INSERT ON mail_outbox
        BEGIN SELECT RAISE(ABORT,'fail_start_outbox'); END;
      `);
      now = new Date("2026-08-20T12:01:00.000Z");
      const failed = await app.inject({
        method: "POST",
        url: "/api/auth/register/start",
        headers: HEADERS,
        payload: { email: EMAIL, inviteCode: INVITE_CODE },
      });
      assert.equal(failed.statusCode, 503);
      assert.deepEqual(failed.json(), { error: { code: "auth_unavailable" } });
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 1);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM mail_outbox"), 1);
      assert.equal(
        firstNumber(
          database,
          "SELECT COUNT(*) FROM pending_registrations WHERE superseded_at IS NOT NULL",
        ),
        0,
      );
      assert.equal(
        firstNumber(database, "SELECT COALESCE(SUM(count), 0) FROM rate_limit_buckets"),
        rateBefore,
      );
    } finally {
      await app.close();
    }
  });
});
