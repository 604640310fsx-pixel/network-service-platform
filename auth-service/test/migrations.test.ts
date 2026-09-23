import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  initializeDatabase,
  MIGRATION_FILES,
  openAndVerifyDatabase,
  readPragmaState,
  runMigrations,
  type DatabaseConnection,
} from "../src/db.js";

const NOW = "2026-08-17T12:00:00.000Z";
const LATER = "2026-08-18T12:00:00.000Z";

async function withTemporaryDatabase(
  operation: (database: DatabaseConnection) => void,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "auth-service-migrations-"),
  );
  const databasePath = join(temporaryDirectory, "auth.sqlite");
  let database: DatabaseConnection | undefined;

  try {
    database = initializeDatabase(databasePath);
    operation(database);
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function objectNames(database: DatabaseConnection, type: "table" | "index"): string[] {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type) as Array<{ readonly name: string }>;

  return rows.map((row) => row.name);
}

function columnNames(database: DatabaseConnection, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    readonly name: string;
  }>;

  return rows.map((row) => row.name);
}

function firstNumber(
  database: DatabaseConnection,
  source: string,
  ...parameters: readonly unknown[]
): number {
  const rows = database.prepare(source).all(...parameters) as Array<
    Record<string, unknown>
  >;
  const row = rows[0];
  const value = row === undefined ? undefined : Object.values(row)[0];

  if (typeof value !== "number") {
    throw new TypeError("query did not return a number");
  }

  return value;
}

function applyMigrationPrefix(
  database: DatabaseConnection,
  lastVersion: number,
): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const record = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const file of MIGRATION_FILES.slice(0, lastVersion)) {
    const version = Number.parseInt(file.slice(0, 3), 10);
    const migrationPath = [
      new URL(`../src/migrations/${file}`, import.meta.url),
      new URL(`../../src/migrations/${file}`, import.meta.url),
    ]
      .map((url) => fileURLToPath(url))
      .find(existsSync);
    if (migrationPath === undefined) {
      throw new Error(`test migration fixture is missing ${file}`);
    }
    const source = readFileSync(migrationPath, "utf8");
    const apply = database.transaction(() => {
      database.exec(source);
      record.run(version, NOW);
    });
    apply();
  }
}

function createBootstrapUser(database: DatabaseConnection): {
  readonly inviteCodeId: number;
  readonly userId: number;
} {
  database
    .prepare(
      `INSERT INTO invite_codes (
        code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
        expires_at, revoked_at, note, created_at
      ) VALUES (?, 1, NULL, 1, 0, ?, ?, NULL, ?)`,
    )
    .run("B".repeat(43), LATER, NOW, NOW);
  const inviteCodeId = firstNumber(
    database,
    "SELECT id FROM invite_codes WHERE code_hash = ?",
    "B".repeat(43),
  );

  database
    .prepare(
      `INSERT INTO users (
        email, password_hash, role, status, invited_by_code_id, created_at, updated_at
      ) VALUES (?, ?, 'admin', 'active', ?, ?, ?)`,
    )
    .run("admin@example.com", "argon2id-hash", inviteCodeId, NOW, NOW);
  const userId = firstNumber(
    database,
    "SELECT id FROM users WHERE email = ?",
    "admin@example.com",
  );

  return { inviteCodeId, userId };
}

