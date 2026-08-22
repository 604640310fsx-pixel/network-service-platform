import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

function createBootstrapUser(database: DatabaseConnection): {
  readonly inviteCodeId: number;
  readonly userId: number;
} {
  database
    .prepare(
      `INSERT INTO invite_codes (
        code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
        expires_at, revoked_at, note, created_at
      ) VALUES (?, 1, NULL, 1, 0, ?, NULL, NULL, ?)`,
    )
    .run("bootstrap-code-hash", LATER, NOW);
  const inviteCodeId = firstNumber(
    database,
    "SELECT id FROM invite_codes WHERE code_hash = ?",
    "bootstrap-code-hash",
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
    const migrationRows = database
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all() as Array<{ readonly version: number; readonly applied_at: string }>;

    assert.deepEqual(
      migrationRows.map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
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

test("creates every frozen table and named index", async () => {
  await withTemporaryDatabase((database) => {
    assert.deepEqual(objectNames(database, "table"), [
      "audit_log",
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
      "schema_migrations",
      "service_delivery_items",
      "services",
      "session_families",
      "sessions",
      "sso_codes",
      "sso_states",
      "users",
    ]);

    assert.deepEqual(objectNames(database, "index"), [
      "idx_invite_codes_bootstrap_unique",
      "idx_notifications_payment",
      "idx_order_access_tokens_expiry",
      "idx_orders_status",
      "idx_orders_user",
      "idx_outbox_leased",
      "idx_outbox_pending",
      "idx_payments_status",
      "idx_pending_email",
      "idx_pending_expiry",
      "idx_rate_limit_window",
      "idx_redemptions_code",
      "idx_redemptions_user",
      "idx_reset_tokens_expiry",
      "idx_reset_tokens_user",
      "idx_service_delivery_items_service",
      "idx_services_status",
      "idx_session_families_user",
      "idx_sessions_family",
      "idx_sessions_user",
      "idx_sso_codes_state",
    ]);
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
            expires_at, created_at
          ) VALUES (?, 0, ?, 0, 0, ?, ?)`,
        )
        .run("invalid-max-uses", userId, LATER, NOW);
    }, /CHECK constraint failed/);

    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO invite_codes (
            code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
            expires_at, created_at
          ) VALUES (?, 0, ?, 1, -1, ?, ?)`,
        )
        .run("invalid-used-count", userId, LATER, NOW);
    }, /CHECK constraint failed/);

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
    }, /FOREIGN KEY constraint failed/);
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

    assert.ok(users.includes("password_hash"));
    assert.ok(!users.includes("password"));
    assert.ok(invites.includes("code_hash"));
    assert.ok(invites.includes("revoked_at"));
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
    assert.ok(!deliveryItems.includes("subscription_url"));
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
