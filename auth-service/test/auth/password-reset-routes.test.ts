import assert from "node:assert/strict";
import test from "node:test";

import { hashPasswordResetToken, PASSWORD_RESET_TTL_MS } from "../../src/account/password-reset.js";
import { buildApp } from "../../src/app.js";
import { hashPassword, verifyPasswordHash } from "../../src/auth/password.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { PasswordResetHttpDependencies } from "../../src/http/password-reset-routes.js";
import {
  PASSWORD_RESET_CONFIRM_IP_LIMIT,
  PASSWORD_RESET_REQUEST_EMAIL_LIMIT,
  type RateLimitKeyring,
} from "../../src/http/rate-limit.js";
import { dispatchNextMail, type MailDelivery } from "../../src/registration/mail-dispatcher.js";
import { decryptMailPayload, type MailTemplate } from "../../src/registration/mail-outbox.js";
import { ResendMailTransport } from "../../src/registration/resend-mail-transport.js";
import { computeSessionTokenHash, type TokenHmacKeyring } from "../../src/session/session-token.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "./helpers.js";

const NOW = new Date("2026-09-30T03:04:05.000Z");
const TOKEN_KEYRING: TokenHmacKeyring = { version: 1, keys: { "1": Buffer.alloc(32, 0x21).toString("base64") } };
const MAIL_KEYRING: TokenHmacKeyring = { version: 1, keys: { "1": Buffer.alloc(32, 0x61).toString("base64") } };
const RATE_LIMIT_KEYRING: RateLimitKeyring = { version: 1, keys: { "1": Buffer.alloc(32, 0x31).toString("base64") } };
const ORIGIN = "http://localhost:5173";
const CURRENT = "correct-horse-12";
const NEXT = "battery-staple-99";

let cachedHash: string | undefined;
async function currentHash(): Promise<string> {
  cachedHash ??= await hashPassword(CURRENT);
  return cachedHash;
}

function insertSession(database: DatabaseConnection, userId: number, familyId: string, tokenByte: number): string {
  const token = computeSessionTokenHash(`v1.${Buffer.alloc(32, tokenByte).toString("base64url")}`, TOKEN_KEYRING);
  database.prepare("INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)").run(familyId, userId, new Date(NOW.getTime() - 60_000).toISOString());
  database
    .prepare(
      `INSERT INTO sessions (token_hash, hmac_key_version, user_id, session_family_id, audience, created_at, expires_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, 'web', ?, ?, ?, NULL)`,
    )
    .run(token.tokenHash, token.hmacKeyVersion, userId, familyId, new Date(NOW.getTime() - 60_000).toISOString(), new Date(NOW.getTime() + 3_600_000).toISOString(), new Date(NOW.getTime() - 30_000).toISOString());
  return token.tokenHash;
}

function dependencies(database: DatabaseConnection, clock: { now: Date } = { now: new Date(NOW) }): PasswordResetHttpDependencies {
  return {
    database,
    nodeEnv: "test",
    tokenHmacKeyring: TOKEN_KEYRING,
    mailPayloadEncKeyring: MAIL_KEYRING,
    rateLimitKeyring: RATE_LIMIT_KEYRING,
    now: () => new Date(clock.now),
  };
}

async function setup(database: DatabaseConnection) {
  const userId = insertAuthenticationUser(database, { email: "owner@example.net", passwordHash: await currentHash(), status: "active" });
  const other = insertAuthenticationUser(database, { email: "other@example.net", passwordHash: await currentHash(), status: "active" });
  const sessions = [insertSession(database, userId, "family-a", 0x71), insertSession(database, userId, "family-b", 0x72)];
  const foreign = insertSession(database, other, "family-foreign", 0x73);
  return { userId, other, sessions, foreign };
}

function post(app: ReturnType<typeof buildApp>, url: string, payload: unknown, overrides: Record<string, string | undefined> = {}, remoteAddress = "192.0.2.10") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    origin: ORIGIN,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return app.inject({ method: "POST", url, headers, payload: JSON.stringify(payload), remoteAddress });
}