test("applies the frozen migration sequence once and preserves SQLite PRAGMAs", async () => {
  await withTemporaryDatabase((database) => {
    assert.equal(
      MIGRATION_FILES.at(-1),
      "018_referral_attribution_candidates.sql",
    );
    const migrationRows = database
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all() as Array<{ readonly version: number; readonly applied_at: string }>;

    assert.deepEqual(
      migrationRows.map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    );
    for (const row of migrationRows) {
      assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    runMigrations(database);
    assert.equal(
      firstNumber(database, "SELECT COUNT(*) FROM schema_migrations"),
      MIGRATION_FILES.length,
    );
    assert.deepEqual(readPragmaState(database), {
      foreignKeys: 1,
      journalMode: "wal",
      busyTimeout: 5_000,
      synchronous: 1,
    });
  });
});

test("rejects applied migration histories that are not a prefix starting at 001", async () => {
  for (const history of [[1, 3], [2]]) {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "auth-service-migration-gap-"),
    );
    const database = openAndVerifyDatabase(
      join(temporaryDirectory, "auth.sqlite"),
    );

    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const insertMigration = database.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (const version of history) {
        insertMigration.run(version, NOW);
      }

      assert.throws(
        () => runMigrations(database),
        /continuous prefix starting at version 1/,
      );
      assert.deepEqual(
        (
          database
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .all() as Array<{ readonly version: number }>
        ).map((row) => row.version),
        history,
      );
    } finally {
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test("creates every frozen table and named index", async () => {
  await withTemporaryDatabase((database) => {
    assert.deepEqual(objectNames(database, "table"), [
      "audit_log",
      "coupon_plans",
      "coupon_redemptions",
      "coupons",
      "diagnosis_request_idempotency",
      "diagnosis_requests",
      "invite_code_redemptions",
      "invite_codes",
      "mail_outbox",
      "mail_outbox_audit",
      "order_access_tokens",
      "orders",
      "password_reset_tokens",
      "payment_notifications",
      "payments",
      "pending_registrations",
      "rate_limit_buckets",
      "referral_attribution_candidates",
      "referral_profiles",
      "schema_migrations",
      "sellable_plan_price_history",
      "sellable_plans",
      "service_delivery_items",
      "services",
      "session_families",
      "sessions",
      "sso_codes",
      "sso_states",
      "users",
    ]);

    assert.deepEqual(objectNames(database, "index"), [
      "idx_coupon_plans_plan",
      "idx_coupon_redemptions_coupon",
      "idx_coupons_active",
      "idx_diagnosis_requests_status_created",
      "idx_invite_codes_bootstrap_unique",
      "idx_invite_codes_open_recipient_unique",
      "idx_notifications_payment",
      "idx_order_access_tokens_expiry",
      "idx_orders_status",
      "idx_orders_user",
      "idx_outbox_leased",
      "idx_outbox_pending",
      "idx_payments_status",
      "idx_pending_email",
      "idx_pending_expiry",
      "idx_plan_price_history_plan",
      "idx_rate_limit_window",
      "idx_redemptions_code",
      "idx_redemptions_user",
      "idx_reset_tokens_expiry",
      "idx_reset_tokens_user",
      "idx_sellable_plans_active",
      "idx_sellable_plans_unique_combo",
      "idx_service_delivery_items_service",
      "idx_services_status",
      "idx_session_families_user",
      "idx_sessions_family",
      "idx_sessions_user",
      "idx_sso_codes_state",
    ]);
  });
});

test("payments gains a nullable reserved_until column", async () => {
  await withTemporaryDatabase((database) => {
    assert.ok(columnNames(database, "payments").includes("reserved_until"));
  });
});

test("Migration 017 creates only the minimal user-bound referral identity", async () => {
  await withTemporaryDatabase((database) => {
    assert.deepEqual(columnNames(database, "referral_profiles"), [
      "id",
      "user_id",
      "public_code",
      "created_at",
    ]);
    const { userId } = createBootstrapUser(database);
    database
      .prepare(
        `INSERT INTO referral_profiles (user_id, public_code, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(userId, "A".repeat(24), NOW);
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO referral_profiles (user_id, public_code, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(userId, "B".repeat(24), NOW),
      /UNIQUE constraint failed: referral_profiles.user_id/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO referral_profiles (user_id, public_code, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(999999, "C".repeat(24), NOW),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO referral_profiles (user_id, public_code, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(userId + 1, "contains.invalid.code!!", NOW),
      /CHECK constraint failed/,
    );
  });
});

test("Migration 018 adds only a server-linked pending referral candidate", async () => {
  await withTemporaryDatabase((database) => {
    assert.ok(
      columnNames(database, "pending_registrations").includes(
        "referral_source_profile_id",
      ),
    );
    assert.deepEqual(columnNames(database, "referral_attribution_candidates"), [
      "referred_user_id",
      "source_profile_id",
      "status",
      "created_at",
    ]);

    const { inviteCodeId, userId: sourceUserId } = createBootstrapUser(database);
    database
      .prepare(
        `INSERT INTO users (
           email, password_hash, role, status, invited_by_code_id, created_at, updated_at
         ) VALUES (?, ?, 'user', 'active', ?, ?, ?)`,
      )
      .run("referred@example.com", "argon2id-hash", inviteCodeId, NOW, NOW);
    const referredUserId = firstNumber(
      database,
      "SELECT id FROM users WHERE email = ?",
      "referred@example.com",
    );
    database
      .prepare(
        `INSERT INTO referral_profiles (user_id, public_code, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(sourceUserId, "R".repeat(24), NOW);
    const sourceProfileId = firstNumber(
      database,
      "SELECT id FROM referral_profiles WHERE user_id = ?",
      sourceUserId,
    );
    database
      .prepare(
        `INSERT INTO referral_attribution_candidates (
           referred_user_id, source_profile_id, status, created_at
         ) VALUES (?, ?, 'pending', ?)`,
      )
      .run(referredUserId, sourceProfileId, NOW);

    assert.deepEqual(
      database
        .prepare(
          `SELECT referred_user_id, source_profile_id, status, created_at
           FROM referral_attribution_candidates`,
        )
        .all(),
      [
        {
          referred_user_id: referredUserId,
          source_profile_id: sourceProfileId,
          status: "pending",
          created_at: NOW,
        },
      ],
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO referral_attribution_candidates (
               referred_user_id, source_profile_id, status, created_at
             ) VALUES (?, ?, 'pending', ?)`,
          )
          .run(referredUserId, sourceProfileId, LATER),
      /UNIQUE constraint failed: referral_attribution_candidates.referred_user_id/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO referral_attribution_candidates (
               referred_user_id, source_profile_id, status, created_at
             ) VALUES (?, ?, 'bound', ?)`,
          )
          .run(sourceUserId + 99, sourceProfileId, NOW),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO referral_attribution_candidates (
               referred_user_id, source_profile_id, status, created_at
             ) VALUES (?, ?, 'pending', ?)`,
          )
          .run(sourceUserId, sourceProfileId, NOW),
      /referral_candidate_self_attribution/,
    );
  });
});

test("Migration 012 seeds exactly 255 sellable plans with 29 initialized off-sale above the single-transaction cap", async () => {
  await withTemporaryDatabase((database) => {
    assert.equal(
      firstNumber(database, "SELECT COUNT(*) FROM sellable_plans"),
      255,
    );
    assert.equal(
      firstNumber(database, "SELECT COUNT(*) FROM sellable_plans WHERE is_active = 0"),
      29,
    );
    assert.equal(
      firstNumber(database, "SELECT COUNT(*) FROM sellable_plans WHERE is_active = 1"),
      226,
    );
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM sellable_plans WHERE is_active = 0 AND price_fen <= 200000",
      ),
      0,
    );
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM sellable_plans WHERE is_active = 1 AND price_fen > 200000",
      ),
      0,
    );
    assert.equal(
      firstNumber(database, "SELECT COUNT(*) FROM sellable_plans WHERE total_slots IS NOT NULL"),
      0,
    );
  });
});

test("seeded plan prices exactly match pricing.ts's current resolvePriceFen for every tuple", async () => {
  const { enumeratePriceTuples } = await import("../src/payment/pricing.js");
  await withTemporaryDatabase((database) => {
    for (const tuple of enumeratePriceTuples()) {
      const rows = database
        .prepare(
          `SELECT price_fen FROM sellable_plans
           WHERE type_id = ? AND region_id = ? AND isp_id = ?
             AND spec_id IS ? AND duration_id = ?`,
        )
        .all(
          tuple.typeId,
          tuple.regionId,
          tuple.ispId,
          tuple.specId,
          tuple.durationId,
        ) as ReadonlyArray<{ readonly price_fen: number }>;
      assert.equal(rows.length, 1, `missing seed row for ${JSON.stringify(tuple)}`);
      const [row] = rows;
      if (row === undefined) {
        throw new Error("unreachable: length check above guarantees one row");
      }
      assert.equal(row.price_fen, tuple.priceFen, JSON.stringify(tuple));
    }
  });
});

test("the NULL-safe unique index rejects a duplicate fixed-price plan (spec_id IS NULL)", async () => {
  await withTemporaryDatabase((database) => {
    const now = "2026-08-21T00:00:00.000Z";
    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO sellable_plans (
             type_id, region_id, isp_id, spec_id, duration_id,
             price_fen, is_active, total_slots, occupied_slots, created_at, updated_at
           ) VALUES ('us-local-carrier','us','ntt',NULL,'month-1',5900,1,NULL,0,?,?)`,
        )
        .run(now, now);
    }, /UNIQUE constraint failed/);
  });
});

test("Migration 016 revokes legacy codes without guessing email and preserves historical users and redemptions", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "auth-service-migration-016-upgrade-"),
  );
  const database = openAndVerifyDatabase(
    join(temporaryDirectory, "auth.sqlite"),
  );
  try {
    applyMigrationPrefix(database, 15);
    database
      .prepare(
        `INSERT INTO invite_codes (
           id, code_hash, is_bootstrap, created_by_admin_id, max_uses,
           used_count, expires_at, revoked_at, note, created_at
         ) VALUES (1, ?, 1, NULL, 1, 0, ?, NULL, NULL, ?)`,
      )
      .run("L".repeat(43), LATER, NOW);
    database
      .prepare(
        `INSERT INTO users (
           id, email, password_hash, role, status, invited_by_code_id,
           created_at, updated_at
         ) VALUES (1, 'legacy-admin@example.com', 'hash', 'admin', 'active', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `INSERT INTO invite_codes (
           id, code_hash, is_bootstrap, created_by_admin_id, max_uses,
           used_count, expires_at, revoked_at, note, created_at
         ) VALUES (2, ?, 0, 1, 5, 2, ?, NULL, NULL, ?)`,
      )
      .run("M".repeat(43), LATER, NOW);
    const insertHistoricalUser = database.prepare(
      `INSERT INTO users (
         id, email, password_hash, role, status, invited_by_code_id,
         created_at, updated_at
       ) VALUES (?, ?, 'hash', 'user', 'active', 2, ?, ?)`,
    );
    insertHistoricalUser.run(2, "legacy-one@example.com", NOW, NOW);
    insertHistoricalUser.run(3, "legacy-two@example.com", NOW, NOW);
    const insertRedemption = database.prepare(
      `INSERT INTO invite_code_redemptions (
         invite_code_id, user_id, redeemed_at, ip_address
       ) VALUES (2, ?, ?, '192.0.2.1')`,
    );
    insertRedemption.run(2, NOW);
    insertRedemption.run(3, NOW);
    const insertPending = database.prepare(
      `INSERT INTO pending_registrations (
         id, email, registration_token_hash, registration_token_key_version,
         invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
         verified_at, attempts, resend_count, last_sent_at, expires_at,
         consumed_at, superseded_at, created_at
       ) VALUES (?, ?, ?, 1, 2, ?, 1, 1, 'awaiting_verification',
                 NULL, 0, 1, ?, ?, ?, NULL, ?)`,
    );
    insertPending.run(
      41,
      "pending@example.com",
      "token-41",
      "otp-41",
      NOW,
      LATER,
      null,
      NOW,
    );
    insertPending.run(
      42,
      "consumed@example.com",
      "token-42",
      "otp-42",
      NOW,
      LATER,
      NOW,
      NOW,
    );
    const insertOutbox = database.prepare(
      `INSERT INTO mail_outbox (
         idempotency_key, to_email, template, key_version, nonce, ciphertext,
         tag, status, attempts, next_attempt_at, created_at
       ) VALUES (?, 'pending@example.com', 'verification_code', 1,
                 X'00', X'00', X'00', 'pending', 0, ?, ?)`,
    );
    insertOutbox.run("register-otp-v1:41:1", NOW, NOW);
    insertOutbox.run("register-otp-v1:42:1", NOW, NOW);
    insertOutbox.run("unrelated:41:1", NOW, NOW);
    const insertAudit = database.prepare(
      `INSERT INTO audit_log (actor, action, target_ref, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    insertAudit.run(
      "legacy-admin@example.com",
      "invite_code.create",
      "invite_code:2",
      NOW,
    );
    insertAudit.run(
      "legacy-admin@example.com",
      "invite_code.revoke",
      "invite_code:1",
      NOW,
    );
    insertAudit.run("legacy-admin@example.com", "auth.login", "user:1", NOW);

    runMigrations(database);
    assert.deepEqual(
      (
        database
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ readonly version: number }>
      ).map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT id, recipient_email, revoked_at
           FROM invite_codes ORDER BY id`,
        )
        .all()
        .map((row) => ({
          id: (row as { readonly id: number }).id,
          recipient_email: (row as { readonly recipient_email: unknown })
            .recipient_email,
          revoked: typeof (row as { readonly revoked_at: unknown }).revoked_at === "string",
        })),
      [
        { id: 1, recipient_email: null, revoked: true },
        { id: 2, recipient_email: null, revoked: true },
      ],
    );
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM users"), 3);
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 2);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM pending_registrations WHERE id = 41 AND superseded_at IS NOT NULL",
      ),
      1,
    );
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM pending_registrations WHERE id = 42 AND superseded_at IS NULL",
      ),
      1,
    );
    assert.deepEqual(
      database
        .prepare("SELECT idempotency_key FROM mail_outbox ORDER BY idempotency_key")
        .all(),
      [{ idempotency_key: "unrelated:41:1" }],
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT actor, action, target_ref, invite_code_id, result_class,
                  recipient_hmac
           FROM audit_log
           WHERE action GLOB 'invite_code.*'
           ORDER BY id`,
        )
        .all(),
      [
        {
          actor: "system:invite",
          action: "invite_code.create",
          target_ref: "invite_code:2",
          invite_code_id: null,
          result_class: "legacy_redacted",
          recipient_hmac: null,
        },
        {
          actor: "system:invite",
          action: "invite_code.revoke",
          target_ref: "invite_code:1",
          invite_code_id: null,
          result_class: "legacy_redacted",
          recipient_hmac: null,
        },
      ],
    );
    assert.deepEqual(
      database
        .prepare("SELECT actor, result_class FROM audit_log WHERE action = 'auth.login'")
        .all(),
      [{ actor: "legacy-admin@example.com", result_class: null }],
    );

    runMigrations(database);
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM schema_migrations"), 18);
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM invite_code_redemptions"), 2);
  } finally {
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Migration 016 triggers enforce prebinding, immutability, single use, and safe audit payloads", async () => {
  await withTemporaryDatabase((database) => {
    const { userId } = createBootstrapUser(database);
    const insertInvite = database.prepare(
      `INSERT INTO invite_codes (
         code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
         expires_at, revoked_at, note, created_at, recipient_email
       ) VALUES (?, 0, ?, 1, 0, ?, NULL, NULL, ?, ?)`,
    );
    insertInvite.run("C".repeat(43), userId, LATER, NOW, "bound@example.com");
    const inviteCodeId = firstNumber(
      database,
      "SELECT id FROM invite_codes WHERE code_hash = ?",
      "C".repeat(43),
    );

    assert.throws(
      () => insertInvite.run("D".repeat(43), userId, LATER, NOW, "bound@example.com"),
      /UNIQUE constraint failed: invite_codes.recipient_email/,
    );
    assert.throws(
      () => insertInvite.run("short", userId, LATER, NOW, "other@example.com"),
      /invite_code_prebound_single_use_required/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO invite_codes (
               code_hash, is_bootstrap, created_by_admin_id, max_uses,
               used_count, expires_at, revoked_at, created_at, recipient_email
             ) VALUES (?, 1, NULL, 1, 0, ?, NULL, ?, NULL)`,
          )
          .run("E".repeat(43), LATER, NOW),
      /invite_code_prebound_single_use_required/,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE invite_codes SET recipient_email = ? WHERE id = ?")
          .run("changed@example.com", inviteCodeId),
      /invite_code_binding_is_immutable/,
    );

    const insertPending = database.prepare(
      `INSERT INTO pending_registrations (
         email, registration_token_hash, registration_token_key_version,
         invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
         attempts, resend_count, last_sent_at, expires_at, created_at
       ) VALUES (?, ?, 1, ?, 'otp-hash', 1, 1, 'awaiting_verification',
                 0, 1, ?, ?, ?)`,
    );
    insertPending.run(
      "bound@example.com",
      "registration-token-1",
      inviteCodeId,
      NOW,
      LATER,
      NOW,
    );
    assert.throws(
      () =>
        insertPending.run(
          "mismatch@example.com",
          "registration-token-2",
          inviteCodeId,
          NOW,
          LATER,
          NOW,
        ),
      /pending_registration_invite_binding_mismatch/,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE pending_registrations SET email = ?")
          .run("changed@example.com"),
      /pending_registration_binding_is_immutable/,
    );

    database
      .prepare("UPDATE invite_codes SET used_count = 1 WHERE id = ?")
      .run(inviteCodeId);
    assert.throws(
      () =>
        database
          .prepare("UPDATE invite_codes SET used_count = 0 WHERE id = ?")
          .run(inviteCodeId),
      /invite_code_single_use_violation/,
    );
    database
      .prepare(
        `INSERT INTO users (
           email, password_hash, role, status, invited_by_code_id,
           created_at, updated_at
         ) VALUES ('bound@example.com', 'hash', 'user', 'active', ?, ?, ?)`,
      )
      .run(inviteCodeId, NOW, NOW);
    const invitedUserId = firstNumber(
      database,
      "SELECT id FROM users WHERE email = 'bound@example.com'",
    );
    database
      .prepare(
        `INSERT INTO invite_code_redemptions (
           invite_code_id, user_id, redeemed_at, ip_address
         ) VALUES (?, ?, ?, '192.0.2.1')`,
      )
      .run(inviteCodeId, invitedUserId, NOW);
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO invite_code_redemptions (
               invite_code_id, user_id, redeemed_at, ip_address
             ) VALUES (?, ?, ?, '192.0.2.2')`,
          )
          .run(inviteCodeId, invitedUserId, NOW),
      /invite_code_redemption_single_use_violation/,
    );

    insertInvite.run("F".repeat(43), userId, LATER, NOW, "revoke@example.com");
    const revokeId = firstNumber(
      database,
      "SELECT id FROM invite_codes WHERE code_hash = ?",
      "F".repeat(43),
    );
    database
      .prepare("UPDATE invite_codes SET revoked_at = ? WHERE id = ?")
      .run(NOW, revokeId);
    assert.throws(
      () =>
        database
          .prepare("UPDATE invite_codes SET revoked_at = NULL WHERE id = ?")
          .run(revokeId),
      /invite_code_revocation_is_final/,
    );

    const recipientHmac = `v2.${"A".repeat(43)}`;
    database
      .prepare(
        `INSERT INTO audit_log (
           actor, action, target_ref, created_at, invite_code_id,
           result_class, recipient_hmac
         ) VALUES ('system:invite', 'invite_code.create', NULL, ?, ?,
                   'issued', ?)`,
      )
      .run(NOW, revokeId, recipientHmac);
    const auditId = firstNumber(
      database,
      "SELECT id FROM audit_log WHERE action = 'invite_code.create'",
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO audit_log (
               actor, action, target_ref, created_at, invite_code_id,
               result_class, recipient_hmac
             ) VALUES ('admin@example.com', 'invite_code.create',
                       'raw@example.com', ?, ?, 'issued', 'raw@example.com')`,
          )
          .run(NOW, revokeId),
      /invite_audit_payload_is_unsafe/,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE audit_log SET result_class = 'changed' WHERE id = ?")
          .run(auditId),
      /invite_audit_is_immutable/,
    );
  });
});

test("enforces frozen UNIQUE, CHECK, enum, and foreign-key constraints", async () => {
  await withTemporaryDatabase((database) => {
    const { userId } = createBootstrapUser(database);

    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO users (
            email, password_hash, role, status, invited_by_code_id, created_at, updated_at
          ) VALUES (?, ?, 'user', 'active', 1, ?, ?)`,
        )
        .run("admin@example.com", "another-hash", NOW, NOW);
    }, /UNIQUE constraint failed/);

    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO invite_codes (
            code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
            expires_at, created_at, recipient_email
          ) VALUES (?, 0, ?, 0, 0, ?, ?, ?)`,
        )
        .run("C".repeat(43), userId, LATER, NOW, "max@example.com");
    }, /invite_code_prebound_single_use_required/);

    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO invite_codes (
            code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
            expires_at, created_at, recipient_email
          ) VALUES (?, 0, ?, 1, -1, ?, ?, ?)`,
        )
        .run("D".repeat(43), userId, LATER, NOW, "used@example.com");
    }, /invite_code_prebound_single_use_required/);

    assert.throws(() => {
      database
        .prepare(
          "INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)",
        )
        .run("orphan-family", 999_999, NOW);
    }, /FOREIGN KEY constraint failed/);

    database
      .prepare(
        "INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)",
      )
      .run("family-1", userId, NOW);

    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO sessions (
            token_hash, hmac_key_version, user_id, session_family_id, audience,
            created_at, expires_at, last_seen_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run("session-hash", userId, "family-1", "invalid", NOW, LATER, NOW);
    }, /CHECK constraint failed/);

    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO invite_code_redemptions (
            invite_code_id, user_id, redeemed_at, ip_address
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(999_999, userId, NOW, "127.0.0.1");
    }, /invite_code_redemption_single_use_violation/);
  });
});

