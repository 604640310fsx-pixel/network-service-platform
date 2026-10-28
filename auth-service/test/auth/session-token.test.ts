import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSessionTokenHash,
  generateSessionToken,
  SESSION_TOKEN_PATTERN,
  SessionTokenOperationError,
  type TokenHmacKeyring,
} from "../../src/session/session-token.js";

const KNOWN_MASTER_KEY =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const KEY_V1 = Buffer.alloc(32, 0x11).toString("base64");
const KEY_V2 = Buffer.alloc(32, 0x22).toString("base64");

function keyring(
  version: number,
  keys: Readonly<Record<string, string>>,
): TokenHmacKeyring {
  return { version, keys };
}

test("matches the frozen Session token HKDF/HMAC known-answer vector", () => {
  const rawToken = `v7.${"A".repeat(43)}`;
  const result = computeSessionTokenHash(
    rawToken,
    keyring(7, { "7": KNOWN_MASTER_KEY }),
  );

  assert.deepEqual(result, {
    tokenHash: "0qL944Krl05sCXpcPiHd4JR3i0Q4JxWDL85ENPnhjmc",
    hmacKeyVersion: 7,
  });
});

test("generates v<N> tokens with 256-bit random material and matching version", () => {
  const result = generateSessionToken(
    keyring(2, { "2": KEY_V2 }),
    (size) => {
      assert.equal(size, 32);
      return Buffer.alloc(size, 0x5a);
    },
  );
  const match = SESSION_TOKEN_PATTERN.exec(result.rawToken);

  assert.ok(match);
  assert.equal(match[1], "2");
  assert.equal(Buffer.from(match[2] ?? "", "base64url").length, 32);
  assert.equal(result.hmacKeyVersion, 2);
  assert.match(result.tokenHash, /^[A-Za-z0-9_-]{43}$/);
});

test("binds the hash to the complete token, version, and selected key", () => {
  const randomPart = "A".repeat(43);
  const bothKeys = keyring(2, { "1": KEY_V1, "2": KEY_V2 });
  const v1 = computeSessionTokenHash(`v1.${randomPart}`, bothKeys);
  const v2 = computeSessionTokenHash(`v2.${randomPart}`, bothKeys);
  const changedToken = computeSessionTokenHash(
    `v1.B${randomPart.slice(1)}`,
    bothKeys,
  );
  const changedKey = computeSessionTokenHash(
    `v1.${randomPart}`,
    keyring(1, { "1": KEY_V2 }),
  );

  assert.notEqual(v1.tokenHash, v2.tokenHash);
  assert.notEqual(v1.tokenHash, changedToken.tokenHash);
  assert.notEqual(v1.tokenHash, changedKey.tokenHash);
  assert.equal(v1.hmacKeyVersion, 1);
  assert.equal(v2.hmacKeyVersion, 2);
});

test("selects an old key by token prefix without falling back to other versions", () => {
  const rawToken = `v1.${"C".repeat(43)}`;
  const rotatedKeyring = keyring(2, { "1": KEY_V1, "2": KEY_V2 });
  const oldResult = computeSessionTokenHash(rawToken, rotatedKeyring);
  const originalResult = computeSessionTokenHash(
    rawToken,
    keyring(1, { "1": KEY_V1 }),
  );

  assert.deepEqual(oldResult, originalResult);
  assert.throws(
    () =>
      computeSessionTokenHash(
        `v9.${"C".repeat(43)}`,
        rotatedKeyring,
      ),
    SessionTokenOperationError,
  );
});

test("fails closed for malformed tokens, Base64 keys, and key lengths", () => {
  const validToken = `v1.${"D".repeat(43)}`;
  const invalidCases: Array<() => unknown> = [
    () => computeSessionTokenHash("not-a-token", keyring(1, { "1": KEY_V1 })),
    () => computeSessionTokenHash(validToken, keyring(1, { "1": "not-base64" })),
    () =>
      computeSessionTokenHash(
        validToken,
        keyring(1, { "1": Buffer.alloc(31).toString("base64") }),
      ),
    () => generateSessionToken(keyring(1, { "1": KEY_V1 }), () => Buffer.alloc(31)),
  ];

  for (const invalidCase of invalidCases) {
    assert.throws(invalidCase, SessionTokenOperationError);
  }
});