const requestReset = (app: ReturnType<typeof buildApp>, email: string, remoteAddress?: string) =>
  post(app, "/api/auth/password-reset/request", { email }, {}, remoteAddress);
const confirmReset = (app: ReturnType<typeof buildApp>, token: string, password: string, remoteAddress?: string) =>
  post(app, "/api/auth/password-reset/confirm", { token, password }, {}, remoteAddress);

function resetMails(database: DatabaseConnection) {
  return database
    .prepare("SELECT idempotency_key, to_email, template, key_version, nonce, ciphertext, tag FROM mail_outbox WHERE template = 'password_reset' ORDER BY rowid")
    .all() as Array<{ idempotency_key: string; to_email: string; template: MailTemplate; key_version: number; nonce: Buffer; ciphertext: Buffer; tag: Buffer }>;
}

function emailedToken(database: DatabaseConnection): string {
  const row = resetMails(database).at(-1)!;
  return decryptMailPayload(
    { idempotencyKey: row.idempotency_key, toEmail: row.to_email, template: row.template, keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, tag: row.tag },
    MAIL_KEYRING,
  );
}

function tokenRows(database: DatabaseConnection) {
  return database
    .prepare("SELECT token_hash, hmac_key_version, user_id, expires_at, used_at, superseded_at, created_at FROM password_reset_tokens ORDER BY id")
    .all() as Array<{ token_hash: string; hmac_key_version: number; user_id: number; expires_at: string; used_at: string | null; superseded_at: string | null; created_at: string }>;
}

function revoked(database: DatabaseConnection, tokenHash: string): boolean {
  return (database.prepare("SELECT revoked_at FROM sessions WHERE token_hash = ?").all(tokenHash)[0] as { revoked_at: unknown }).revoked_at !== null;
}

/** Every text or blob value in every table, for "the raw token is stored nowhere" checks. */
function allStoredValues(database: DatabaseConnection): string[] {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return tables.flatMap(({ name }) =>
    (database.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>).flatMap((row) =>
      Object.values(row).map((value) => (Buffer.isBuffer(value) ? value.toString("latin1") : String(value))),
    ),
  );
}

test("request answers the same for registered, unknown and malformed addresses and stores only a token hash", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { userId } = await setup(database);
    const app = buildApp({ passwordReset: dependencies(database) });
    const responses = [
      await requestReset(app, "Owner@Example.net"),
      await requestReset(app, "nobody@example.net"),
      await requestReset(app, "not-an-address"),
    ];
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, JSON.stringify({ status: "ok" }));
      assert.equal(response.headers["cache-control"], "no-store");
    }

    const rows = tokenRows(database);
    assert.equal(rows.length, 1);
    const token = emailedToken(database);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(rows[0]!.user_id, userId);
    assert.equal(rows[0]!.hmac_key_version, 1);
    assert.equal(rows[0]!.token_hash, hashPasswordResetToken(TOKEN_KEYRING, 1, token));
    assert.notEqual(rows[0]!.token_hash, token);
    assert.equal(rows[0]!.expires_at, new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS).toISOString());
    assert.equal(rows[0]!.used_at, null);

    const mails = resetMails(database);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to_email, "owner@example.net");
    assert.match(mails[0]!.idempotency_key, new RegExp(`^password-reset-v1:${userId}:[0-9]+:[A-Za-z0-9_-]{22}$`));
    assert.equal(allStoredValues(database).some((value) => value.includes(token)), false);
    for (const response of responses) assert.equal(response.body.includes(token), false);
    const auditRows = database.prepare("SELECT actor, action FROM audit_log WHERE action LIKE 'account.%'").all();
    assert.deepEqual(auditRows, [{ actor: `user:${userId}`, action: "account.password_reset_request" }]);
    await app.close();
  });
});

test("inactive accounts get the same answer and no token", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertAuthenticationUser(database, { email: "gone@example.net", passwordHash: await currentHash(), status: "disabled" });
    const app = buildApp({ passwordReset: dependencies(database) });
    const response = await requestReset(app, "gone@example.net");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
    assert.equal(tokenRows(database).length, 0);
    assert.equal(resetMails(database).length, 0);
    await app.close();
  });
});