test("keeps token, OTP, invite, reset, and outbox storage boundaries", async () => {
  await withTemporaryDatabase((database) => {
    const users = columnNames(database, "users");
    const invites = columnNames(database, "invite_codes");
    const sessions = columnNames(database, "sessions");
    const pending = columnNames(database, "pending_registrations");
    const resets = columnNames(database, "password_reset_tokens");
    const states = columnNames(database, "sso_states");
    const codes = columnNames(database, "sso_codes");
    const outbox = columnNames(database, "mail_outbox");
    const deliveryItems = columnNames(database, "service_delivery_items");
    const diagnosisIdempotency = columnNames(
      database,
      "diagnosis_request_idempotency",
    );

    assert.ok(users.includes("password_hash"));
    assert.ok(!users.includes("password"));
    assert.ok(invites.includes("code_hash"));
    assert.ok(invites.includes("revoked_at"));
    assert.ok(invites.includes("recipient_email"));
    assert.ok(!invites.includes("code"));
    assert.ok(!invites.includes("disabled_at"));
    assert.ok(sessions.includes("token_hash"));
    assert.ok(sessions.includes("hmac_key_version"));
    assert.ok(!sessions.includes("token"));
    assert.ok(pending.includes("registration_token_hash"));
    assert.ok(pending.includes("otp_hash"));
    assert.ok(!pending.includes("registration_token"));
    assert.ok(!pending.includes("otp"));
    assert.ok(!pending.includes("code_hash"));
    assert.ok(resets.includes("token_hash"));
    assert.ok(resets.includes("hmac_key_version"));
    assert.ok(resets.includes("used_at"));
    assert.ok(resets.includes("superseded_at"));
    assert.ok(!resets.includes("token"));
    assert.ok(!resets.includes("consumed_at"));
    assert.ok(states.includes("state_hash"));
    assert.ok(states.includes("browser_nonce_hash"));
    assert.ok(!states.includes("state"));
    assert.ok(!states.includes("browser_nonce"));
    assert.ok(codes.includes("code_hash"));
    assert.ok(!codes.includes("code"));
    for (const encryptedField of ["nonce", "ciphertext", "tag", "key_version"]) {
      assert.ok(outbox.includes(encryptedField));
    }
    for (const forbiddenField of ["recipient", "payload", "sent_at"]) {
      assert.ok(!outbox.includes(forbiddenField));
    }
    for (const encryptedField of ["nonce", "ciphertext", "tag", "key_version"]) {
      assert.ok(deliveryItems.includes(encryptedField));
    }
    assert.ok(deliveryItems.includes("monitor_target_key"));
    assert.ok(!deliveryItems.includes("subscription_url"));
    assert.deepEqual(diagnosisIdempotency, [
      "idempotency_key",
      "diagnosis_request_id",
      "created_at",
    ]);
  });
});

