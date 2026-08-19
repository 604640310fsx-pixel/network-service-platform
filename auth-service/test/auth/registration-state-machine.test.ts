import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { computeInviteCodeHash } from "../../src/registration/invite-code.js";
import { decryptRegistrationOtpPayload } from "../../src/registration/mail-outbox.js";
import {
  computeRegistrationOtpHash,
  computeRegistrationTokenHash,
  generateRegistrationToken,
} from "../../src/registration/registration-crypto.js";
import type { RegistrationServiceKeyrings } from "../../src/registration/registration-service.js";
import { withAuthenticationDatabase } from "./helpers.js";

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

function insertInvite(database: DatabaseConnection): void {
  database
    .prepare(
      `INSERT INTO invite_codes (
         code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
         expires_at, revoked_at, note, created_at
       ) VALUES (?, 1, NULL, 3, 0, ?, NULL, NULL, ?)`,
    )
    .run(
      computeInviteCodeHash(INVITE_CODE, INVITE_KEYS, INVITE_KEYS.version),
      "2026-08-21T00:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
    );
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
        payload: { email: `  ${EMAIL.toUpperCase()}  `, inviteCode: INVITE_CODE },
      });
      assert.equal(start.statusCode, 200);
      assert.equal(start.headers["cache-control"], "no-store");
      const firstToken = start.json<{ registrationToken: string }>()
        .registrationToken;
      assert.match(firstToken, /^v2\.[A-Za-z0-9_-]{43}$/);
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 1);
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
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM users"), 1);
      assert.equal(
        firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"),
        1,
      );
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM audit_log"), 1);
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
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM pending_registrations"), 0);
    } finally {
      await app.close();
    }
  });
});

test("rolls back complete when the invite becomes unusable after verification", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertInvite(database);
    const inviteId = firstNumber(
      database,
      "SELECT id FROM invite_codes LIMIT 1",
    );
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
      assert.equal(firstNumber(database, "SELECT COUNT(*) FROM users"), 0);
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