test("confirm sets the new password, uses the token once and revokes every session of the account", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { userId, sessions, foreign } = await setup(database);
    const app = buildApp({ passwordReset: dependencies(database) });
    await requestReset(app, "owner@example.net");
    const token = emailedToken(database);

    const response = await confirmReset(app, token, NEXT);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
    const hash = (database.prepare("SELECT password_hash FROM users WHERE id = ?").all(userId)[0] as { password_hash: string }).password_hash;
    assert.equal(await verifyPasswordHash(hash, NEXT), true);
    assert.equal(await verifyPasswordHash(hash, CURRENT), false);
    assert.notEqual(tokenRows(database)[0]!.used_at, null);
    assert.deepEqual(sessions.map((session) => revoked(database, session)), [true, true]);
    assert.equal(revoked(database, foreign), false);
    const families = database.prepare("SELECT id, revoked_at FROM session_families ORDER BY id").all() as Array<{ id: string; revoked_at: unknown }>;
    assert.deepEqual(families.map((row) => [row.id, row.revoked_at !== null]), [["family-a", true], ["family-b", true], ["family-foreign", false]]);
    const auditRows = database.prepare("SELECT action FROM audit_log WHERE action LIKE 'account.%' ORDER BY id").all();
    assert.deepEqual(auditRows, [{ action: "account.password_reset_request" }, { action: "account.password_reset" }]);

    const replay = await confirmReset(app, token, "another-password-1");
    assert.equal(replay.statusCode, 400);
    assert.deepEqual(replay.json(), { error: { code: "invalid_token" } });
    assert.equal(allStoredValues(database).some((value) => value.includes(token)), false);
    await app.close();
  });
});

test("a newer request supersedes the older token", async () => {
  await withAuthenticationDatabase(async (database) => {
    await setup(database);
    const app = buildApp({ passwordReset: dependencies(database) });
    await requestReset(app, "owner@example.net");
    const first = emailedToken(database);
    await requestReset(app, "owner@example.net");
    const second = emailedToken(database);
    assert.notEqual(first, second);
    const rows = tokenRows(database);
    assert.notEqual(rows[0]!.superseded_at, null);
    assert.equal(rows[1]!.superseded_at, null);

    assert.deepEqual((await confirmReset(app, first, NEXT)).json(), { error: { code: "invalid_token" } });
    assert.equal((await confirmReset(app, second, NEXT)).statusCode, 200);
    await app.close();
  });
});

test("expired, unknown and malformed tokens all fail as invalid_token; a policy failure keeps the token usable", async () => {
  await withAuthenticationDatabase(async (database) => {
    await setup(database);
    const clock = { now: new Date(NOW) };
    const app = buildApp({ passwordReset: dependencies(database, clock) });
    await requestReset(app, "owner@example.net");
    const token = emailedToken(database);

    for (const presented of ["A".repeat(43), "short", `${token}x`]) {
      const response = await confirmReset(app, presented, NEXT);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: { code: "invalid_token" } });
    }

    const weak = await confirmReset(app, token, "too-short");
    assert.equal(weak.statusCode, 422);
    assert.deepEqual(weak.json(), { error: { code: "password_policy_violation" } });
    assert.equal(tokenRows(database)[0]!.used_at, null);

    clock.now = new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS + 1_000);
    const expired = await confirmReset(app, token, NEXT);
    assert.equal(expired.statusCode, 400);
    assert.deepEqual(expired.json(), { error: { code: "invalid_token" } });
    await app.close();
  });
});

test("requests are limited per address whether or not it is registered, and confirms per IP", async () => {
  await withAuthenticationDatabase(async (database) => {
    await setup(database);
    const app = buildApp({ passwordReset: dependencies(database) });
    for (const email of ["owner@example.net", "nobody@example.net"]) {
      for (let attempt = 0; attempt < PASSWORD_RESET_REQUEST_EMAIL_LIMIT; attempt += 1) {
        assert.equal((await requestReset(app, email, `192.0.2.${100 + attempt}`)).statusCode, 200);
      }
      const limited = await requestReset(app, email, "192.0.2.200");
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json(), { error: { code: "rate_limited" } });
    }

    for (let attempt = 0; attempt < PASSWORD_RESET_CONFIRM_IP_LIMIT; attempt += 1) {
      assert.equal((await confirmReset(app, "A".repeat(43), NEXT, "198.51.100.7")).statusCode, 400);
    }
    assert.equal((await confirmReset(app, "A".repeat(43), NEXT, "198.51.100.7")).statusCode, 429);
    assert.equal((await confirmReset(app, "A".repeat(43), NEXT, "198.51.100.8")).statusCode, 400);
    await app.close();
  });
});

