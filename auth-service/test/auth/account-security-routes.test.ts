import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { hashPassword, verifyPasswordHash } from "../../src/auth/password.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { AccountHttpDependencies } from "../../src/http/account-routes.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import {
  ACCOUNT_PASSWORD_CHANGE_USER_LIMIT,
  type RateLimitKeyring,
} from "../../src/http/rate-limit.js";
import {
  dispatchNextMail,
  type MailDelivery,
} from "../../src/registration/mail-dispatcher.js";
import { decryptMailPayload } from "../../src/registration/mail-outbox.js";
import { ResendMailTransport } from "../../src/registration/resend-mail-transport.js";
import {
  computeSessionTokenHash,
  type TokenHmacKeyring,
} from "../../src/session/session-token.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const NOW = new Date("2026-09-30T03:04:05.000Z");
const TOKEN_KEYRING: TokenHmacKeyring = { version: 1, keys: { "1": Buffer.alloc(32, 0x21).toString("base64") } };
const MAIL_KEYRING: TokenHmacKeyring = { version: 1, keys: { "1": Buffer.alloc(32, 0x61).toString("base64") } };
const RATE_LIMIT_KEYRING: RateLimitKeyring = { version: 1, keys: { "1": Buffer.alloc(32, 0x31).toString("base64") } };
const CSRF_SIGNING_KEY = Buffer.alloc(32, 0x41);
const ORIGIN = "http://localhost:5173";
const CURRENT = "correct-horse-12";
const NEXT = "battery-staple-99";

let cachedHash: string | undefined;
async function currentHash(): Promise<string> {
  cachedHash ??= await hashPassword(CURRENT);
  return cachedHash;
}

function insertSession(database: DatabaseConnection, userId: number, familyId: string, tokenByte: number) {
  const rawToken = `v1.${Buffer.alloc(32, tokenByte).toString("base64url")}`;
  const token = computeSessionTokenHash(rawToken, TOKEN_KEYRING);
  database.prepare("INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)").run(familyId, userId, new Date(NOW.getTime() - 60_000).toISOString());
  database
    .prepare(
      `INSERT INTO sessions (token_hash, hmac_key_version, user_id, session_family_id, audience, created_at, expires_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, 'web', ?, ?, ?, NULL)`,
    )
    .run(token.tokenHash, token.hmacKeyVersion, userId, familyId, new Date(NOW.getTime() - 60_000).toISOString(), new Date(NOW.getTime() + 3_600_000).toISOString(), new Date(NOW.getTime() - 30_000).toISOString());
  return { rawToken, tokenHash: token.tokenHash, csrf: issueCsrfToken(CSRF_SIGNING_KEY, token.tokenHash) };
}

function dependencies(database: DatabaseConnection, now: () => Date = () => new Date(NOW)): AccountHttpDependencies {
  return {
    database,
    nodeEnv: "test",
    tokenHmacKeyring: TOKEN_KEYRING,
    mailPayloadEncKeyring: MAIL_KEYRING,
    rateLimitKeyring: RATE_LIMIT_KEYRING,
    csrfSigningKey: CSRF_SIGNING_KEY,
    now,
  };
}

async function setup(database: DatabaseConnection) {
  const userId = insertAuthenticationUser(database, { email: "owner@example.net", passwordHash: await currentHash(), status: "active" });
  const other = insertAuthenticationUser(database, { email: "taken@example.net", passwordHash: await currentHash(), status: "active" });
  const current = insertSession(database, userId, "family-current", 0x71);
  const secondDevice = insertSession(database, userId, "family-other", 0x72);
  const otherUser = insertSession(database, other, "family-foreign", 0x73);
  return { userId, other, current, secondDevice, otherUser };
}

type Session = ReturnType<typeof insertSession>;

