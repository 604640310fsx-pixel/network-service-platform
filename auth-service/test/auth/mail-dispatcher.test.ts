import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { DatabaseConnection } from "../../src/db.js";
import {
  dispatchNextMail,
  startMailDispatcher,
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
  const id = options.id ?? 41;
  const generation = options.generation ?? 1;
  const email = options.email ?? "dispatcher.user@example.com";
  database
    .prepare(
      `INSERT OR IGNORE INTO invite_codes (
         code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
         expires_at, revoked_at, note, created_at
       ) VALUES ('mail-dispatcher-test-invite', 1, NULL, 100, 0,
                 '2026-08-30T00:00:00.000Z', NULL, NULL, ?)`,
    )
    .run(NOW.toISOString());
  const invite = database
    .prepare(
      "SELECT id FROM invite_codes WHERE code_hash = 'mail-dispatcher-test-invite'",
    )
    .all()[0] as { readonly id: number };
  database
    .prepare(
      `INSERT INTO pending_registrations (
         id, email, registration_token_hash, registration_token_key_version,
         invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
         verified_at, attempts, resend_count, last_sent_at, expires_at,
         consumed_at, superseded_at, created_at
       ) VALUES (?, ?, ?, 2, ?, ?, 2, ?, 'awaiting_verification', NULL,
                 0, ?, ?, '2026-08-29T00:10:00.000Z', NULL, NULL, ?)`,
    )
    .run(
      id,
      email,
      `registration-token-${id}`,
      invite.id,
      `otp-hash-${id}-${generation}`,
      generation,
      generation,
      NOW.toISOString(),
      NOW.toISOString(),
    );
  const encrypted = encryptRegistrationOtpPayload(
    {
      pendingRegistrationId: id,
      otpGeneration: generation,
      toEmail: email,
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

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs: number = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await delay(5);
  }
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

test("never sends stale or non-current registration mail", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (database: DatabaseConnection) => void;
  }> = [
    {
      name: "expired",
      mutate: (database) => {
        database
          .prepare("UPDATE pending_registrations SET expires_at = ?")
          .run(NOW.toISOString());
      },
    },
    {
      name: "invalid expiry",
      mutate: (database) => {
        database
          .prepare("UPDATE pending_registrations SET expires_at = 'invalid'")
          .run();
      },
    },
    {
      name: "verified",
      mutate: (database) => {
        database
          .prepare(
            "UPDATE pending_registrations SET phase = 'verified', verified_at = ?",
          )
          .run(NOW.toISOString());
      },
    },
    {
      name: "consumed",
      mutate: (database) => {
        database
          .prepare("UPDATE pending_registrations SET consumed_at = ?")
          .run(NOW.toISOString());
      },
    },
    {
      name: "superseded",
      mutate: (database) => {
        database
          .prepare("UPDATE pending_registrations SET superseded_at = ?")
          .run(NOW.toISOString());
      },
    },
    {
      name: "newer generation",
      mutate: (database) => {
        database
          .prepare("UPDATE pending_registrations SET otp_generation = 2")
          .run();
      },
    },
    {
      name: "recipient mismatch",
      mutate: (database) => {
        database
          .prepare(
            "UPDATE pending_registrations SET email = 'other@example.com'",
          )
          .run();
      },
    },
    {
      name: "missing registration",
      mutate: (database) => {
        database.prepare("DELETE FROM pending_registrations").run();
      },
    },
    {
      name: "non-canonical idempotency key",
      mutate: (database) => {
        database
          .prepare(
            "UPDATE mail_outbox SET idempotency_key = 'register-otp-v1:041:1'",
          )
          .run();
      },
    },
  ];

  for (const fixture of cases) {
    await withAuthenticationDatabase(async (database) => {
      insertMail(database);
      fixture.mutate(database);
      let sends = 0;

      const result = await dispatchNextMail(
        dependencies(database, {
          async send() {
            sends += 1;
          },
        }),
      );

      assert.deepEqual(
        result,
        { outcome: "failed", attempts: 0 },
        fixture.name,
      );
      assert.equal(sends, 0, fixture.name);
      assert.equal(row(database, "SELECT * FROM mail_outbox"), undefined);
      assert.deepEqual(
        row(
          database,
          "SELECT outcome, final_attempts FROM mail_outbox_audit",
        ),
        { outcome: "failed", final_attempts: 0 },
        fixture.name,
      );
    });
  }
});

