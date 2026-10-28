import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import { computeInviteCodeHash } from "../../src/registration/invite-code.js";
import {
  createAdminInviteCode,
  InviteAdminDomainError,
} from "../../src/registration/invite-admin-service.js";
import { computeMailRecipientAuditHmac } from "../../src/registration/mail-outbox.js";
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
    "0": Buffer.alloc(32, 0x50).toString("base64"),
    "1": Buffer.alloc(32, 0x51).toString("base64"),
    "2": Buffer.alloc(32, 0x52).toString("base64"),
  },
} as const;
const RECIPIENT_HMAC_KEYRING = {
  version: 3,
  keys: {
    "3": Buffer.alloc(32, 0x63).toString("base64"),
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
        mailPayloadEncKeyring: RECIPIENT_HMAC_KEYRING,
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
        payload: {
          recipientEmail: "alice@example.com",
          expiresAt: EXPIRES_AT,
        },
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
        payload: {
          recipientEmail: " Alice@Example.com ",
          expiresAt: EXPIRES_AT,
        },
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
          readonly recipientEmailMasked: string | null;
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
        maxUses: 1,
        usedCount: 0,
        expiresAt: EXPIRES_AT,
        revokedAt: null,
        createdAt: TEST_NOW.toISOString(),
        recipientEmailMasked: "a***e@example.com",
      });

      const stored = database
        .prepare(
          `SELECT code_hash, is_bootstrap, created_by_admin_id, note,
                  recipient_email
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
        recipient_email: "alice@example.com",
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
      assert.equal(listedBody.items[1]?.status, "revoked");
      const serializedList = JSON.stringify(listedBody);
      assert.equal(serializedList.includes(createdBody.inviteCode), false);
      assert.equal(serializedList.includes("alice@example.com"), false);
      assert.equal(serializedList.includes("code_hash"), false);
      assert.equal(serializedList.includes("created_by_admin_id"), false);
      assert.equal(serializedList.includes("recipient_hmac"), false);

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
      const audits = database
        .prepare(
          `SELECT actor, action, target_ref, invite_code_id, result_class,
                  recipient_hmac
           FROM audit_log
           WHERE action IN ('invite_code.create', 'invite_code.revoke')
           ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>;
      const recipientHmac = computeMailRecipientAuditHmac(
        "alice@example.com",
        RECIPIENT_HMAC_KEYRING,
        RECIPIENT_HMAC_KEYRING.version,
      );
      assert.deepEqual(audits, [
        {
          actor: "system:invite",
          action: "invite_code.create",
          target_ref: null,
          invite_code_id: createdBody.item.id,
          result_class: "issued",
          recipient_hmac: recipientHmac,
        },
        {
          actor: "system:invite",
          action: "invite_code.revoke",
          target_ref: null,
          invite_code_id: createdBody.item.id,
          result_class: "admin_revoked",
          recipient_hmac: recipientHmac,
        },
      ]);
      assert.equal(JSON.stringify(audits).includes("alice@example.com"), false);

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
        mailPayloadEncKeyring: RECIPIENT_HMAC_KEYRING,
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
        { recipientEmail: "not-an-email", expiresAt: EXPIRES_AT },
        {
          recipientEmail: "alice@example.com",
          expiresAt: TEST_NOW.toISOString(),
        },
        {
          recipientEmail: "alice@example.com",
          expiresAt: EXPIRES_AT,
          maxUses: 1,
        },
        {
          recipientEmail: "alice@example.com",
          expiresAt: EXPIRES_AT,
          inviteCode: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567",
        },
        { maxUses: 1, expiresAt: EXPIRES_AT },
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

test("RNG and HMAC failures return only invite_unavailable without database state", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "invite-admin-failure@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const session = insertWebSession(database, adminId);
    const csrfToken = issueCsrfToken(
      CSRF_KEY,
      computeSessionTokenHash(session.rawToken, TOKEN_KEYRING).tokenHash,
    );
    const app = buildApp({
      inviteAdmin: {
        database,
        tokenHmacKeyring: TOKEN_KEYRING,
        inviteHmacKeyring: INVITE_KEYRING,
        mailPayloadEncKeyring: RECIPIENT_HMAC_KEYRING,
        csrfSigningKey: CSRF_KEY,
        now: () => new Date(TEST_NOW),
        randomBytes: () => Buffer.alloc(27, 0x01),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/invite-codes",
        headers: {
          cookie: session.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        payload: {
          recipientEmail: "failure-target@example.com",
          expiresAt: EXPIRES_AT,
        },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        error: { code: "invite_unavailable" },
      });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.body.includes("failure-target@example.com"), false);
      assert.equal(
        firstValue(
          database,
          "SELECT COUNT(*) FROM invite_codes WHERE recipient_email IS NOT NULL",
        ),
        0,
      );
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM audit_log"), 0);
    } finally {
      await app.close();
    }

    const input = {
      adminUserId: adminId,
      recipientEmail: "failure-target@example.com",
      expiresAt: EXPIRES_AT,
    };
    for (const operation of [
      () =>
        createAdminInviteCode(
          database,
          { version: 2, keys: { "2": "invalid" } },
          RECIPIENT_HMAC_KEYRING,
          input,
          {
            now: () => new Date(TEST_NOW),
            randomBytes: (size) => Buffer.alloc(size, 0x02),
          },
        ),
      () =>
        createAdminInviteCode(
          database,
          INVITE_KEYRING,
          { version: 3, keys: { "3": "invalid" } },
          input,
          {
            now: () => new Date(TEST_NOW),
            randomBytes: (size) => Buffer.alloc(size, 0x02),
          },
        ),
    ]) {
      assert.throws(
        operation,
        (error: unknown) =>
          error instanceof InviteAdminDomainError &&
          error.statusCode === 503 &&
          error.code === "invite_unavailable",
      );
    }
    let foreignKeyCalls = 0;
    assert.throws(
      () =>
        createAdminInviteCode(
          database,
          INVITE_KEYRING,
          RECIPIENT_HMAC_KEYRING,
          { ...input, adminUserId: 999_999 },
          {
            now: () => new Date(TEST_NOW),
            randomBytes: (size) => {
              foreignKeyCalls += 1;
              return Buffer.alloc(size, 0x03);
            },
          },
        ),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(foreignKeyCalls, 1);
    assert.equal(
      firstValue(
        database,
        "SELECT COUNT(*) FROM invite_codes WHERE recipient_email IS NOT NULL",
      ),
      0,
    );
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM audit_log"), 0);
  });
});