function post(app: ReturnType<typeof buildApp>, url: string, session: Session | null, payload: unknown, overrides: Record<string, string | undefined> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    origin: ORIGIN,
  };
  if (session !== null) {
    headers.cookie = `__Host-web_session=${session.rawToken}`;
    headers["x-csrf-token"] = session.csrf;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return app.inject({ method: "POST", url, headers, payload: JSON.stringify(payload) });
}

function sessionRevoked(database: DatabaseConnection, tokenHash: string): boolean {
  const row = database.prepare("SELECT revoked_at FROM sessions WHERE token_hash = ?").all(tokenHash)[0] as { revoked_at: unknown };
  return row.revoked_at !== null;
}

function userRow(database: DatabaseConnection, userId: number) {
  return database.prepare("SELECT email, password_hash, role FROM users WHERE id = ?").all(userId)[0] as { email: string; password_hash: string; role: string };
}

function outbox(database: DatabaseConnection) {
  return database
    .prepare("SELECT idempotency_key, to_email, template, key_version, nonce, ciphertext, tag FROM mail_outbox ORDER BY created_at, idempotency_key")
    .all() as Array<{ idempotency_key: string; to_email: string; template: "verification_code" | "email_changed_notice"; key_version: number; nonce: Buffer; ciphertext: Buffer; tag: Buffer }>;
}

function emailedCode(database: DatabaseConnection, toEmail: string): string {
  const row = outbox(database).filter((mail) => mail.to_email === toEmail && mail.idempotency_key.startsWith("email-change-otp-v1:")).at(-1)!;
  return decryptMailPayload(
    { idempotencyKey: row.idempotency_key, toEmail: row.to_email, template: row.template, keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, tag: row.tag },
    MAIL_KEYRING,
  );
}

test("password change verifies the current password, keeps this session and revokes the others", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { userId, current, secondDevice, otherUser } = await setup(database);
    const app = buildApp({ account: dependencies(database) });
    const response = await post(app, "/api/me/password/change", current, { currentPassword: CURRENT, newPassword: NEXT, confirmPassword: NEXT });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(await verifyPasswordHash(userRow(database, userId).password_hash, NEXT), true);
    assert.equal(sessionRevoked(database, current.tokenHash), false);
    assert.equal(sessionRevoked(database, secondDevice.tokenHash), true);
    assert.equal(sessionRevoked(database, otherUser.tokenHash), false);
    const families = database.prepare("SELECT id, revoked_at FROM session_families ORDER BY id").all() as Array<{ id: string; revoked_at: unknown }>;
    assert.deepEqual(families.map((row) => [row.id, row.revoked_at !== null]), [["family-current", false], ["family-foreign", false], ["family-other", true]]);
    const auditRows = database.prepare("SELECT actor, action, target_ref FROM audit_log WHERE action LIKE 'account.%'").all();
    assert.deepEqual(auditRows, [{ actor: `user:${userId}`, action: "account.password_change", target_ref: `user:${userId}` }]);
    // The kept session still works for the next write.
    const again = await post(app, "/api/me/password/change", current, { currentPassword: NEXT, newPassword: CURRENT, confirmPassword: CURRENT });
    assert.equal(again.statusCode, 200);
    await app.close();
  });
});

test("password change rejects a wrong password, policy violations and mismatches without changes", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { userId, current, secondDevice } = await setup(database);
    const before = userRow(database, userId).password_hash;
    const app = buildApp({ account: dependencies(database) });
    const cases: Array<[unknown, number, string]> = [
      [{ currentPassword: "wrong-password-00", newPassword: NEXT, confirmPassword: NEXT }, 401, "invalid_credentials"],
      [{ currentPassword: CURRENT, newPassword: "short", confirmPassword: "short" }, 422, "password_policy_violation"],
      [{ currentPassword: CURRENT, newPassword: "x".repeat(257), confirmPassword: "x".repeat(257) }, 422, "password_policy_violation"],
      [{ currentPassword: CURRENT, newPassword: NEXT, confirmPassword: `${NEXT}!` }, 422, "password_policy_violation"],
      [{ currentPassword: CURRENT, newPassword: NEXT }, 400, "invalid_request"],
      [{ currentPassword: CURRENT, newPassword: NEXT, confirmPassword: NEXT, extra: "x" }, 400, "invalid_request"],
    ];
    for (const [payload, status, code] of cases) {
      const response = await post(app, "/api/me/password/change", current, payload);
      assert.equal(response.statusCode, status, JSON.stringify(payload));
      assert.deepEqual(response.json(), { error: { code } });
    }
    assert.equal(userRow(database, userId).password_hash, before);
    assert.equal(sessionRevoked(database, secondDevice.tokenHash), false);
    await app.close();
  });
});

