import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadAuthCredentialConfig,
  loadMailRuntimeConfig,
  loadResendCredentialConfig,
} from "../../src/config.js";

const KEY_V1 = Buffer.alloc(32, 0x31).toString("base64");
const KEY_V2 = Buffer.alloc(32, 0x32).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 0x33).toString("base64");

async function withCredentialDirectory<Result>(
  operation: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), "auth-credentials-"));
  try {
    await writeFile(
      join(directory, "token_hmac_keyring"),
      JSON.stringify({ version: 2, keys: { "1": KEY_V1, "2": KEY_V2 } }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "invite_hmac_keyring"),
      JSON.stringify({ version: 2, keys: { "1": KEY_V1, "2": KEY_V2 } }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "mail_payload_enc_keyring"),
      JSON.stringify({ version: 2, keys: { "1": KEY_V1, "2": KEY_V2 } }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "rate_limit_key"),
      JSON.stringify({ version: 2, keys: { "1": KEY_V1, "2": KEY_V2 } }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, "csrf_signing_key"), `${CSRF_KEY}\n`, {
      mode: 0o600,
    });
    await writeFile(join(directory, "resend_api_key"), "example_api_key\n", {
      mode: 0o600,
    });
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads only the frozen credential names and strict key formats", async () => {
  await withCredentialDirectory(async (directory) => {
    const config = loadAuthCredentialConfig({
      CREDENTIALS_DIRECTORY: directory,
    });

    assert.deepEqual(config.tokenHmacKeyring, {
      version: 2,
      keys: { "1": KEY_V1, "2": KEY_V2 },
    });
    assert.deepEqual(config.inviteHmacKeyring, {
      version: 2,
      keys: { "1": KEY_V1, "2": KEY_V2 },
    });
    assert.deepEqual(config.mailPayloadEncKeyring, {
      version: 2,
      keys: { "1": KEY_V1, "2": KEY_V2 },
    });
    assert.deepEqual(config.rateLimitKeyring, {
      version: 2,
      keys: { "1": KEY_V1, "2": KEY_V2 },
    });
    assert.equal(config.csrfSigningKey.length, 32);
    assert.equal(config.csrfSigningKey.toString("base64"), CSRF_KEY);
  });
});

const VALID_MAIL_ENVIRONMENT: NodeJS.ProcessEnv = {
  MAIL_DISPATCH_ENABLED: "true",
  MAIL_DISPATCH_INTERVAL_MS: "1000",
  MAIL_DISPATCH_LEASE_MS: "30000",
  MAIL_DISPATCH_MAX_ATTEMPTS: "3",
  MAIL_DISPATCH_RETRY_DELAYS_MS: "[1000,2000]",
  RESEND_FROM_EMAIL: "sender@example.com",
  RESEND_REQUEST_TIMEOUT_MS: "5000",
};

test("mail runtime requires explicit opt-in and ignores provider values when disabled", () => {
  assert.deepEqual(loadMailRuntimeConfig({ MAIL_DISPATCH_ENABLED: "false" }), {
    enabled: false,
  });
  assert.throws(
    () => loadMailRuntimeConfig({}),
    /Mail runtime configuration is invalid/,
  );
  assert.throws(
    () => loadMailRuntimeConfig({ MAIL_DISPATCH_ENABLED: " false " }),
    /Mail runtime configuration is invalid/,
  );
});

test("mail runtime loads only explicit bounded dispatcher and Resend values", () => {
  assert.deepEqual(loadMailRuntimeConfig(VALID_MAIL_ENVIRONMENT), {
    enabled: true,
    dispatcher: {
      intervalMs: 1000,
      leaseMs: 30000,
      maxAttempts: 3,
      retryDelaysMs: [1000, 2000],
    },
    resend: {
      fromEmail: "sender@example.com",
      requestTimeoutMs: 5000,
    },
  });
});

test("mail runtime fails closed on unsafe timing, retry, or sender values", () => {
  const invalidEnvironments: NodeJS.ProcessEnv[] = [
    { ...VALID_MAIL_ENVIRONMENT, MAIL_DISPATCH_INTERVAL_MS: "0" },
    { ...VALID_MAIL_ENVIRONMENT, MAIL_DISPATCH_LEASE_MS: "5000" },
    { ...VALID_MAIL_ENVIRONMENT, MAIL_DISPATCH_MAX_ATTEMPTS: "11" },
    { ...VALID_MAIL_ENVIRONMENT, MAIL_DISPATCH_RETRY_DELAYS_MS: "[1000]" },
    {
      ...VALID_MAIL_ENVIRONMENT,
      MAIL_DISPATCH_MAX_ATTEMPTS: "2",
      MAIL_DISPATCH_RETRY_DELAYS_MS: "[86400000]",
    },
    { ...VALID_MAIL_ENVIRONMENT, RESEND_FROM_EMAIL: "not-an-email" },
    { ...VALID_MAIL_ENVIRONMENT, RESEND_REQUEST_TIMEOUT_MS: "50000" },
  ];

  for (const environment of invalidEnvironments) {
    assert.throws(
      () => loadMailRuntimeConfig(environment),
      /Mail runtime configuration is invalid/,
    );
  }
});

test("Resend API key loads only from the private credential directory", async () => {
  assert.throws(
    () => loadResendCredentialConfig({}),
    /Resend credential configuration is invalid/,
  );

  await withCredentialDirectory(async (directory) => {
    assert.deepEqual(
      loadResendCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      { apiKey: "example_api_key" },
    );
    await writeFile(join(directory, "resend_api_key"), "not visible\nkey", {
      mode: 0o600,
    });
    assert.throws(
      () =>
        loadResendCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      /Resend credential configuration is invalid/,
    );
  });
});

test("fails closed without a credential directory or with invalid key material", async () => {
  assert.throws(
    () => loadAuthCredentialConfig({}),
    /Auth credential configuration is invalid/,
  );

  await withCredentialDirectory(async (directory) => {
    await writeFile(
      join(directory, "invite_hmac_keyring"),
      JSON.stringify({ version: 2, keys: { "2": "not-base64" } }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        loadAuthCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      /Auth credential configuration is invalid/,
    );
  });

  await withCredentialDirectory(async (directory) => {
    await writeFile(join(directory, "csrf_signing_key"), "not-base64", {
      mode: 0o600,
    });
    assert.throws(
      () =>
        loadAuthCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      /Auth credential configuration is invalid/,
    );
  });

  await withCredentialDirectory(async (directory) => {
    await writeFile(
      join(directory, "rate_limit_key"),
      JSON.stringify({ version: 3, keys: { "2": KEY_V2 } }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        loadAuthCredentialConfig({ CREDENTIALS_DIRECTORY: directory }),
      /Auth credential configuration is invalid/,
    );
  });
});