const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function inviteCodeForByte(byte: number): string {
  const character = INVITE_ALPHABET[byte & 31];
  assert.ok(character);
  return Array.from({ length: 7 }, () => character.repeat(4)).join("-");
}

test("each issuance is fresh and same-recipient reissue atomically leaves one open code", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "fresh-invite-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const create = (recipientEmail: string, byte: number) =>
      createAdminInviteCode(
        database,
        INVITE_KEYRING,
        RECIPIENT_HMAC_KEYRING,
        { adminUserId: adminId, recipientEmail, expiresAt: EXPIRES_AT },
        {
          now: () => new Date(TEST_NOW),
          randomBytes: (size) => Buffer.alloc(size, byte),
        },
      );

    const first = create("fresh@example.com", 3);
    const second = create(" FRESH@EXAMPLE.COM ", 4);
    const isolated = create("other@example.com", 5);

    assert.notEqual(first.inviteCode, second.inviteCode);
    assert.equal(first.inviteCode, inviteCodeForByte(3));
    assert.equal(second.inviteCode, inviteCodeForByte(4));
    assert.notEqual(
      computeInviteCodeHash(
        first.inviteCode,
        INVITE_KEYRING,
        INVITE_KEYRING.version,
      ),
      computeInviteCodeHash(
        second.inviteCode,
        INVITE_KEYRING,
        INVITE_KEYRING.version,
      ),
    );
    assert.equal(first.item.recipientEmailMasked, "f***h@example.com");
    assert.equal(second.item.recipientEmailMasked, "f***h@example.com");
    assert.equal(isolated.item.recipientEmailMasked, "o***r@example.com");

    const rows = database
      .prepare(
        `SELECT id, code_hash, recipient_email, revoked_at, used_count
         FROM invite_codes WHERE recipient_email IS NOT NULL ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.revoked_at, TEST_NOW.toISOString());
    assert.equal(rows[1]?.revoked_at, null);
    assert.equal(rows[2]?.revoked_at, null);
    assert.equal(
      firstValue(
        database,
        `SELECT COUNT(*) FROM invite_codes
         WHERE recipient_email = 'fresh@example.com'
           AND revoked_at IS NULL AND used_count = 0`,
      ),
      1,
    );
    assert.equal(
      firstValue(
        database,
        `SELECT COUNT(*) FROM invite_codes
         WHERE recipient_email = 'other@example.com'
           AND revoked_at IS NULL AND used_count = 0`,
      ),
      1,
    );
    assert.deepEqual(
      (
        database
          .prepare(
            `SELECT action, invite_code_id, result_class
             FROM audit_log WHERE action GLOB 'invite_code.*' ORDER BY id`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((row) => row.result_class),
      ["issued", "reissued_revoked", "issued", "issued"],
    );
    const serializedDatabaseState = JSON.stringify(
      database
        .prepare(
          `SELECT code_hash, recipient_email, revoked_at
           FROM invite_codes WHERE recipient_email IS NOT NULL`,
        )
        .all(),
    );
    assert.equal(serializedDatabaseState.includes(first.inviteCode), false);
    assert.equal(serializedDatabaseState.includes(second.inviteCode), false);
  });
});

test("recipient masking is exact for one, two, and longer local parts", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "mask-invite-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const recipients = [
      ["a@example.com", "*@example.com", 6],
      ["ab@example.com", "a*@example.com", 7],
      ["alice@example.com", "a***e@example.com", 8],
    ] as const;
    for (const [recipientEmail, expectedMask, byte] of recipients) {
      const created = createAdminInviteCode(
        database,
        INVITE_KEYRING,
        RECIPIENT_HMAC_KEYRING,
        { adminUserId: adminId, recipientEmail, expiresAt: EXPIRES_AT },
        {
          now: () => new Date(TEST_NOW),
          randomBytes: (size) => Buffer.alloc(size, byte),
        },
      );
      assert.equal(created.item.recipientEmailMasked, expectedMask);
      assert.equal(JSON.stringify(created.item).includes(recipientEmail), false);
    }
  });
});

test("collision retry covers every retained invite HMAC version and is bounded", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "collision-invite-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const seed = (recipientEmail: string, byte: number, version = 2) => {
      const code = inviteCodeForByte(byte);
      database
        .prepare(
          `INSERT INTO invite_codes (
             code_hash, is_bootstrap, created_by_admin_id, max_uses,
             used_count, expires_at, revoked_at, note, created_at,
             recipient_email
           ) VALUES (?, 0, ?, 1, 0, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          computeInviteCodeHash(code, INVITE_KEYRING, version),
          adminId,
          EXPIRES_AT,
          TEST_NOW.toISOString(),
          recipientEmail,
        );
    };
    seed("collision-current@example.com", 9);
    seed("collision-previous@example.com", 10, 1);
    seed("collision-third@example.com", 11);
    seed("collision-fourth@example.com", 12);
    seed("collision-fifth@example.com", 13);
    seed("collision-oldest@example.com", 15, 0);

    const sequence = [9, 10, 14];
    let calls = 0;
    const created = createAdminInviteCode(
      database,
      INVITE_KEYRING,
      RECIPIENT_HMAC_KEYRING,
      {
        adminUserId: adminId,
        recipientEmail: "collision-target@example.com",
        expiresAt: EXPIRES_AT,
      },
      {
        now: () => new Date(TEST_NOW),
        randomBytes: (size) => Buffer.alloc(size, sequence[calls++] ?? 31),
      },
    );
    assert.equal(calls, 3);
    assert.equal(created.inviteCode, inviteCodeForByte(14));

    const oldestSequence = [15, 16];
    let oldestCalls = 0;
    const oldestCreated = createAdminInviteCode(
      database,
      INVITE_KEYRING,
      RECIPIENT_HMAC_KEYRING,
      {
        adminUserId: adminId,
        recipientEmail: "oldest-collision-target@example.com",
        expiresAt: EXPIRES_AT,
      },
      {
        now: () => new Date(TEST_NOW),
        randomBytes: (size) =>
          Buffer.alloc(size, oldestSequence[oldestCalls++] ?? 31),
      },
    );
    assert.equal(oldestCalls, 2);
    assert.equal(oldestCreated.inviteCode, inviteCodeForByte(16));

    const oldTarget = createAdminInviteCode(
      database,
      INVITE_KEYRING,
      RECIPIENT_HMAC_KEYRING,
      {
        adminUserId: adminId,
        recipientEmail: "exhausted-collision-target@example.com",
        expiresAt: EXPIRES_AT,
      },
      {
        now: () => new Date(TEST_NOW),
        randomBytes: (size) => Buffer.alloc(size, 17),
      },
    );
    const exhaustedSequence = [11, 12, 13];
    let exhaustedCalls = 0;
    assert.throws(
      () =>
        createAdminInviteCode(
          database,
          INVITE_KEYRING,
          RECIPIENT_HMAC_KEYRING,
          {
            adminUserId: adminId,
            recipientEmail: "exhausted-collision-target@example.com",
            expiresAt: EXPIRES_AT,
          },
          {
            now: () => new Date(TEST_NOW),
            randomBytes: (size) =>
              Buffer.alloc(size, exhaustedSequence[exhaustedCalls++] ?? 31),
          },
        ),
      (error: unknown) =>
        error instanceof InviteAdminDomainError &&
        error.statusCode === 503 &&
        error.code === "invite_unavailable",
    );
    assert.equal(exhaustedCalls, 3);
    assert.equal(
      firstValue(
        database,
        `SELECT COUNT(*) FROM invite_codes
         WHERE id = ${oldTarget.item.id} AND revoked_at IS NULL`,
      ),
      1,
    );
    assert.equal(
      firstValue(
        database,
        `SELECT COUNT(*) FROM audit_log
         WHERE invite_code_id = ${oldTarget.item.id}`,
      ),
      1,
    );
  });
});

