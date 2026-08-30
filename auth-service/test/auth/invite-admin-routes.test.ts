import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import { computeInviteCodeHash } from "../../src/registration/invite-code.js";
import { computeSessionTokenHash } from "../../src/session/session-token.js";
import {
  CSRF_KEY,
  firstValue,
  insertWebSession,
  TEST_NOW,
  TOKEN_KEYRING,
} from "../payment/helpers.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "./helpers.js";

const INVITE_KEYRING = {
  version: 2,
  keys: {
    "1": Buffer.alloc(32, 0x51).toString("base64"),
    "2": Buffer.alloc(32, 0x52).toString("base64"),
  },
} as const;
const EXPIRES_AT = new Date(
  TEST_NOW.getTime() + 7 * 24 * 60 * 60 * 1_000,
).toISOString();

test("admin invite routes enforce role and CSRF while storing only the hash", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "invite-user@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "invite-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const userSession = insertWebSession(database, userId);
    const adminSession = insertWebSession(database, adminId);
    const csrfToken = issueCsrfToken(
      CSRF_KEY,
      computeSessionTokenHash(adminSession.rawToken, TOKEN_KEYRING).tokenHash,
    );
    const app = buildApp({
      inviteAdmin: {
        database,
        tokenHmacKeyring: TOKEN_KEYRING,
        inviteHmacKeyring: INVITE_KEYRING,
        csrfSigningKey: CSRF_KEY,
        now: () => new Date(TEST_NOW),
        randomBytes: (size) => Buffer.alloc(size, 0x01),
      },
    });

    try {
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/admin/invite-codes",
      });
      assert.equal(unauthenticated.statusCode, 401);

      const forbidden = await app.inject({
        method: "GET",
        url: "/api/admin/invite-codes",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(forbidden.statusCode, 403);

      const badCsrf = await app.inject({
        method: "POST",
        url: "/api/admin/invite-codes",
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": "x".repeat(43),
        },
        payload: { maxUses: 2, expiresAt: EXPIRES_AT },
      });
      assert.equal(badCsrf.statusCode, 403);
      assert.equal(
        firstValue(database, "SELECT COUNT(*) FROM invite_codes"),
        1,
      );

      const created = await app.inject({
        method: "POST",
        url: "/api/admin/invite-codes",
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        payload: { maxUses: 2, expiresAt: EXPIRES_AT },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.headers["cache-control"], "no-store");
      const createdBody = created.json<{
        readonly inviteCode: string;
        readonly item: {
          readonly id: number;
          readonly isBootstrap: boolean;
          readonly status: string;
          readonly maxUses: number;
          readonly usedCount: number;
          readonly expiresAt: string;
          readonly revokedAt: string | null;
          readonly createdAt: string;
        };
      }>();
      assert.match(
        createdBody.inviteCode,
        /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/,
      );
      assert.deepEqual(createdBody.item, {
        id: createdBody.item.id,
        isBootstrap: false,
        status: "usable",
        maxUses: 2,
        usedCount: 0,
        expiresAt: EXPIRES_AT,
        revokedAt: null,
        createdAt: TEST_NOW.toISOString(),
      });

      const stored = database
        .prepare(
          `SELECT code_hash, is_bootstrap, created_by_admin_id, note
           FROM invite_codes WHERE id = ?`,
        )
        .all(createdBody.item.id) as Array<Record<string, unknown>>;
      assert.equal(stored.length, 1);
      assert.deepEqual(stored[0], {
        code_hash: computeInviteCodeHash(
          createdBody.inviteCode,
          INVITE_KEYRING,
          INVITE_KEYRING.version,
        ),
        is_bootstrap: 0,
        created_by_admin_id: adminId,
        note: null,
      });
      assert.notEqual(stored[0]?.code_hash, createdBody.inviteCode);

      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/invite-codes",
        headers: { cookie: adminSession.cookie },
      });
      assert.equal(listed.statusCode, 200);
      const listedBody = listed.json<{
        readonly items: readonly Record<string, unknown>[];
        readonly total: number;
      }>();
      assert.equal(listedBody.total, 2);
      assert.equal(listedBody.items.length, 2);
      assert.equal(listedBody.items[0]?.status, "usable");
      assert.equal(listedBody.items[1]?.status, "expired");
      const serializedList = JSON.stringify(listedBody);
      assert.equal(serializedList.includes(createdBody.inviteCode), false);
      assert.equal(serializedList.includes("code_hash"), false);
      assert.equal(serializedList.includes("created_by_admin_id"), false);

      const revokeWithoutCsrf = await app.inject({
        method: "POST",
        url: `/api/admin/invite-codes/${createdBody.item.id}/revoke`,
        headers: { cookie: adminSession.cookie },
      });
      assert.equal(revokeWithoutCsrf.statusCode, 403);

      const revoked = await app.inject({
        method: "POST",
        url: `/api/admin/invite-codes/${createdBody.item.id}/revoke`,
        headers: {
          cookie: adminSession.cookie,
          "x-csrf-token": csrfToken,
        },
      });
      assert.equal(revoked.statusCode, 200);
      assert.equal(
        revoked.json<{ readonly item: { readonly status: string } }>().item
          .status,
        "revoked",
      );
      assert.equal(
        firstValue(
          database,
          "SELECT COUNT(*) FROM audit_log WHERE action IN ('invite_code.create', 'invite_code.revoke')",
        ),
        2,
      );

      const repeatedRevoke = await app.inject({
        method: "POST",
        url: `/api/admin/invite-codes/${createdBody.item.id}/revoke`,
        headers: {
          cookie: adminSession.cookie,
          "x-csrf-token": csrfToken,
        },
      });
      assert.equal(repeatedRevoke.statusCode, 200);
      assert.equal(
        firstValue(
          database,
          "SELECT COUNT(*) FROM audit_log WHERE action IN ('invite_code.create', 'invite_code.revoke')",
        ),
        2,
      );
    } finally {
      await app.close();
    }
  });
});

