import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MIGRATION_FILES,
  openAndVerifyDatabase,
  runMigrations,
  type DatabaseConnection,
} from "../../src/db.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";

const NOW = "2026-08-28T08:00:00.000Z";
const MIGRATIONS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/migrations",
);

function firstNumber(database: DatabaseConnection, query: string): number {
  const row = database.prepare(query).all()[0] as Record<string, unknown> | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "number") {
    throw new Error("query did not return a number");
  }
  return value;
}

function validInsert(database: DatabaseConnection, overrides = ""): void {
  database.exec(`
    INSERT INTO diagnosis_requests (
      contact_type, contact_value, business_scenario, target_region,
      problem_types, problem_description, safety_ack, status,
      created_at, updated_at${overrides ? `, ${overrides}` : ""}
    ) VALUES (
      'wechat', 'contact', 'tiktok_content', 'Japan',
      '["platform_environment_issue"]', 'problem details', 1, 'new',
      '${NOW}', '${NOW}'
    );
  `);
}

test("Migration 013 enforces frozen diagnosis checks, state combinations, and admin FK", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    validInsert(database);
    assert.throws(
      () =>
        database.exec(`
          INSERT INTO diagnosis_requests (
            contact_type, contact_value, business_scenario, target_region,
            problem_types, problem_description, safety_ack, status, created_at, updated_at
          ) VALUES ('phone', 'contact', 'tiktok_content', 'Japan', '[]',
                    'problem details', 0, 'new', '${NOW}', '${NOW}');
        `),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        database.exec(`
          INSERT INTO diagnosis_requests (
            contact_type, contact_value, business_scenario, target_region,
            problem_types, problem_description, safety_ack, status,
            classification, created_at, updated_at
          ) VALUES ('wechat', 'contact', 'tiktok_content', 'Japan',
                    '["access_failure"]', 'problem details', 1, 'new',
                    'network_plan', '${NOW}', '${NOW}');
        `),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        database.exec(`
          INSERT INTO diagnosis_requests (
            contact_type, contact_value, business_scenario, target_region,
            problem_types, problem_description, safety_ack, status,
            classification, handled_by_admin_id, handled_at, created_at, updated_at
          ) VALUES ('wechat', 'contact', 'tiktok_content', 'Japan',
                    '["access_failure"]', 'problem details', 1, 'handled',
                    'network_plan', 999999, '${NOW}', '${NOW}', '${NOW}');
        `),
      /FOREIGN KEY constraint failed/,
    );
    database.exec(`
      INSERT INTO diagnosis_requests (
        contact_type, contact_value, business_scenario, target_region,
        problem_types, problem_description, safety_ack, status,
        classification, handled_by_admin_id, handled_at, created_at, updated_at
      ) VALUES ('wechat', 'contact', 'tiktok_content', 'Japan',
                '["access_failure"]', 'problem details', 1, 'handled',
                'network_plan', ${adminId}, '${NOW}', '${NOW}', '${NOW}');
    `);
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 2);
  });
});

test("Migration 015 enforces canonical UUID, unique mapping, and restrictive ownership", async () => {
  await withAuthenticationDatabase((database) => {
    for (let index = 0; index < 6; index += 1) {
      validInsert(database);
    }
    const requestIds = (
      database.prepare("SELECT id FROM diagnosis_requests ORDER BY id").all() as Array<{
        readonly id: number;
      }>
    ).map((row) => row.id);
    const key = (variant: "8" | "9" | "a" | "b", sequence: number) =>
      `00000000-0000-4000-${variant}000-${sequence
        .toString(16)
        .padStart(12, "0")}`;

    for (const [index, variant] of (["8", "9", "a", "b"] as const).entries()) {
      database
        .prepare(
          `INSERT INTO diagnosis_request_idempotency (
             idempotency_key, diagnosis_request_id, created_at
           ) VALUES (?, ?, ?)`,
        )
        .run(key(variant, index + 1), requestIds[index], NOW);
    }

    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO diagnosis_request_idempotency (
               idempotency_key, diagnosis_request_id, created_at
             ) VALUES (?, ?, ?)`,
          )
          .run(key("8", 1), requestIds[4], NOW),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO diagnosis_request_idempotency (
               idempotency_key, diagnosis_request_id, created_at
             ) VALUES (?, ?, ?)`,
          )
          .run(key("8", 20), requestIds[0], NOW),
      /UNIQUE constraint failed/,
    );

    for (const invalid of [
      key("8", 30).toUpperCase(),
      key("8", 31).replace("-4", "-5"),
      key("8", 32).replace("-8000-", "-7000-"),
      key("8", 33).replace("00000000-", "000000000"),
      key("8", 34).replace(/.$/, "g"),
      ` ${key("8", 35)}`,
      `${key("8", 36)},${key("8", 37)}`,
    ]) {
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO diagnosis_request_idempotency (
                 idempotency_key, diagnosis_request_id, created_at
               ) VALUES (?, ?, ?)`,
            )
            .run(invalid, requestIds[4], NOW),
        /CHECK constraint failed/,
      );
    }

    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO diagnosis_request_idempotency (
               idempotency_key, diagnosis_request_id, created_at
             ) VALUES (?, 999999, ?)`,
          )
          .run(key("8", 40), NOW),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () =>
        database
          .prepare("DELETE FROM diagnosis_requests WHERE id = ?")
          .run(requestIds[0]),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      4,
    );
  });
});

