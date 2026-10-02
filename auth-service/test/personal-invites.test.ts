import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app.js";
import {
  initializeDatabase,
  MIGRATION_FILES,
  openAndVerifyDatabase,
  runMigrations,
  type DatabaseConnection,
} from "../src/db.js";
import { createPaymentOrder } from "../src/payment/orders.js";
import { finalizePaid } from "../src/payment/state-machine.js";
import { ensureReferralProfile } from "../src/referral/profile.js";
import { computeInviteCodeHash } from "../src/registration/invite-code.js";
import {
  completeRegistration,
  InvalidOrExpiredRegistrationError,
  startRegistration,
  verifyRegistrationCode,
  type RegistrationServiceKeyrings,
} from "../src/registration/registration-service.js";
import { REGISTRATION_START_PERSONAL_CODE_LIMIT } from "../src/http/rate-limit.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "./auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  CSRF_KEY,
  TEST_NOW,
  TOKEN_KEYRING,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./payment/helpers.js";

const MIGRATIONS_DIRECTORY = [
  new URL("../src/migrations/", import.meta.url),
  new URL("../../src/migrations/", import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find((path) => existsSync(join(path, "001_users_and_invite_codes.sql")))!;

const keyring = (seed: number) => ({ version: 1, keys: { "1": Buffer.alloc(32, seed).toString("base64") } });
const KEYRINGS: RegistrationServiceKeyrings = {
  tokenHmacKeyring: TOKEN_KEYRING,
  inviteHmacKeyring: keyring(0x21),
  mailPayloadEncKeyring: keyring(0x31),
  rateLimitKeyring: keyring(0x41),
};
const NOW = new Date("2026-09-29T00:00:00.000Z");
const DEPENDENCIES = {
  now: () => new Date(NOW),
  randomInt: () => 123456,
  hashPassword: async (password: string) => `test-hash:${password.length}`,
};

function value(database: DatabaseConnection, sql: string, ...parameters: unknown[]): unknown {
  const row = database.prepare(sql).all(...parameters)[0] as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

function rows(database: DatabaseConnection, sql: string, ...parameters: unknown[]): unknown[] {
  return database.prepare(sql).all(...parameters);
}

// Applies migrations 001..lastVersion exactly as the runner would, leaving a
// database at that historical version (the runner itself only targets 021).
function applyPrefix(database: DatabaseConnection, lastVersion: number): void {
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const file of MIGRATION_FILES.slice(0, lastVersion)) {
    const sql = readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8");
    database.transaction(() => {
      database.exec(sql);
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        Number.parseInt(file.slice(0, 3), 10),
        NOW.toISOString(),
      );
    })();
  }
}

// A representative 020 database: legacy users, a freed id (sequence gap),
// sessions, a paid order + service, referral profile + candidate, a ticket,
// and an in-flight legacy pending registration.
function seed020(path: string) {
  const database = openAndVerifyDatabase(path);
  applyPrefix(database, 20);
  const adminId = insertAuthenticationUser(database, { email: "admin@example.test", passwordHash: "h", status: "active", role: "admin" });
  const customerId = insertAuthenticationUser(database, { email: "customer@example.test", passwordHash: "h", status: "active" });
  const referredId = insertAuthenticationUser(database, { email: "referred@example.test", passwordHash: "h", status: "active" });
  const doomedId = insertAuthenticationUser(database, { email: "doomed@example.test", passwordHash: "h", status: "active" });
  database.prepare("DELETE FROM users WHERE id = ?").run(doomedId);
  insertWebSession(database, customerId);
  let sequence = 0;
  const payment = paymentDependencies(database, undefined, () => `${String(++sequence).padStart(8, "0")}-9999-4999-8999-999999999999`);
  const order = createPaymentOrder(payment, {
    idempotencyKey: "seed-order", rawAccessToken: ACCESS_TOKEN_A, selection: localIspSelection(), contact: "c",
    scenarios: [], notes: null, acknowledgedAmountFen: 7_900, userId: customerId,
  });
  finalizePaid(payment, {
    outTradeNo: order.orderRef, tradeNo: "seed-trade", tradeStatus: "TRADE_SUCCESS", totalAmount: "79.00",
    totalAmountFen: 7_900, appId: "app-123", sellerId: "seller-456", notification: { notifyId: "seed", payloadHash: "seed" },
  });
  const profile = ensureReferralProfile(database, customerId, { now: () => NOW });
  const profileId = value(database, "SELECT id FROM referral_profiles WHERE user_id = ?", customerId);
  database.prepare("INSERT INTO referral_attribution_candidates (referred_user_id, source_profile_id, status, created_at) VALUES (?, ?, 'pending', ?)")
    .run(referredId, profileId, NOW.toISOString());
  database.prepare("INSERT INTO tickets (ticket_ref, user_id, subject, status, created_at, updated_at) VALUES ('TK00000000000000AA', ?, 's', 'open', ?, ?)")
    .run(customerId, NOW.toISOString(), NOW.toISOString());
  database.prepare("INSERT INTO ticket_messages (ticket_id, author_role, author_user_id, body, created_at) VALUES ((SELECT id FROM tickets), 'customer', ?, 'hello', ?)")
    .run(customerId, NOW.toISOString());
  const inviteHash = computeInviteCodeHash("ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567", KEYRINGS.inviteHmacKeyring, 1);
  database.prepare(`INSERT INTO invite_codes (code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count, expires_at, revoked_at, note, created_at, recipient_email)
    VALUES (?, 0, ?, 1, 0, '2026-12-31T00:00:00.000Z', NULL, NULL, ?, 'pending@example.test')`).run(inviteHash, adminId, NOW.toISOString());
  database.prepare(`INSERT INTO pending_registrations (email, registration_token_hash, registration_token_key_version, invite_code_id, otp_hash, otp_key_version,
      phase, last_sent_at, expires_at, created_at, referral_source_profile_id)
    VALUES ('pending@example.test', 'seed-token-hash', 1, (SELECT id FROM invite_codes WHERE recipient_email = 'pending@example.test'), 'seed-otp', 1,
      'awaiting_verification', ?, '2026-12-31T00:00:00.000Z', ?, ?)`).run(NOW.toISOString(), NOW.toISOString(), profileId);
  return { database, adminId, customerId, referredId, doomedId, publicCode: profile.publicCode };
}

const REFERENCE_TABLES = [
  "sessions", "session_families", "orders", "payments", "services", "referral_profiles",
  "referral_attribution_candidates", "tickets", "ticket_messages", "invite_codes", "invite_code_redemptions",
] as const;

function snapshot(database: DatabaseConnection) {
  return {
    users: rows(database, "SELECT id, email, password_hash, role, status, invited_by_code_id, created_at, updated_at FROM users ORDER BY id"),
    pending: rows(database, `SELECT id, email, registration_token_hash, registration_token_key_version, invite_code_id, otp_hash, otp_key_version,
      otp_generation, phase, verified_at, attempts, resend_count, last_sent_at, expires_at, consumed_at, superseded_at, created_at,
      referral_source_profile_id FROM pending_registrations ORDER BY id`),
    references: Object.fromEntries(REFERENCE_TABLES.map((table) => [table, rows(database, `SELECT * FROM ${table} ORDER BY rowid`)])),
    sequences: rows(database, "SELECT name, seq FROM sqlite_sequence WHERE name IN ('users', 'pending_registrations') ORDER BY name"),
  };
}

// Every table's full foreign-key list, so the rebuild can be shown to keep
// every FK pointing at the same table and columns.
function foreignKeyMap(database: DatabaseConnection) {
  const tables = (rows(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as Array<{ name: string }>)
    .map((row) => row.name);
  return Object.fromEntries(tables.map((table) => [
    table,
    rows(database, `SELECT "table" AS target, "from" AS source, "to" AS column, on_delete FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`),
  ]));
}

function withTempDir<Result>(run: (dir: string) => Result | Promise<Result>): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), "auth-personal-invites-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Migration 021 rebuild preserves every 020 user, reference, index, trigger, and sequence, and restarts idempotently", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "auth.sqlite");
    const seeded = seed020(path);
    const before = snapshot(seeded.database);
    const foreignKeysBefore = foreignKeyMap(seeded.database);
    assert.ok((before.sequences.find((row) => (row as { name: string }).name === "users") as { seq: number }).seq >= seeded.doomedId);
    seeded.database.close();

    const database = initializeDatabase(path);
    try {
      assert.deepEqual(rows(database, "SELECT version FROM schema_migrations ORDER BY version").map((row) => (row as { version: number }).version),
        Array.from({ length: 23 }, (_, index) => index + 1));
      const after = snapshot(database);
      // Initializing runs through 022 as well, which only adds three nullable services
      // columns: they must be NULL on existing rows, and every other field is unchanged.
      after.references.services = (after.references.services as Array<Record<string, unknown>>).map((row) => {
        const { ends_at, plan_override, admin_note, ...rest } = row;
        assert.deepEqual([ends_at, plan_override, admin_note], [null, null, null], "022 columns default to NULL");
        return rest;
      });
      assert.deepEqual(after.users, before.users, "every user keeps its id and fields");
      assert.deepEqual(after.pending, before.pending, "every pending registration keeps its id and fields");
      assert.deepEqual(after.references, before.references, "referencing rows keep their ids and bindings");
      assert.deepEqual(after.sequences, before.sequences, "AUTOINCREMENT high-water marks are preserved");
      assert.deepEqual(rows(database, "SELECT COUNT(*) AS c FROM users WHERE invited_by_user_id IS NOT NULL"), [{ c: 0 }]);
      assert.deepEqual(rows(database, "SELECT COUNT(*) AS c FROM pending_registrations WHERE personal_inviter_profile_id IS NOT NULL"), [{ c: 0 }]);
      assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
      // Every pre-existing table keeps exactly the same foreign keys and targets;
      // only the new users/pending columns add references.
      const foreignKeysAfter = foreignKeyMap(database);
      for (const [table, fks] of Object.entries(foreignKeysBefore)) {
        if (table === "users" || table === "pending_registrations") continue;
        assert.deepEqual(foreignKeysAfter[table], fks, `${table} foreign keys`);
      }
      for (const table of ["session_families", "orders", "referral_profiles", "tickets", "ticket_messages", "invite_codes"]) {
        assert.ok((foreignKeysAfter[table] as Array<{ target: string }>).some((fk) => fk.target === "users"), `${table} still targets users`);
      }
      assert.deepEqual(
        (foreignKeysAfter.users as Array<{ target: string; source: string }>).map((fk) => `${fk.source}->${fk.target}`).sort(),
        ["invited_by_code_id->invite_codes", "invited_by_user_id->users"],
      );
      assert.deepEqual(
        (foreignKeysAfter.pending_registrations as Array<{ target: string; source: string }>).map((fk) => `${fk.source}->${fk.target}`).sort(),
        ["invite_code_id->invite_codes", "personal_inviter_profile_id->referral_profiles", "referral_source_profile_id->referral_profiles"],
      );
      const objects = (type: string, table: string) =>
        (rows(database, "SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", type, table) as Array<{ name: string }>).map((row) => row.name);
      assert.deepEqual(objects("index", "pending_registrations"), ["idx_pending_email", "idx_pending_expiry"]);
      assert.deepEqual(objects("trigger", "pending_registrations"), [
        "trg_pending_registrations_binding_immutable", "trg_pending_registrations_personal_insert", "trg_pending_registrations_prebound_insert",
      ]);
      assert.deepEqual(objects("index", "users"), ["idx_users_invited_by_user"]);
      assert.deepEqual(objects("trigger", "users"), ["trg_users_invite_origin_immutable", "trg_users_inviter_active_insert"]);
      assert.equal(value(database, "SELECT COUNT(*) FROM sqlite_temp_master"), 0);
      // The legacy redemption trigger (it joins users) still resolves after the rebuild.
      assert.ok(rows(database, "SELECT name FROM sqlite_master WHERE name = 'trg_invite_code_redemptions_single_use_insert'").length === 1);
    } finally {
      database.close();
    }

    const restarted = initializeDatabase(path);
    try {
      assert.equal(value(restarted, "SELECT COUNT(*) FROM schema_migrations"), 23);
      assert.deepEqual(snapshot(restarted).users, before.users);
      assert.equal(restarted.pragma("foreign_keys", { simple: true }), 1);
    } finally {
      restarted.close();
    }
  });
});

