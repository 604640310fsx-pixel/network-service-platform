import assert from "node:assert/strict";
import test from "node:test";

import {
  createMailDispatcherPolicy,
  startRegistrationMailRuntime,
} from "../../src/registration/mail-runtime.js";
import type { MailTransport } from "../../src/registration/mail-dispatcher.js";
import { withAuthenticationDatabase } from "./helpers.js";

const MAIL_KEYS = {
  version: 1,
  keys: { "1": Buffer.alloc(32, 0x41).toString("base64") },
} as const;

test("runtime policy maps each completed attempt to its frozen retry delay", () => {
  const policy = createMailDispatcherPolicy({
    intervalMs: 1000,
    leaseMs: 30000,
    maxAttempts: 3,
    retryDelaysMs: [2000, 4000],
  });

  assert.equal(policy.leaseMs, 30000);
  assert.equal(policy.maxAttempts, 3);
  assert.equal(policy.retryDelayMs(1), 2000);
  assert.equal(policy.retryDelayMs(2), 4000);
  assert.throws(() => policy.retryDelayMs(0), /retry attempt is invalid/);
  assert.throws(() => policy.retryDelayMs(3), /retry schedule is exhausted/);
});

test("runtime starts and stops an idle dispatcher without touching transport", async () => {
  await withAuthenticationDatabase(async (database) => {
    let transportCalls = 0;
    const transport: MailTransport = {
      send: async () => {
        transportCalls += 1;
      },
    };
    const runner = startRegistrationMailRuntime(
      { database, mailPayloadEncKeyring: MAIL_KEYS, transport },
      {
        intervalMs: 5,
        leaseMs: 30000,
        maxAttempts: 1,
        retryDelaysMs: [],
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runner.stop();
    await runner.stop();
    assert.equal(transportCalls, 0);
  });
});