test("applies Migration 016 to an existing 001-015 database without changing legacy rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "diagnosis-migration-compat-"));
  const database = openAndVerifyDatabase(join(directory, "auth.sqlite"));
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (const file of MIGRATION_FILES.slice(0, -1)) {
      const sql = await readFile(join(MIGRATIONS_DIRECTORY, file), "utf8");
      const version = Number.parseInt(file.slice(0, 3), 10);
      const operation = database.transaction(() => {
        database.exec(sql);
        database
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(version, NOW);
      });
      operation();
    }
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.test",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    database
      .prepare(
        `INSERT INTO orders (
           order_ref, idempotency_key, request_fingerprint, user_id,
           type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
           amount_fen, currency, contact, scenarios, notes, status,
           created_at, updated_at
         ) VALUES ('ORDER-1', 'idem-1', 'fingerprint', ?, 'local-isp', 'us',
                   'us-verizon', NULL, 'month-1', 'v1', 5900, 'CNY', 'contact',
                   '[]', NULL, 'pending', ?, ?)`,
      )
      .run(adminId, NOW, NOW);
    const orderId = firstNumber(database, "SELECT id FROM orders");
    database
      .prepare(
        `INSERT INTO payments (
           order_id, out_trade_no, channel, app_id, amount_fen, currency,
           status, created_at, updated_at, reserved_until
         ) VALUES (?, 'TRADE-1', 'alipay_page', 'app-id', 5900, 'CNY',
                   'pending', ?, ?, ?)` ,
      )
      .run(orderId, NOW, NOW, "2026-08-28T08:30:00.000Z");
    const paymentId = firstNumber(database, "SELECT id FROM payments");
    database
      .prepare(
        `INSERT INTO services (payment_id, status, created_at, updated_at)
         VALUES (?, 'pending_open', ?, ?)`,
      )
      .run(paymentId, NOW, NOW);
    const serviceId = firstNumber(database, "SELECT id FROM services");
    database
      .prepare(
        `INSERT INTO service_delivery_items (
           service_id, position, label, key_version, nonce, ciphertext, tag,
           created_at, updated_at
         ) VALUES (?, 1, 'Primary subscription', 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        serviceId,
        Buffer.from("nonce"),
        Buffer.from("ciphertext"),
        Buffer.from("tag"),
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO diagnosis_requests (
           contact_type, contact_value, business_scenario, target_region,
           problem_types, problem_description, safety_ack, current_region,
           current_isp, current_network_type, problem_frequency,
           is_existing_customer, preferred_contact_window, extra_notes,
           status, classification, admin_note, handled_by_admin_id, handled_at,
           created_at, updated_at
         ) VALUES (
           'email', 'legacy@example.test', 'ai_development', 'Example Region',
           '["access_failure","performance_instability"]',
           'legacy diagnosis details', 1, 'Example City', 'Example ISP',
           'home_broadband', 'intermittent', 0, '09:00-12:00',
           'legacy note', 'new', NULL, NULL, NULL, NULL, ?, ?
         )`,
      )
      .run(NOW, NOW);

    const legacyDiagnosisBefore = database
      .prepare("SELECT * FROM diagnosis_requests")
      .all();

    const before = {
      users: firstNumber(database, "SELECT COUNT(*) FROM users"),
      orders: firstNumber(database, "SELECT COUNT(*) FROM orders"),
      payments: firstNumber(database, "SELECT COUNT(*) FROM payments"),
      services: firstNumber(database, "SELECT COUNT(*) FROM services"),
      deliveryItems: firstNumber(
        database,
        "SELECT COUNT(*) FROM service_delivery_items",
      ),
    };
    runMigrations(database);
    runMigrations(database);
    assert.deepEqual(
      {
        users: firstNumber(database, "SELECT COUNT(*) FROM users"),
        orders: firstNumber(database, "SELECT COUNT(*) FROM orders"),
        payments: firstNumber(database, "SELECT COUNT(*) FROM payments"),
        services: firstNumber(database, "SELECT COUNT(*) FROM services"),
        deliveryItems: firstNumber(
          database,
          "SELECT COUNT(*) FROM service_delivery_items",
        ),
      },
      before,
    );
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM schema_migrations"), 16);
    assert.deepEqual(
      database.prepare("SELECT * FROM diagnosis_requests").all(),
      legacyDiagnosisBefore,
    );
    assert.equal(firstNumber(database, "SELECT COUNT(*) FROM diagnosis_requests"), 1);
    assert.equal(
      firstNumber(
        database,
        "SELECT COUNT(*) FROM diagnosis_request_idempotency",
      ),
      0,
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info(service_delivery_items)")
        .all()
        .map((row) => (row as { readonly name: string }).name)
        .includes("monitor_target_key"),
      true,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT service_id, position, label, key_version, monitor_target_key
           FROM service_delivery_items`,
        )
        .all(),
      [
        {
          service_id: serviceId,
          position: 1,
          label: "Primary subscription",
          key_version: 1,
          monitor_target_key: null,
        },
      ],
    );
    database
      .prepare(
        "UPDATE service_delivery_items SET monitor_target_key = ? WHERE service_id = ?",
      )
      .run("target-example-1", serviceId);
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE service_delivery_items SET monitor_target_key = ? WHERE service_id = ?",
          )
          .run(" invalid-target ", serviceId),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