function migrationsWith021(dir: string, transform: (sql: string) => string): string {
  const copy = join(dir, "migrations");
  mkdirSync(copy);
  for (const file of MIGRATION_FILES) copyFileSync(join(MIGRATIONS_DIRECTORY, file), join(copy, file));
  const target = join(copy, "021_personal_invites.sql");
  writeFileSync(target, transform(readFileSync(target, "utf8")));
  return copy;
}

test("a failed 021 check rolls back the rebuild and ledger, restores foreign keys, and aborts startup", async () => {
  for (const [name, transform, message] of [
    ["foreign-key violation", (sql: string) => `${sql}\nINSERT INTO referral_profiles (user_id, public_code, created_at) VALUES (999999, 'ZZZZZZZZZZZZZZZZZZZZZZZZ', '${NOW.toISOString()}');\n`, /foreign_key_check/],
    ["lost user row", (sql: string) => `${sql}\nDELETE FROM users WHERE email = 'referred@example.test';\n`, /did not preserve every users row/],
  ] as const) {
    await withTempDir((dir) => {
      const path = join(dir, "auth.sqlite");
      const seeded = seed020(path);
      const before = snapshot(seeded.database);
      const badMigrations = migrationsWith021(dir, transform);

      // Same connection: the failure rolls back and foreign keys are back ON.
      assert.throws(() => runMigrations(seeded.database, badMigrations), message, name);
      assert.equal(seeded.database.pragma("foreign_keys", { simple: true }), 1, `${name}: FK restored`);
      assert.equal(seeded.database.inTransaction, false);
      assert.equal(value(seeded.database, "SELECT MAX(version) FROM schema_migrations"), 20, `${name}: ledger not advanced`);
      assert.equal(rows(seeded.database, "SELECT name FROM pragma_table_info('users') WHERE name = 'invited_by_user_id'").length, 0, `${name}: schema unchanged`);
      assert.deepEqual(snapshot(seeded.database), before, `${name}: data unchanged`);
      seeded.database.close();

      // Startup path: initializeDatabase throws (and closes) instead of serving.
      assert.throws(() => initializeDatabase(path, badMigrations), message);
      const reopened = openAndVerifyDatabase(path);
      try {
        assert.equal(value(reopened, "SELECT MAX(version) FROM schema_migrations"), 20);
        assert.deepEqual(snapshot(reopened), before);
      } finally {
        reopened.close();
      }
    });
  }
});