test("an unrelated UNIQUE audit failure is never retried and rolls back reissue", async () => {
  await withAuthenticationDatabase((database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "unique-invite-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const old = createAdminInviteCode(
      database,
      INVITE_KEYRING,
      RECIPIENT_HMAC_KEYRING,
      {
        adminUserId: adminId,
        recipientEmail: "unique-target@example.com",
        expiresAt: EXPIRES_AT,
      },
      {
        now: () => new Date(TEST_NOW),
        randomBytes: (size) => Buffer.alloc(size, 16),
      },
    );
    database.exec(`
      CREATE UNIQUE INDEX audit_issued_once_test
      ON audit_log(result_class)
      WHERE result_class = 'issued';
    `);
    let calls = 0;
    assert.throws(
      () =>
        createAdminInviteCode(
          database,
          INVITE_KEYRING,
          RECIPIENT_HMAC_KEYRING,
          {
            adminUserId: adminId,
            recipientEmail: "unique-target@example.com",
            expiresAt: EXPIRES_AT,
          },
          {
            now: () => new Date(TEST_NOW),
            randomBytes: (size) => {
              calls += 1;
              return Buffer.alloc(size, 17);
            },
          },
        ),
      /UNIQUE constraint failed/,
    );
    assert.equal(calls, 1);
    assert.equal(
      firstValue(
        database,
        `SELECT COUNT(*) FROM invite_codes
         WHERE id = ${old.item.id} AND revoked_at IS NULL`,
      ),
      1,
    );
    assert.equal(
      firstValue(
        database,
        "SELECT COUNT(*) FROM invite_codes WHERE recipient_email = 'unique-target@example.com'",
      ),
      1,
    );
    assert.equal(
      firstValue(
        database,
        "SELECT COUNT(*) FROM audit_log WHERE action GLOB 'invite_code.*'",
      ),
      1,
    );
  });
});

