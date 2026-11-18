import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeEmail,
  InvalidEmailError,
} from "../../src/auth/email.js";

test("canonicalizes frozen ASCII email syntax with trim and lowercase", () => {
  assert.equal(
    canonicalizeEmail("  User.Name+tag@Example-Domain.COM  "),
    "user.name+tag@example-domain.com",
  );
});

test("does not apply provider-specific dot or plus normalization", () => {
  assert.equal(
    canonicalizeEmail("First.Last+folder@gmail.com"),
    "first.last+folder@gmail.com",
  );
});

test("rejects non-ASCII, controls, CRLF, zero-width, bidi, and excessive length", () => {
  const invalidEmails = [
    "用户@example.com",
    "user\u0000@example.com",
    "user\r\n@example.com",
    "user\u200b@example.com",
    "user\u202e@example.com",
    `${"a".repeat(243)}@example.com`,
    "user@example",
  ];

  for (const email of invalidEmails) {
    assert.throws(() => canonicalizeEmail(email), InvalidEmailError);
  }
});