test("startup migrates synchronously before any route, listener, or background worker exists", () => {
  const serverPath = [new URL("../src/server.ts", import.meta.url), new URL("../../src/server.ts", import.meta.url)]
    .map((url) => fileURLToPath(url))
    .find((path) => existsSync(path))!;
  const server = readFileSync(serverPath, "utf8");
  const migrate = server.indexOf("const database = initializeDatabase(config.dbPath);");
  assert.ok(migrate > 0);
  // initializeDatabase throws on any migration failure, so nothing below it runs.
  for (const later of ["await runRuntimeLifecycle({", "const app = buildApp({", "startOrderExpirySweep(payment)", "? startRegistrationMailRuntime("]) {
    const index = server.indexOf(later, migrate);
    assert.ok(index > migrate, later);
    assert.equal(server.lastIndexOf(later, migrate), -1, `${later} must not precede the migration`);
  }
});

test("the 021 path refuses to run inside a caller's transaction and leaves foreign keys ON", async () => {
  await withTempDir((dir) => {
    const seeded = seed020(join(dir, "auth.sqlite"));
    try {
      assert.throws(
        () => seeded.database.transaction(() => runMigrations(seeded.database))(),
        /must start outside a transaction/,
      );
      assert.equal(seeded.database.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(value(seeded.database, "SELECT MAX(version) FROM schema_migrations"), 20);
    } finally {
      seeded.database.close();
    }
  });
});

async function register(
  database: DatabaseConnection,
  input: { email: string; inviteCode: string; referralCode?: string; ip?: string },
): Promise<void> {
  const { registrationToken } = startRegistration(database, { ip: input.ip ?? "203.0.113.10", ...input }, KEYRINGS, DEPENDENCIES);
  const verified = verifyRegistrationCode(database, { registrationToken, otp: "123456", ip: "203.0.113.10" }, KEYRINGS, DEPENDENCIES);
  await completeRegistration(database, { registrationToken: verified.registrationToken, password: "a-long-password-123", ip: "203.0.113.10" }, KEYRINGS, DEPENDENCIES);
}

function userRow(database: DatabaseConnection, email: string) {
  return database.prepare("SELECT id, status, invited_by_code_id AS code, invited_by_user_id AS inviter FROM users WHERE email = ?").all(email)[0] as
    | { id: number; status: string; code: number | null; inviter: number | null }
    | undefined;
}

test("personal-code registration records exactly one real inviter and gives the invitee its own code", async () => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, { email: "owner@example.test", passwordHash: "h", status: "active" });
    const ownerCode = ensureReferralProfile(database, ownerId, { now: () => NOW }).publicCode;
    await register(database, { email: "invitee@example.test", inviteCode: ownerCode });
    const invitee = userRow(database, "invitee@example.test")!;
    assert.equal(invitee.inviter, ownerId);
    assert.equal(invitee.code, null, "no false legacy invite association");
    const inviteeCode = value(database, "SELECT public_code FROM referral_profiles WHERE user_id = ?", invitee.id);
    assert.match(String(inviteeCode), /^[A-Za-z0-9_-]{24}$/);
    assert.notEqual(inviteeCode, ownerCode);
    assert.equal(value(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 0);
    // The owner's code is reusable and never rotated.
    await register(database, { email: "second@example.test", inviteCode: ownerCode, ip: "203.0.113.11" });
    assert.equal(userRow(database, "second@example.test")!.inviter, ownerId);
    assert.equal(value(database, "SELECT public_code FROM referral_profiles WHERE user_id = ?", ownerId), ownerCode);
    // A matching optional referral code is allowed and keeps its existing candidate meaning.
    await register(database, { email: "third@example.test", inviteCode: ownerCode, referralCode: ownerCode, ip: "203.0.113.12" });
    const third = userRow(database, "third@example.test")!;
    assert.equal(third.inviter, ownerId);
    assert.equal(value(database, "SELECT COUNT(*) FROM referral_attribution_candidates WHERE referred_user_id = ?", third.id), 1);
  });
});