test("account writes require a session, the exact origin and the session CSRF token", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { current, otherUser } = await setup(database);
    const app = buildApp({ account: dependencies(database) });
    const body = { currentPassword: CURRENT, newPassword: NEXT, confirmPassword: NEXT };
    for (const url of ["/api/me/password/change", "/api/me/email/change/start", "/api/me/email/change/confirm"]) {
      const payload = url.endsWith("confirm") ? { changeToken: "x", code: "123456" } : url.endsWith("start") ? { currentPassword: CURRENT, newEmail: "new@example.net" } : body;
      assert.deepEqual((await post(app, url, null, payload)).json(), { error: { code: "unauthorized" } });
      assert.equal((await post(app, url, current, payload, { "x-csrf-token": undefined })).statusCode, 403);
      assert.equal((await post(app, url, current, payload, { "x-csrf-token": otherUser.csrf })).statusCode, 403);
      assert.deepEqual((await post(app, url, current, payload, { origin: "https://evil.example" })).json(), { error: { code: "origin_rejected" } });
      assert.equal((await post(app, url, current, payload, { "x-requested-with": undefined })).statusCode, 400);
    }
    await app.close();
  });
});

test("password change attempts are rate limited per account", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { current } = await setup(database);
    const app = buildApp({ account: dependencies(database) });
    const wrong = { currentPassword: "wrong-password-00", newPassword: NEXT, confirmPassword: NEXT };
    for (let attempt = 0; attempt < ACCOUNT_PASSWORD_CHANGE_USER_LIMIT; attempt += 1) {
      assert.equal((await post(app, "/api/me/password/change", current, wrong)).statusCode, 401);
    }
    const limited = await post(app, "/api/me/password/change", current, { currentPassword: CURRENT, newPassword: NEXT, confirmPassword: NEXT });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { error: { code: "rate_limited" } });
    await app.close();
  });
});

test("email change start verifies the password and queues a code to the new address only", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { userId, current } = await setup(database);
    const app = buildApp({ account: dependencies(database) });
    const cases: Array<[unknown, number, string]> = [
      [{ currentPassword: "wrong-password-00", newEmail: "new@example.net" }, 401, "invalid_credentials"],
      [{ currentPassword: CURRENT, newEmail: "not-an-email" }, 400, "invalid_email"],
      [{ currentPassword: CURRENT, newEmail: " Owner@Example.net " }, 400, "email_unchanged"],
      [{ currentPassword: CURRENT, newEmail: "Taken@Example.net" }, 409, "email_taken"],
    ];
    for (const [payload, status, code] of cases) {
      const response = await post(app, "/api/me/email/change/start", current, payload);
      assert.equal(response.statusCode, status, JSON.stringify(payload));
      assert.deepEqual(response.json(), { error: { code } });
    }
    assert.equal(outbox(database).length, 0);

    const started = await post(app, "/api/me/email/change/start", current, { currentPassword: CURRENT, newEmail: " New@Example.net " });
    assert.equal(started.statusCode, 200);
    const body = started.json() as { status: string; changeToken: string; expiresAt: string };
    assert.equal(body.status, "ok");
    assert.match(body.changeToken, /^ec1\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(body.expiresAt, new Date(NOW.getTime() + 10 * 60_000).toISOString());
    const mails = outbox(database);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to_email, "new@example.net");
    assert.equal(mails[0]!.template, "verification_code");
    assert.match(mails[0]!.idempotency_key, new RegExp(`^email-change-otp-v1:${userId}:[0-9]+:[A-Za-z0-9_-]{22}$`));
    assert.match(emailedCode(database, "new@example.net"), /^[0-9]{6}$/);
    assert.equal(started.body.includes(emailedCode(database, "new@example.net")), false);
    assert.equal(userRow(database, userId).email, "owner@example.net");
    await app.close();
  });
});