test("reset routes require the exact origin and JSON mutation headers", async () => {
  await withAuthenticationDatabase(async (database) => {
    await setup(database);
    const app = buildApp({ passwordReset: dependencies(database) });
    const wrongOrigin = await post(app, "/api/auth/password-reset/request", { email: "owner@example.net" }, { origin: "https://evil.example" });
    assert.equal(wrongOrigin.statusCode, 400);
    assert.deepEqual(wrongOrigin.json(), { error: { code: "origin_rejected" } });
    const noHeader = await post(app, "/api/auth/password-reset/request", { email: "owner@example.net" }, { "x-requested-with": undefined });
    assert.deepEqual(noHeader.json(), { error: { code: "invalid_request" } });
    const extra = await post(app, "/api/auth/password-reset/confirm", { token: "A".repeat(43), password: NEXT, email: "x" });
    assert.deepEqual(extra.json(), { error: { code: "invalid_request" } });
    assert.equal(tokenRows(database).length, 0);
    await app.close();
  });
});

test("the dispatcher sends a current reset link and drops it once the token is used", async () => {
  await withAuthenticationDatabase(async (database) => {
    await setup(database);
    const app = buildApp({ passwordReset: dependencies(database) });
    const sent: MailDelivery[] = [];
    const dispatch = () => dispatchNextMail({
      database,
      mailPayloadEncKeyring: MAIL_KEYRING,
      transport: { send: async (delivery) => { sent.push(delivery); } },
      policy: { leaseMs: 60_000, maxAttempts: 3, retryDelayMs: () => 1_000 },
      now: () => new Date(NOW),
    });

    await requestReset(app, "owner@example.net");
    const token = emailedToken(database);
    assert.deepEqual(await dispatch(), { outcome: "sent", attempts: 1 });
    assert.equal(sent[0]!.template, "password_reset");
    assert.equal(sent[0]!.resetToken, token);
    assert.equal(sent[0]!.verificationCode, null);

    await requestReset(app, "owner@example.net");
    assert.equal((await confirmReset(app, emailedToken(database), NEXT)).statusCode, 200);
    assert.equal((await dispatch()).outcome, "failed");
    assert.equal(sent.length, 1);
    await app.close();
  });
});

test("the Resend transport sends the reset link with an ignore notice and rejects malformed tokens", async () => {
  const bodies: Array<{ subject: string; text: string }> = [];
  const transport = new ResendMailTransport(
    { apiKey: "re_test_key", fromEmail: "noreply@example.net", requestTimeoutMs: 1_000, dispatcherLeaseMs: 5_000 },
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { subject: string; text: string });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    },
  );
  const token = "B".repeat(43);
  const key = "password-reset-v1:7:1790000000:AAAAAAAAAAAAAAAAAAAAAA";
  await transport.send({ idempotencyKey: key, toEmail: "owner@example.net", template: "password_reset", verificationCode: null, resetToken: token });
  assert.equal(bodies[0]!.subject, "Network Service Platform 重置密码");
  assert.ok(bodies[0]!.text.includes(`https://www.siqiapparel.com/reset-password?token=${token}`));
  assert.match(bodies[0]!.text, /如非本人操作，请忽略本邮件/);
  await assert.rejects(
    transport.send({ idempotencyKey: key, toEmail: "owner@example.net", template: "password_reset", verificationCode: null, resetToken: "bad token" }),
    /Mail delivery failed/,
  );
  await assert.rejects(
    transport.send({ idempotencyKey: key, toEmail: "owner@example.net", template: "password_reset", verificationCode: "042917", resetToken: token }),
    /Mail delivery failed/,
  );
});