test("legacy admin invites stay single-use, never become personal invitees, and also get an own code", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, { email: "admin@example.test", passwordHash: "h", status: "active", role: "admin" });
    const code = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567";
    database.prepare(`INSERT INTO invite_codes (code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count, expires_at, revoked_at, note, created_at, recipient_email)
      VALUES (?, 0, ?, 1, 0, '2026-12-31T00:00:00.000Z', NULL, NULL, ?, 'legacy@example.test')`)
      .run(computeInviteCodeHash(code, KEYRINGS.inviteHmacKeyring, 1), adminId, NOW.toISOString());
    await register(database, { email: "legacy@example.test", inviteCode: code });
    const legacy = userRow(database, "legacy@example.test")!;
    assert.equal(typeof legacy.code, "number");
    assert.equal(legacy.inviter, null);
    assert.equal(value(database, "SELECT used_count FROM invite_codes WHERE recipient_email = 'legacy@example.test'"), 1);
    assert.equal(value(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 1);
    assert.equal(value(database, "SELECT COUNT(*) FROM referral_profiles WHERE user_id = ?", legacy.id), 1);
  });
});

test("unknown, disabled-owner, self, and conflicting-referral codes fail neutrally with no pending row", async () => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, { email: "owner@example.test", passwordHash: "h", status: "active" });
    const otherId = insertAuthenticationUser(database, { email: "other@example.test", passwordHash: "h", status: "active" });
    const disabledId = insertAuthenticationUser(database, { email: "disabled@example.test", passwordHash: "h", status: "disabled" });
    const ownerCode = ensureReferralProfile(database, ownerId, { now: () => NOW }).publicCode;
    const otherCode = ensureReferralProfile(database, otherId, { now: () => NOW }).publicCode;
    const disabledCode = ensureReferralProfile(database, disabledId, { now: () => NOW }).publicCode;
    let ip = 20;
    for (const input of [
      { email: "a@example.test", inviteCode: "Q".repeat(24) },
      { email: "b@example.test", inviteCode: disabledCode },
      { email: "owner@example.test", inviteCode: ownerCode },
      { email: "c@example.test", inviteCode: ownerCode, referralCode: otherCode },
      { email: "d@example.test", inviteCode: ownerCode, referralCode: "not-a-code" },
    ]) {
      const result = startRegistration(database, { ...input, ip: `203.0.113.${ip++}` }, KEYRINGS, DEPENDENCIES);
      assert.match(result.registrationToken, /^v[0-9]+\./, "same neutral response shape");
    }
    assert.equal(value(database, "SELECT COUNT(*) FROM pending_registrations"), 0);
    assert.equal(value(database, "SELECT COUNT(*) FROM mail_outbox"), 0);
  });
});