test("email change confirm needs the emailed code, then switches the email once and notifies the old address", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { userId, current, secondDevice, otherUser } = await setup(database);
    const app = buildApp({ account: dependencies(database) });
    const { changeToken } = (await post(app, "/api/me/email/change/start", current, { currentPassword: CURRENT, newEmail: "new@example.net" })).json() as { changeToken: string };
    const code = emailedCode(database, "new@example.net");
    const wrongCode = code === "000000" ? "111111" : "000000";

    assert.deepEqual((await post(app, "/api/me/email/change/confirm", current, { changeToken, code: wrongCode })).json(), { error: { code: "invalid_code" } });
    assert.deepEqual((await post(app, "/api/me/email/change/confirm", current, { changeToken, code: "12ab56" })).json(), { error: { code: "invalid_code" } });
    const [head, version, payload, signature] = changeToken.split(".");
    const tampered = `${head}.${version}.${payload}.${signature!.slice(0, -1)}${signature!.endsWith("A") ? "B" : "A"}`;
    assert.deepEqual((await post(app, "/api/me/email/change/confirm", current, { changeToken: tampered, code })).json(), { error: { code: "invalid_or_expired" } });
    // Another account cannot use this token even with the right code.
    assert.deepEqual((await post(app, "/api/me/email/change/confirm", otherUser, { changeToken, code })).json(), { error: { code: "invalid_or_expired" } });
    assert.equal(userRow(database, userId).email, "owner@example.net");

    const confirmed = await post(app, "/api/me/email/change/confirm", current, { changeToken, code });
    assert.equal(confirmed.statusCode, 200);
    assert.deepEqual(confirmed.json(), { status: "ok" });
    assert.equal(userRow(database, userId).email, "new@example.net");
    assert.equal(userRow(database, userId).role, "user");
    assert.equal(sessionRevoked(database, current.tokenHash), false);
    assert.equal(sessionRevoked(database, secondDevice.tokenHash), true);
    const notice = outbox(database).find((mail) => mail.idempotency_key.startsWith("email-changed-notice-v1:"))!;
    assert.equal(notice.to_email, "owner@example.net");
    assert.equal(notice.template, "email_changed_notice");
    const actions = (database.prepare("SELECT action FROM audit_log WHERE action LIKE 'account.%' ORDER BY id").all() as Array<{ action: string }>).map((row) => row.action);
    assert.deepEqual(actions, ["account.email_change_request", "account.email_change"]);

    // The same token cannot be replayed once the email has changed.
    assert.deepEqual((await post(app, "/api/me/email/change/confirm", current, { changeToken, code })).json(), { error: { code: "invalid_or_expired" } });
    await app.close();
  });
});

test("email change tokens expire and a taken address is rechecked at confirm", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { current } = await setup(database);
    let now = new Date(NOW);
    const app = buildApp({ account: dependencies(database, () => new Date(now)) });
    const first = (await post(app, "/api/me/email/change/start", current, { currentPassword: CURRENT, newEmail: "late@example.net" })).json() as { changeToken: string };
    const firstCode = emailedCode(database, "late@example.net");
    now = new Date(NOW.getTime() + 10 * 60_000 + 1_000);
    assert.deepEqual((await post(app, "/api/me/email/change/confirm", current, { changeToken: first.changeToken, code: firstCode })).json(), { error: { code: "invalid_or_expired" } });

    now = new Date(NOW);
    const second = (await post(app, "/api/me/email/change/start", current, { currentPassword: CURRENT, newEmail: "race@example.net" })).json() as { changeToken: string };
    const secondCode = emailedCode(database, "race@example.net");
    insertAuthenticationUser(database, { email: "race@example.net", passwordHash: await currentHash(), status: "active" });
    assert.deepEqual((await post(app, "/api/me/email/change/confirm", current, { changeToken: second.changeToken, code: secondCode })).json(), { error: { code: "email_taken" } });
    await app.close();
  });
});