test("rolls back a failing migration without leaving its table or record", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "auth-service-failing-migration-"),
  );
  const migrationsDirectory = join(temporaryDirectory, "migrations");
  const databasePath = join(temporaryDirectory, "auth.sqlite");
  let database: DatabaseConnection | undefined;

  try {
    await mkdir(migrationsDirectory);
    for (const file of MIGRATION_FILES) {
      const version = Number.parseInt(file.slice(0, 3), 10);
      const sql =
        version === 9
          ? "CREATE TABLE migration_failure_probe (id INTEGER); INVALID SQL;"
          : `CREATE TABLE migration_step_${version} (id INTEGER);`;
      await writeFile(join(migrationsDirectory, file), sql, "utf8");
    }

    assert.throws(
      () => initializeDatabase(databasePath, migrationsDirectory),
      /near "INVALID": syntax error/,
    );

    database = openAndVerifyDatabase(databasePath);
    assert.deepEqual(
      (
        database
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ readonly version: number }>
      ).map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.ok(!objectNames(database, "table").includes("migration_failure_probe"));
    assert.deepEqual(readPragmaState(database), {
      foreignKeys: 1,
      journalMode: "wal",
      busyTimeout: 5_000,
      synchronous: 1,
    });
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a failing Migration 016 is atomic and does not record schema version 16", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "auth-service-failing-migration-016-"),
  );
  const migrationsDirectory = join(temporaryDirectory, "migrations");
  const databasePath = join(temporaryDirectory, "auth.sqlite");
  const database = openAndVerifyDatabase(databasePath);
  try {
    applyMigrationPrefix(database, 15);
    await mkdir(migrationsDirectory);
    for (const file of MIGRATION_FILES) {
      await writeFile(
        join(migrationsDirectory, file),
        file.startsWith("016_")
          ? "CREATE TABLE migration_016_probe (id INTEGER); INVALID SQL;"
          : "SELECT 1;",
        "utf8",
      );
    }
    assert.throws(
      () => runMigrations(database, migrationsDirectory),
      /near "INVALID": syntax error/,
    );
    assert.equal(
      firstNumber(database, "SELECT MAX(version) FROM schema_migrations"),
      15,
    );
    assert.equal(
      firstNumber(
        database,
        `SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name = 'migration_016_probe'`,
      ),
      0,
    );
  } finally {
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("missing, extra, and unknown migration registry states fail closed", async () => {
  for (const scenario of ["missing", "extra"] as const) {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), `auth-service-migration-files-${scenario}-`),
    );
    const migrationsDirectory = join(temporaryDirectory, "migrations");
    const database = openAndVerifyDatabase(
      join(temporaryDirectory, "auth.sqlite"),
    );
    try {
      await mkdir(migrationsDirectory);
      for (const file of MIGRATION_FILES) {
        if (scenario === "missing" && file.startsWith("018_")) continue;
        await writeFile(join(migrationsDirectory, file), "SELECT 1;", "utf8");
      }
      if (scenario === "extra") {
        await writeFile(
          join(migrationsDirectory, "019_unexpected.sql"),
          "SELECT 1;",
          "utf8",
        );
      }
      assert.throws(
        () => runMigrations(database, migrationsDirectory),
        /migration files do not match the frozen sequence/,
      );
      assert.equal(
        firstNumber(
          database,
          `SELECT COUNT(*) FROM sqlite_master
           WHERE type = 'table' AND name = 'schema_migrations'`,
        ),
        0,
      );
    } finally {
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "auth-service-migration-unknown-"),
  );
  const database = openAndVerifyDatabase(
    join(temporaryDirectory, "auth.sqlite"),
  );
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (19, '${NOW}');
    `);
    assert.throws(
      () => runMigrations(database),
      /database contains unknown migration version 19/,
    );
    assert.deepEqual(
      database.prepare("SELECT version FROM schema_migrations").all(),
      [{ version: 19 }],
    );
  } finally {
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