test("an owner disabled before completion blocks the registration without creating an account", async () => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, { email: "owner@example.test", passwordHash: "h", status: "active" });
    const ownerCode = ensureReferralProfile(database, ownerId, { now: () => NOW }).publicCode;
    const { registrationToken } = startRegistration(database, { email: "late@example.test", inviteCode: ownerCode, ip: "203.0.113.30" }, KEYRINGS, DEPENDENCIES);
    const verified = verifyRegistrationCode(database, { registrationToken, otp: "123456", ip: "203.0.113.30" }, KEYRINGS, DEPENDENCIES);
    database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(ownerId);
    await assert.rejects(
      completeRegistration(database, { registrationToken: verified.registrationToken, password: "a-long-password-123", ip: "203.0.113.30" }, KEYRINGS, DEPENDENCIES),
      (error) => error instanceof InvalidOrExpiredRegistrationError,
    );
    assert.equal(userRow(database, "late@example.test"), undefined);
  });
});

test("invite origin is exclusive, immutable, and cannot point at itself or an inactive account", async () => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, { email: "owner@example.test", passwordHash: "h", status: "active" });
    const disabledId = insertAuthenticationUser(database, { email: "disabled@example.test", passwordHash: "h", status: "disabled" });
    const codeId = value(database, "SELECT invited_by_code_id FROM users WHERE id = ?", ownerId);
    const insert = database.prepare(`INSERT INTO users (email, password_hash, role, status, invited_by_code_id, invited_by_user_id, created_at, updated_at)
      VALUES (?, 'h', 'user', 'active', ?, ?, ?, ?)`);
    const now = NOW.toISOString();
    assert.throws(() => insert.run("both@example.test", codeId, ownerId, now, now), /constraint failed/);
    assert.throws(() => insert.run("none@example.test", null, null, now, now), /constraint failed/);
    assert.throws(() => insert.run("inactive@example.test", null, disabledId, now, now), /user_inviter_invalid/);
    insert.run("child@example.test", null, ownerId, now, now);
    const childId = value(database, "SELECT id FROM users WHERE email = 'child@example.test'");
    for (const [sql, args] of [
      ["UPDATE users SET invited_by_user_id = ? WHERE id = ?", [disabledId, childId]],
      ["UPDATE users SET invited_by_user_id = id WHERE id = ?", [childId]],
      ["UPDATE users SET invited_by_code_id = ? WHERE id = ?", [codeId, childId]],
      ["UPDATE users SET invited_by_code_id = NULL WHERE id = ?", [ownerId]],
    ] as const) {
      assert.throws(() => database.prepare(sql).run(...args), /user_invite_origin_is_immutable/, sql);
    }
    assert.equal(value(database, "SELECT invited_by_user_id FROM users WHERE id = ?", childId), ownerId);
  });
});