test("the dispatcher sends a current email-change code, drops it once stale, and sends the notice without a code", async () => {
  await withAuthenticationDatabase(async (database) => {
    const { current } = await setup(database);
    const app = buildApp({ account: dependencies(database) });
    const sent: MailDelivery[] = [];
    const dispatch = () => dispatchNextMail({
      database,
      mailPayloadEncKeyring: MAIL_KEYRING,
      transport: { send: async (delivery) => { sent.push(delivery); } },
      policy: { leaseMs: 60_000, maxAttempts: 3, retryDelayMs: () => 1_000 },
      now: () => new Date(NOW),
    });

    const { changeToken } = (await post(app, "/api/me/email/change/start", current, { currentPassword: CURRENT, newEmail: "new@example.net" })).json() as { changeToken: string };
    const code = emailedCode(database, "new@example.net");
    assert.deepEqual(await dispatch(), { outcome: "sent", attempts: 1 });
    assert.equal(sent[0]!.template, "verification_code");
    assert.equal(sent[0]!.verificationCode, code);
    assert.equal(sent[0]!.toEmail, "new@example.net");

    // A second code for the same address becomes stale once the change completes.
    await post(app, "/api/me/email/change/start", current, { currentPassword: CURRENT, newEmail: "new@example.net" });
    assert.equal((await post(app, "/api/me/email/change/confirm", current, { changeToken, code })).statusCode, 200);
    const outcomes = [await dispatch(), await dispatch()].map((result) => result.outcome).sort();
    assert.deepEqual(outcomes, ["failed", "sent"]);
    const notice = sent.find((delivery) => delivery.template === "email_changed_notice")!;
    assert.equal(notice.toEmail, "owner@example.net");
    assert.equal(notice.verificationCode, null);
    assert.equal(sent.filter((delivery) => delivery.template === "verification_code").length, 1);
    await app.close();
  });
});

test("the Resend transport words email-change codes and notices without leaking the new address", async () => {
  const bodies: Array<{ subject: string; text: string }> = [];
  const transport = new ResendMailTransport(
    { apiKey: "re_test_key", fromEmail: "noreply@example.net", requestTimeoutMs: 1_000, dispatcherLeaseMs: 5_000 },
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { subject: string; text: string });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    },
  );
  await transport.send({ idempotencyKey: "email-change-otp-v1:7:1790000000:AAAAAAAAAAAAAAAAAAAAAA", toEmail: "new@example.net", template: "verification_code", verificationCode: "042917" });
  await transport.send({ idempotencyKey: "email-changed-notice-v1:7:1790000000:AAAAAAAAAAAAAAAAAAAAAA", toEmail: "old@example.net", template: "email_changed_notice", verificationCode: null });
  assert.equal(bodies[0]!.subject, "Drink Life 邮箱变更验证码");
  assert.match(bodies[0]!.text, /042917/);
  assert.equal(bodies[1]!.subject, "Drink Life 登录邮箱已变更");
  assert.doesNotMatch(bodies[1]!.text, /new@example\.net|[0-9]{6}/);
  await assert.rejects(
    transport.send({ idempotencyKey: "email-changed-notice-v1:7:1790000000:AAAAAAAAAAAAAAAAAAAAAA", toEmail: "old@example.net", template: "email_changed_notice", verificationCode: "042917" }),
    /Mail delivery failed/,
  );
});
