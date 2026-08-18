import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadAuthCredentialConfig } from "../../src/config.js";

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
      join(directory, "rate_limit_key"),
      JSON.stringify({ version: 2, keys: { "1": KEY_V1, "2": KEY_V2 } }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, "csrf_signing_key"), `${CSRF_KEY}\n`, {
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
    assert.deepEqual(config.rateLimitKeyring, {
      version: 2,
      keys: { "1": KEY_V1, "2": KEY_V2 },
    });
    assert.equal(config.csrfSigningKey.length, 32);
    assert.equal(config.csrfSigningKey.toString("base64"), CSRF_KEY);
  });
});

test("fails closed without a credential directory or with invalid key material", async () => {
  assert.throws(
    () => loadAuthCredentialConfig({}),
    /Auth credential configuration is invalid/,
  );

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