test("shared personal-code use has its own bounded bucket and never drains the legacy per-invite cap", async () => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, { email: "owner@example.test", passwordHash: "h", status: "active" });
    const ownerCode = ensureReferralProfile(database, ownerId, { now: () => NOW }).publicCode;
    for (let index = 0; index < REGISTRATION_START_PERSONAL_CODE_LIMIT; index += 1) {
      startRegistration(database, { email: `p${index}@example.test`, inviteCode: ownerCode, ip: `198.51.100.${index + 1}` }, KEYRINGS, DEPENDENCIES);
    }
    assert.equal(value(database, "SELECT COUNT(*) FROM pending_registrations"), REGISTRATION_START_PERSONAL_CODE_LIMIT);
    // Over the personal bound: silenced neutrally.
    startRegistration(database, { email: "over@example.test", inviteCode: ownerCode, ip: "198.51.100.200" }, KEYRINGS, DEPENDENCIES);
    assert.equal(value(database, "SELECT COUNT(*) FROM pending_registrations WHERE email = 'over@example.test'"), 0);
    // The legacy invite path is untouched by that exhaustion.
    const adminId = insertAuthenticationUser(database, { email: "admin@example.test", passwordHash: "h", status: "active", role: "admin" });
    const code = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567";
    database.prepare(`INSERT INTO invite_codes (code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count, expires_at, revoked_at, note, created_at, recipient_email)
      VALUES (?, 0, ?, 1, 0, '2026-12-31T00:00:00.000Z', NULL, NULL, ?, 'legacy@example.test')`)
      .run(computeInviteCodeHash(code, KEYRINGS.inviteHmacKeyring, 1), adminId, NOW.toISOString());
    startRegistration(database, { email: "legacy@example.test", inviteCode: code, ip: "198.51.100.201" }, KEYRINGS, DEPENDENCIES);
    assert.equal(value(database, "SELECT COUNT(*) FROM pending_registrations WHERE email = 'legacy@example.test'"), 1);
    // Buckets store keyed hashes only, never the raw code.
    assert.equal(value(database, "SELECT COUNT(*) FROM rate_limit_buckets WHERE bucket_key LIKE ?", `%${ownerCode}%`), 0);
  });
});