test("rechecks registration state after claim and before transport delivery", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    let clockCalls = 0;
    let sends = 0;

    const result = await dispatchNextMail(
      dependencies(
        database,
        {
          async send() {
            sends += 1;
          },
        },
        {
          now: () => {
            clockCalls += 1;
            if (clockCalls === 2) {
              database
                .prepare(
                  "UPDATE pending_registrations SET phase = 'verified', verified_at = ?",
                )
                .run(NOW.toISOString());
            }
            return new Date(NOW);
          },
        },
      ),
    );

    assert.deepEqual(result, { outcome: "failed", attempts: 1 });
    assert.equal(sends, 0);
    assert.equal(row(database, "SELECT * FROM mail_outbox"), undefined);
    assert.deepEqual(
      row(
        database,
        "SELECT outcome, final_attempts FROM mail_outbox_audit",
      ),
      { outcome: "failed", final_attempts: 1 },
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

test("the runner rejects unsafe timer intervals before scheduling work", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dispatcher = dependencies(database, { async send() {} });
    for (const intervalMs of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      assert.throws(
        () => startMailDispatcher(dispatcher, intervalMs),
        /Mail dispatcher interval is invalid/,
      );
    }
  });
});

test("the runner skips overlapping ticks and serially processes due mail", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    insertMail(database, { id: 42 });
    let activeSends = 0;
    let maxActiveSends = 0;
    let sends = 0;
    let releaseFirst: (() => void) | undefined;
    const runner = startMailDispatcher(
      dependencies(database, {
        async send() {
          sends += 1;
          activeSends += 1;
          maxActiveSends = Math.max(maxActiveSends, activeSends);
          if (sends === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          activeSends -= 1;
        },
      }),
      5,
    );

    try {
      await waitFor(
        () => releaseFirst !== undefined,
        "first mail dispatch did not start",
      );
      await delay(30);
      assert.equal(sends, 1);
      releaseFirst?.();
      await waitFor(() => sends === 2, "second mail dispatch did not start");
      assert.equal(maxActiveSends, 1);
    } finally {
      releaseFirst?.();
      await runner.stop();
    }
  });
});

test("runner stop waits for in-flight delivery and prevents future ticks", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    let sends = 0;
    let releaseSend: (() => void) | undefined;
    const runner = startMailDispatcher(
      dependencies(database, {
        async send() {
          sends += 1;
          await new Promise<void>((resolve) => {
            releaseSend = resolve;
          });
        },
      }),
      5,
    );

    await waitFor(
      () => releaseSend !== undefined,
      "mail dispatch did not start before stop",
    );
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await delay(20);
    assert.equal(stopped, false);
    releaseSend?.();
    await stopping;

    insertMail(database, { id: 42 });
    await delay(30);
    assert.equal(sends, 1);
    await runner.stop();
  });
});

test("the runner isolates one dispatcher rejection and resumes on a later tick", async () => {
  await withAuthenticationDatabase(async (database) => {
    insertMail(database);
    let randomCalls = 0;
    let sends = 0;
    const runner = startMailDispatcher(
      dependencies(
        database,
        {
          async send() {
            sends += 1;
          },
        },
        {
          randomBytes: (size) => {
            randomCalls += 1;
            return Buffer.alloc(randomCalls === 1 ? size - 1 : size, 0x72);
          },
        },
      ),
      5,
    );

    try {
      await waitFor(() => sends === 1, "mail runner did not recover");
      assert.ok(randomCalls >= 2);
      assert.equal(row(database, "SELECT * FROM mail_outbox"), undefined);
    } finally {
      await runner.stop();
    }
  });
});
