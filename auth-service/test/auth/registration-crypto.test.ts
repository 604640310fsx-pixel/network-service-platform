import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseConnection } from "../../src/db.js";
import {
  computeInviteCodeHashCandidates,
  InvalidInviteCodeError,
  lookupInviteCode,
  validateInviteCodeExact,
  type InviteHmacKeyring,
} from "../../src/registration/invite-code.js";
import {
  buildRegistrationOtpIdempotencyKey,
  decryptRegistrationOtpPayload,
  encryptRegistrationOtpPayload,
  MAIL_OUTBOX_AUTH_TAG_BYTES,
} from "../../src/registration/mail-outbox.js";
import {
  computeRegistrationOtpHash,
  computeRegistrationTokenHash,
  generateRegistrationOtp,
  generateRegistrationToken,
  RegistrationCryptoError,
  verifyRegistrationOtp,
} from "../../src/registration/registration-crypto.js";
import type { TokenHmacKeyring } from "../../src/session/session-token.js";

const KEY_0 = Buffer.alloc(32, 0x30).toString("base64");
const KEY_1 = Buffer.alloc(32, 0x31).toString("base64");
const KEY_2 = Buffer.alloc(32, 0x32).toString("base64");

const TOKEN_KEYRING: TokenHmacKeyring = {
  version: 2,
  keys: { "0": KEY_0, "1": KEY_1, "2": KEY_2 },
};

test("hashes the complete registration token with only its prefixed key", () => {
  const requested: string[] = [];
  const keys = new Proxy(
    { "0": KEY_0, "1": KEY_1, "2": KEY_2 },
    {
      get(target, property, receiver) {
        if (typeof property === "string") {
          requested.push(property);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const keyring: TokenHmacKeyring = { version: 2, keys };
  const rawToken = `v1.${Buffer.alloc(32, 0x41).toString("base64url")}`;

  const first = computeRegistrationTokenHash(rawToken, keyring);
  const second = computeRegistrationTokenHash(rawToken, keyring);

  assert.deepEqual(first, second);
  assert.equal(first.hmacKeyVersion, 1);
  assert.equal(first.tokenHash.length, 43);
  assert.deepEqual(new Set(requested), new Set(["1"]));
  assert.notEqual(
    first.tokenHash,
    computeRegistrationTokenHash(rawToken.replace("v1.", "v2."), keyring)
      .tokenHash,
  );
});

test("generates registration tokens with the frozen version and 256-bit random part", () => {
  const material = generateRegistrationToken(
    TOKEN_KEYRING,
    () => Buffer.alloc(32, 0x5a),
  );
  const match = /^v2\.([A-Za-z0-9_-]{43})$/.exec(material.rawToken);
  assert.ok(match);
  assert.equal(Buffer.from(match[1]!, "base64url").length, 32);
  assert.equal(material.hmacKeyVersion, 2);
  assert.equal(material.tokenHash.length, 43);
  assert.throws(
    () =>
      computeRegistrationTokenHash(
        `v9.${Buffer.alloc(32).toString("base64url")}`,
        TOKEN_KEYRING,
      ),
    RegistrationCryptoError,
  );
});

test("preserves leading-zero OTPs and uses only the row key version", () => {
  const requested: string[] = [];
  const keys = new Proxy(
    { "0": KEY_0, "1": KEY_1, "2": KEY_2 },
    {
      get(target, property, receiver) {
        if (typeof property === "string") {
          requested.push(property);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const keyring: TokenHmacKeyring = { version: 2, keys };
  const first = computeRegistrationOtpHash("042917", 1, keyring);
  const second = computeRegistrationOtpHash("042917", 1, keyring);

  assert.equal(first, second);
  assert.equal(first.length, 43);
  assert.equal(verifyRegistrationOtp("042917", first, 1, keyring), true);
  assert.equal(verifyRegistrationOtp("142917", first, 1, keyring), false);
  assert.deepEqual(new Set(requested), new Set(["1"]));
  assert.equal(generateRegistrationOtp(() => 7), "000007");
});

test("accepts exact invite input and reads current plus nearest previous", () => {
  const inviteCode = "ABCD-EFGH-JKMN-PQRS-TXYZ-WXYZ-2345";
  assert.equal(validateInviteCodeExact(inviteCode), inviteCode);

  const requested: string[] = [];
  const keys = new Proxy(
    { "0": KEY_0, "1": KEY_1, "2": KEY_2 },
    {
      get(target, property, receiver) {
        if (typeof property === "string") {
          requested.push(property);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const keyring: InviteHmacKeyring = { version: 2, keys };
  const candidates = computeInviteCodeHashCandidates(inviteCode, keyring);
  const repeated = computeInviteCodeHashCandidates(inviteCode, keyring);
  assert.deepEqual(
    candidates.map((candidate) => candidate.version),
    [2, 1],
  );
  assert.deepEqual(repeated, candidates);
  assert.equal(candidates.every((candidate) => candidate.codeHash.length === 43), true);
  assert.equal(requested.includes("0"), false);

  const currentOnly = computeInviteCodeHashCandidates(inviteCode, {
    version: 2,
    keys: { "2": KEY_2 },
  });
  assert.deepEqual(currentOnly.map((candidate) => candidate.version), [2]);
});

test("rejects malformed invite codes before preparing a database query", () => {
  let prepareCalls = 0;
  const database = {
    prepare() {
      prepareCalls += 1;
      throw new Error("database lookup should not run");
    },
  } as unknown as DatabaseConnection;
  const keyring: InviteHmacKeyring = {
    version: 2,
    keys: { "2": KEY_2 },
  };

  const exact = "ABCD-EFGH-JKMN-PQRS-TXYZ-WXYZ-2345";
  const rejected = [
    ` ${exact}`,
    `${exact} `,
    exact.toLowerCase(),
    exact.replaceAll("-", ""),
    "ABCD-EFGH-IJMN-PQRS-TXYZ-WXYZ-2345",
  ];

  for (const inviteCode of rejected) {
    assert.throws(
      () => lookupInviteCode(database, inviteCode, keyring),
      InvalidInviteCodeError,
    );
  }
  assert.equal(prepareCalls, 0);
});

test("encrypts OTP outbox payloads with a 16-byte GCM tag and stable idempotency", () => {
  const firstKey = buildRegistrationOtpIdempotencyKey(123, 2);
  const sameKey = buildRegistrationOtpIdempotencyKey(123, 2);
  const nextKey = buildRegistrationOtpIdempotencyKey(123, 3);
  assert.equal(firstKey, "register-otp-v1:123:2");
  assert.equal(sameKey, firstKey);
  assert.notEqual(nextKey, firstKey);
  assert.equal(firstKey.includes("042917"), false);

  const encrypted = encryptRegistrationOtpPayload(
    {
      pendingRegistrationId: 123,
      otpGeneration: 2,
      toEmail: " USER@EXAMPLE.COM ",
      otp: "042917",
    },
    TOKEN_KEYRING,
    () => Buffer.alloc(12, 0x7a),
  );
  assert.equal(encrypted.tag.length, MAIL_OUTBOX_AUTH_TAG_BYTES);
  assert.equal(encrypted.tag.length, 16);
  assert.equal(encrypted.toEmail, "user@example.com");
  assert.equal(decryptRegistrationOtpPayload(encrypted, TOKEN_KEYRING), "042917");
  assert.equal(encrypted.ciphertext.includes(Buffer.from("042917")), false);
});