test("/api/me/invites GET is read-only and POST ensures the stable code once behind session, Origin, and CSRF", async () => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, { email: "owner@example.test", passwordHash: "h", status: "active" });
    const otherId = insertAuthenticationUser(database, { email: "other@example.test", passwordHash: "h", status: "active" });
    const otherCode = ensureReferralProfile(database, otherId, { now: () => NOW }).publicCode;
    const session = insertWebSession(database, ownerId);
    // Sessions from the payment helper are created at TEST_NOW; read them on that clock.
    const app = buildApp({
      invites: { database, nodeEnv: "development", tokenHmacKeyring: TOKEN_KEYRING, csrfSigningKey: CSRF_KEY, now: () => new Date(TEST_NOW) },
    });
    const profiles = () => Number(value(database, "SELECT COUNT(*) FROM referral_profiles"));
    const get = (cookie?: string) => app.inject({ method: "GET", url: "/api/me/invites", headers: cookie ? { cookie } : {} });
    const post = (headers: Record<string, string>, payload = "{}") =>
      app.inject({ method: "POST", url: "/api/me/invites", headers, payload });
    const writeHeaders = {
      cookie: session.cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      "x-csrf-token": session.csrfToken,
    };
    try {
      assert.equal((await get()).statusCode, 401);

      // GET on an account without a code: explicit state, no write, no fake code.
      const before = profiles();
      const uninitialized = await get(session.cookie);
      assert.equal(uninitialized.statusCode, 200);
      assert.deepEqual(uninitialized.json(), { status: "uninitialized" });
      assert.equal(uninitialized.headers["cache-control"], "no-store");
      assert.equal(profiles(), before);

      // Every write gate refuses without provisioning anything.
      for (const [name, headers, status, code] of [
        ["no session", { ...writeHeaders, cookie: "" }, 401, "unauthorized"],
        ["no csrf", { ...writeHeaders, "x-csrf-token": "" }, 403, "csrf_invalid"],
        ["wrong csrf", { ...writeHeaders, "x-csrf-token": "A".repeat(43) }, 403, "csrf_invalid"],
        ["wrong origin", { ...writeHeaders, origin: "https://attacker.example" }, 400, "origin_rejected"],
        ["no xhr header", { ...writeHeaders, "x-requested-with": "" }, 400, "invalid_request"],
      ] as const) {
        const refused = await post(headers);
        assert.equal(refused.statusCode, status, name);
        assert.deepEqual(refused.json(), { error: { code } }, name);
      }
      assert.equal((await post(writeHeaders, JSON.stringify({ code: otherCode }))).statusCode, 400, "non-empty body");
      assert.equal(profiles(), before);

      // Concurrent ensures converge on one profile row and one code.
      const racing = await Promise.all(Array.from({ length: 6 }, () => post(writeHeaders)));
      assert.deepEqual(new Set(racing.map((response) => response.statusCode)), new Set([200]));
      assert.equal(new Set(racing.map((response) => response.json().code)).size, 1);
      assert.equal(profiles(), before + 1);

      // Repeats return the same stable code unchanged.
      const ensured = await post(writeHeaders);
      assert.equal(ensured.statusCode, 200);
      assert.equal(ensured.json().status, "ready");
      const code = ensured.json().code;
      assert.match(code, /^[A-Za-z0-9_-]{24}$/);
      assert.notEqual(code, otherCode);
      assert.equal(code, racing[0]?.json().code);
      assert.deepEqual((await post(writeHeaders)).json(), { status: "ready", code, directInviteCount: 0 });
      assert.equal(profiles(), before + 1);
      assert.deepEqual((await get(session.cookie)).json(), { status: "ready", code, directInviteCount: 0 });

      // Count only; the invitee's identity never appears.
      await register(database, { email: "invitee@example.test", inviteCode: code });
      const counted = await get(session.cookie);
      assert.deepEqual(counted.json(), { status: "ready", code, directInviteCount: 1 });
      assert.equal(counted.body.includes("invitee@example.test"), false);
      // The other account's code is never rotated by any of this.
      assert.equal(value(database, "SELECT public_code FROM referral_profiles WHERE user_id = ?", otherId), otherCode);
    } finally {
      await app.close();
    }
  });
});