test("admin invite routes reject invalid creation and missing revoke targets", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "invite-admin-validation@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const adminSession = insertWebSession(database, adminId);
    const csrfToken = issueCsrfToken(
      CSRF_KEY,
      computeSessionTokenHash(adminSession.rawToken, TOKEN_KEYRING).tokenHash,
    );
    const app = buildApp({
      inviteAdmin: {
        database,
        tokenHmacKeyring: TOKEN_KEYRING,
        inviteHmacKeyring: INVITE_KEYRING,
        csrfSigningKey: CSRF_KEY,
        now: () => new Date(TEST_NOW),
        randomBytes: (size) => Buffer.alloc(size, 0x02),
      },
    });
    const headers = {
      cookie: adminSession.cookie,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    };
    const revokeHeaders = {
      cookie: adminSession.cookie,
      "x-csrf-token": csrfToken,
    };

    try {
      for (const payload of [
        { maxUses: 0, expiresAt: EXPIRES_AT },
        { maxUses: 1, expiresAt: TEST_NOW.toISOString() },
        { maxUses: 1, expiresAt: EXPIRES_AT, note: "not allowed" },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/invite-codes",
          headers,
          payload,
        });
        assert.equal(response.statusCode, 400);
      }

      const invalidId = await app.inject({
        method: "POST",
        url: "/api/admin/invite-codes/not-a-number/revoke",
        headers: revokeHeaders,
      });
      assert.equal(invalidId.statusCode, 400);

      const missing = await app.inject({
        method: "POST",
        url: "/api/admin/invite-codes/999/revoke",
        headers: revokeHeaders,
      });
      assert.equal(missing.statusCode, 404);
      assert.equal(
        firstValue(database, "SELECT COUNT(*) FROM audit_log"),
        0,
      );
    } finally {
      await app.close();
    }
  });
});