test("concurrent admin requests serialize same-recipient issuance", async () => {
  await withAuthenticationDatabase(async (database) => {
    const adminId = insertAuthenticationUser(database, {
      email: "concurrent-invite-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const session = insertWebSession(database, adminId);
    const csrfToken = issueCsrfToken(
      CSRF_KEY,
      computeSessionTokenHash(session.rawToken, TOKEN_KEYRING).tokenHash,
    );
    let randomByte = 18;
    const app = buildApp({
      inviteAdmin: {
        database,
        tokenHmacKeyring: TOKEN_KEYRING,
        inviteHmacKeyring: INVITE_KEYRING,
        mailPayloadEncKeyring: RECIPIENT_HMAC_KEYRING,
        csrfSigningKey: CSRF_KEY,
        now: () => new Date(TEST_NOW),
        randomBytes: (size) => Buffer.alloc(size, randomByte++),
      },
    });
    const request = () =>
      app.inject({
        method: "POST",
        url: "/api/admin/invite-codes",
        headers: {
          cookie: session.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        payload: {
          recipientEmail: "concurrent@example.com",
          expiresAt: EXPIRES_AT,
        },
      });
    try {
      const [first, second] = await Promise.all([request(), request()]);
      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 201);
      const firstCode = first.json<{ readonly inviteCode: string }>().inviteCode;
      const secondCode = second.json<{ readonly inviteCode: string }>().inviteCode;
      assert.notEqual(firstCode, secondCode);
      assert.equal(
        firstValue(
          database,
          `SELECT COUNT(*) FROM invite_codes
           WHERE recipient_email = 'concurrent@example.com'
             AND revoked_at IS NULL AND used_count = 0`,
        ),
        1,
      );
      assert.equal(
        firstValue(
          database,
          "SELECT COUNT(*) FROM invite_codes WHERE recipient_email = 'concurrent@example.com'",
        ),
        2,
      );
    } finally {
      await app.close();
    }
  });
});