test("ensure from two separate connections to one database yields one stable code", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "auth.sqlite");
    const first = initializeDatabase(path);
    const second = openAndVerifyDatabase(path);
    try {
      const userId = insertAuthenticationUser(first, { email: "owner@example.test", passwordHash: "h", status: "active" });
      const a = ensureReferralProfile(first, userId, { now: () => NOW });
      const b = ensureReferralProfile(second, userId, { now: () => NOW });
      assert.equal(b.publicCode, a.publicCode);
      assert.equal(ensureReferralProfile(first, userId, { now: () => NOW }).publicCode, a.publicCode);
      assert.equal(value(second, "SELECT COUNT(*) FROM referral_profiles WHERE user_id = ?", userId), 1);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("the start endpoint accepts exactly the legacy and personal code formats", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = buildApp({
      registration: {
        database, nodeEnv: "development", tokenHmacKeyring: KEYRINGS.tokenHmacKeyring, inviteHmacKeyring: KEYRINGS.inviteHmacKeyring,
        mailPayloadEncKeyring: KEYRINGS.mailPayloadEncKeyring, rateLimitKeyring: KEYRINGS.rateLimitKeyring,
      },
    });
    const headers = { origin: "http://localhost:5173", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
    try {
      for (const [inviteCode, status] of [
        ["ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567", 200], ["Q".repeat(24), 200], ["Q".repeat(23), 400], ["Q".repeat(25), 400], ["QQQQ-QQQQ", 400],
      ] as const) {
        const response = await app.inject({ method: "POST", url: "/api/auth/register/start", headers, payload: { email: "x@example.test", inviteCode } });
        assert.equal(response.statusCode, status, inviteCode);
      }
    } finally {
      await app.close();
    }
  });
});
