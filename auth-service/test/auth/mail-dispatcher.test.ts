import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseConnection } from "../../src/db.js";
import {
  dispatchNextMail,
  type MailDelivery,
  type MailDispatcherDependencies,
  type MailTransport,
} from "../../src/registration/mail-dispatcher.js";
import {
  computeMailRecipientAuditHmac,
  encryptRegistrationOtpPayload,
} from "../../src/registration/mail-outbox.js";
import type { TokenHmacKeyring } from "../../src/session/session-token.js";
import { withAuthenticationDatabase } from "./helpers.js";

const NOW = new Date("2026-08-29T00:00:00.000Z");
const MAIL_KEYS: TokenHmacKeyring = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x31).toString("base64"),
    "2": Buffer.alloc(32, 0x32).toString("base64"),
  },
};

function insertMail(
  database: DatabaseConnection,
  options: {
    readonly id?: number;
    readonly generation?: number;
    readonly email?: string;
    readonly otp?: string;
    readonly status?: "pending" | "sending";
    readonly attempts?: number;
    readonly nextAttemptAt?: string;
    readonly leasedUntil?: string | null;
    readonly leaseToken?: string | null;
  } = {},
): void {
  const encrypted = encryptRegistrationOtpPayload(
    {
      pendingRegistrationId: options.id ?? 41,
      otpGeneration: options.generation ?? 1,
      toEmail: options.email ?? "dispatcher.user@example.com",
      otp: options.otp ?? "042917",
    },
    MAIL_KEYS,
    () => Buffer.alloc(12, 0x61),
  );
  database
    .prepare(
      `INSERT INTO mail_outbox (
         idempotency_key, to_email, template, key_version, nonce, ciphertext,
         tag, status, attempts, next_attempt_at, leased_until, lease_token,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      encrypted.idempotencyKey,
      encrypted.toEmail,
      encrypted.template,
      encrypted.keyVersion,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.tag,
      options.status ?? "pending",
      options.attempts ?? 0,
      options.nextAttemptAt ?? NOW.toISOString(),
      options.leasedUntil ?? null,
      options.leaseToken ?? null,
      NOW.toISOString(),
    );
}

function row(
  database: DatabaseConnection,
  source: string,
  ...parameters: readonly unknown[]
): Record<string, unknown> | undefined {
  return database.prepare(source).all(...parameters)[0] as
    | Record<string, unknown>
    | undefined;
}

function dependencies(
  database: DatabaseConnection,
  transport: MailTransport,
  overrides: Partial<MailDispatcherDependencies> = {},
): MailDispatcherDependencies {
  return {
    database,
    mailPayloadEncKeyring: MAIL_KEYS,
    transport,
    policy: {
      leaseMs: 60_000,
      maxAttempts: 3,
      retryDelayMs: (attempts) => attempts * 30_000,
    },
    now: () => new Date(NOW),
    randomBytes: (size) => Buffer.alloc(size, 0x72),
    ...overrides,
  };
}

test("dispatches one due message and records only a recipient HMAC", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    const deliveries: MailDelivery[] = [];

    const result = await dispatchNextMail(
      dependencies(database, {
        async send(delivery) {
          deliveries.push(delivery);
        },
      }),
    );

    assert.deepEqual(result, { outcome: "sent", attempts: 1 });
    assert.deepEqual(deliveries, [
      {
        idempotencyKey: "register-otp-v1:41:1",
        toEmail: "dispatcher.user@example.com",
        template: "verification_code",
        verificationCode: "042917",
      },
    ]);
    assert.equal(row(database, "SELECT * FROM mail_outbox"), undefined);
    const audit = row(database, "SELECT * FROM mail_outbox_audit");
    assert.equal(audit?.outcome, "sent");
    assert.equal(audit?.final_attempts, 1);
    assert.equal(audit?.to_email_hmac, computeMailRecipientAuditHmac(
      "dispatcher.user@example.com",
      MAIL_KEYS,
      2,
    ));
    assert.notEqual(audit?.to_email_hmac, "dispatcher.user@example.com");
    assert.equal(JSON.stringify(audit).includes("042917"), false);
  });
});

test("leaves messages that are not due untouched", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database, { nextAttemptAt: "2026-08-29T00:00:01.000Z" });
    let sends = 0;

    const result = await dispatchNextMail(
      dependencies(database, {
        async send() {
          sends += 1;
        },
      }),
    );

    assert.deepEqual(result, { outcome: "idle" });
    assert.equal(sends, 0);
    assert.deepEqual(
      row(database, "SELECT status, attempts FROM mail_outbox"),
      { status: "pending", attempts: 0 },
    );
  });
});

test("schedules a retry without exposing a transport failure", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);

    const result = await dispatchNextMail(
      dependencies(database, {
        async send() {
          throw new Error("provider response contained private data");
        },
      }),
    );

    assert.deepEqual(result, { outcome: "retry_scheduled", attempts: 1 });
    assert.equal(JSON.stringify(result).includes("private data"), false);
    assert.deepEqual(
      row(
        database,
        `SELECT status, attempts, next_attempt_at, leased_until, lease_token
         FROM mail_outbox`,
      ),
      {
        status: "pending",
        attempts: 1,
        next_attempt_at: "2026-08-29T00:00:30.000Z",
        leased_until: null,
        lease_token: null,
      },
    );
    assert.equal(row(database, "SELECT * FROM mail_outbox_audit"), undefined);
  });
});

test("moves an exhausted message to the failed audit", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database, { attempts: 2 });

    const result = await dispatchNextMail(
      dependencies(database, {
        async send() {
          throw new Error("delivery failed");
        },
      }),
    );

    assert.deepEqual(result, { outcome: "failed", attempts: 3 });
    assert.equal(row(database, "SELECT * FROM mail_outbox"), undefined);
    assert.deepEqual(
      row(
        database,
        "SELECT outcome, final_attempts FROM mail_outbox_audit",
      ),
      { outcome: "failed", final_attempts: 3 },
    );
  });
});

test("does not send a pending message that already reached the attempt limit", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database, { attempts: 3 });
    let sends = 0;

    const result = await dispatchNextMail(
      dependencies(database, {
        async send() {
          sends += 1;
        },
      }),
    );

    assert.deepEqual(result, { outcome: "failed", attempts: 3 });
    assert.equal(sends, 0);
    assert.equal(row(database, "SELECT * FROM mail_outbox"), undefined);
    assert.equal(
      row(database, "SELECT final_attempts FROM mail_outbox_audit")
        ?.final_attempts,
      3,
    );
  });
});

test("reclaims an expired lease but does not take an active lease", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database, {
      status: "sending",
      attempts: 1,
      leasedUntil: "2026-08-28T23:59:59.000Z",
      leaseToken: "expired-token",
    });
    const deliveries: MailDelivery[] = [];
    const dispatcher = dependencies(database, {
      async send(delivery) {
        deliveries.push(delivery);
      },
    });

    assert.deepEqual(await dispatchNextMail(dispatcher), {
      outcome: "sent",
      attempts: 2,
    });
    assert.equal(deliveries.length, 1);

    insertMail(database, {
      id: 42,
      status: "sending",
      attempts: 1,
      leasedUntil: "2026-08-29T00:01:00.000Z",
      leaseToken: "active-token",
    });
    assert.deepEqual(await dispatchNextMail(dispatcher), { outcome: "idle" });
    assert.equal(deliveries.length, 1);
  });
});

test("prevents a second dispatcher from claiming an active delivery", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    let releaseFirst: (() => void) | undefined;
    let sends = 0;
    const first = dispatchNextMail(
      dependencies(database, {
        async send() {
          sends += 1;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        },
      }),
    );

    const second = await dispatchNextMail(
      dependencies(database, {
        async send() {
          sends += 1;
        },
      }),
    );
    assert.deepEqual(second, { outcome: "idle" });
    assert.equal(sends, 1);

    assert.ok(releaseFirst);
    releaseFirst();
    assert.deepEqual(await first, { outcome: "sent", attempts: 1 });
  });
});

test("does not finalize a delivery after its lease ownership changes", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);

    const result = await dispatchNextMail(
      dependencies(database, {
        async send() {
          database
            .prepare(
              `UPDATE mail_outbox
               SET lease_token = 'replacement-token'
               WHERE idempotency_key = 'register-otp-v1:41:1'`,
            )
            .run();
        },
      }),
    );

    assert.deepEqual(result, { outcome: "lease_lost", attempts: 1 });
    assert.equal(row(database, "SELECT * FROM mail_outbox")?.status, "sending");
    assert.equal(row(database, "SELECT * FROM mail_outbox_audit"), undefined);
  });
});

test("treats a tampered encrypted payload as a retryable safe failure", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    database
      .prepare("UPDATE mail_outbox SET tag = ?")
      .run(Buffer.alloc(16, 0xff));
    let sends = 0;

    const result = await dispatchNextMail(
      dependencies(database, {
        async send() {
          sends += 1;
        },
      }),
    );

    assert.deepEqual(result, { outcome: "retry_scheduled", attempts: 1 });
    assert.equal(sends, 0);
    assert.equal(row(database, "SELECT status FROM mail_outbox")?.status, "pending");
  });
});

test("rolls back a claim when lease token generation is invalid", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);

    await assert.rejects(
      dispatchNextMail(
        dependencies(
          database,
          { async send() {} },
          { randomBytes: () => Buffer.alloc(31) },
        ),
      ),
      /lease token generation failed/,
    );
    assert.deepEqual(
      row(database, "SELECT status, attempts FROM mail_outbox"),
      { status: "pending", attempts: 0 },
    );
    assert.equal(row(database, "SELECT * FROM mail_outbox_audit"), undefined);
  });
});

test("rejects an invalid attempt policy before claiming mail", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    const base = dependencies(database, { async send() {} });

    await assert.rejects(
      dispatchNextMail({
        ...base,
        policy: { ...base.policy, maxAttempts: 0 },
      }),
      /maximum attempts is invalid/,
    );
    assert.deepEqual(
      row(database, "SELECT status, attempts FROM mail_outbox"),
      { status: "pending", attempts: 0 },
    );
  });
});

test("fails before delivery when the audit key cannot be derived", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    let sends = 0;

    await assert.rejects(
      dispatchNextMail(
        dependencies(
          database,
          {
            async send() {
              sends += 1;
            },
          },
          {
            mailPayloadEncKeyring: {
              version: 9,
              keys: MAIL_KEYS.keys,
            },
          },
        ),
      ),
      /outbox keyring is invalid/,
    );
    assert.equal(sends, 0);
    assert.deepEqual(
      row(database, "SELECT status, attempts FROM mail_outbox"),
      { status: "pending", attempts: 0 },
    );
  });
});
