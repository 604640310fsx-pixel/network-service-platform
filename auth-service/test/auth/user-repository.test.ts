import assert from "node:assert/strict";
import test from "node:test";

import {
  findUserByEmail,
  findUserById,
  isUserLoginEligible,
} from "../../src/auth/user-repository.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

test("looks up only frozen authentication fields by canonical email and id", async () => {
  await withAuthenticationDatabase((database) => {
    const userId = insertAuthenticationUser(database, {
      email: "user.name+tag@example.com",
      passwordHash: "internal-hash",
      status: "active",
    });

    const byEmail = findUserByEmail(
      database,
      "  User.Name+tag@Example.COM  ",
    );
    const byId = findUserById(database, userId);

    assert.deepEqual(byEmail, byId);
    assert.deepEqual(Object.keys(byEmail ?? {}).sort(), [
      "email",
      "id",
      "passwordHash",
      "role",
      "status",
    ]);
    assert.equal(byEmail?.email, "user.name+tag@example.com");
    assert.equal(findUserByEmail(database, "missing@example.com"), null);
    assert.equal(findUserById(database, 999_999), null);
  });
});

test("only active users are login eligible", () => {
  const base = {
    id: 1,
    email: "user@example.com",
    passwordHash: "internal-hash",
    role: "user" as const,
  };

  assert.equal(isUserLoginEligible({ ...base, status: "active" }), true);
  assert.equal(isUserLoginEligible({ ...base, status: "disabled" }), false);
});
