import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { buildApp } from "../src/app.js";
import type { DatabaseConnection } from "../src/db.js";
import { insertTicketAttachments } from "../src/tickets/attachments.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "./auth/helpers.js";
import {
  CSRF_KEY,
  TEST_NOW,
  TOKEN_KEYRING,
  firstValue,
  insertWebSession,
} from "./payment/helpers.js";

type Session = ReturnType<typeof insertWebSession>;

function ticketApp(database: DatabaseConnection) {
  let sequence = 0;
  return buildApp({
    tickets: {
      database,
      tokenHmacKeyring: TOKEN_KEYRING,
      rateLimitKeyring: TOKEN_KEYRING,
      csrfSigningKey: CSRF_KEY,
      now: () => new Date(TEST_NOW),
      randomRef: () => {
        sequence += 1;
        return Buffer.from(sequence.toString(16).padStart(16, "0"), "hex");
      },
    },
  });
}

function user(database: DatabaseConnection, email: string, role: "user" | "admin" = "user") {
  const id = insertAuthenticationUser(database, { email, passwordHash: "hash", status: "active", role });
  return { id, session: insertWebSession(database, id) };
}

type App = ReturnType<typeof ticketApp>;
const post = (app: App, url: string, session: Session | null, payload: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(session ? { cookie: session.cookie } : {}),
      ...(session ? { "x-csrf-token": session.csrfToken } : {}),
    },
    payload: payload as Record<string, unknown>,
  });
const get = (app: App, url: string, session: Session | null) =>
  app.inject({ method: "GET", url, headers: session ? { cookie: session.cookie } : {} });

/* ---------- minimal structurally valid fixtures ---------- */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function makePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x2a,
    0xff, 0xd9,
  ]);
}

function makeWebp(): Buffer {
  const payload = Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00]);
  const chunk = Buffer.alloc(8);
  chunk.write("VP8 ", 0, "latin1");
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), chunk, payload]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const PNG = makePng();
const JPEG = makeJpeg();
const WEBP = makeWebp();
const b64 = (content: Buffer) => content.toString("base64");
const entry = (contentType: string, content: Buffer) => ({ contentType, dataBase64: b64(content) });
const ATTACHMENT_REF = /^TA[0-9A-F]{16}$/;

function insertGrant(database: DatabaseConnection, userId: number, status: "active" | "revoked"): number {
  database
    .prepare(
      `INSERT INTO admin_grants (user_id, granted_by_admin_id, label, starts_at, ends_at, status, reason, created_at, updated_at)
       VALUES (?, ?, 'Gift', ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(userId, userId, TEST_NOW.toISOString(), status, TEST_NOW.toISOString(), TEST_NOW.toISOString());
  return Number(firstValue(database, "SELECT MAX(id) FROM admin_grants WHERE user_id = ?", userId));
}

function seedAttachmentBytes(
  database: DatabaseConnection,
  ticketId: number,
  authorUserId: number,
  bytes: number,
): void {
  const messageId = Number(
    database
      .prepare(
        `INSERT INTO ticket_messages (ticket_id, author_role, author_user_id, body, created_at)
         VALUES (?, 'customer', ?, 'seed', ?)`,
      )
      .run(ticketId, authorUserId, TEST_NOW.toISOString()).lastInsertRowid,
  );
  const insert = database.prepare(
    `INSERT INTO ticket_attachments (attachment_ref, message_id, content_type, byte_size, content, created_at)
     VALUES (?, ?, 'image/png', ?, zeroblob(?), ?)`,
  );
  for (let remaining = bytes; remaining > 0; remaining -= 5 * 1024 * 1024) {
    const size = Math.min(remaining, 5 * 1024 * 1024);
    insert.run(`TA${randomBytes(8).toString("hex").toUpperCase()}`, messageId, size, size, TEST_NOW.toISOString());
  }
}

test("create and reply accept valid jpeg/png/webp images and expose metadata only", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    const admin = user(database, "admin@example.test", "admin");
    try {
      const created = await post(app, "/api/me/tickets", customer.session, {
        subject: "s",
        body: "with images",
        attachments: [entry("image/jpeg", JPEG), entry("image/png", PNG), entry("image/webp", WEBP)],
      });
      assert.equal(created.statusCode, 200, JSON.stringify(created.json()));
      const ticket = created.json().ticket;
      const attachments = ticket.messages[0].attachments;
      assert.equal(attachments.length, 3);
      assert.deepEqual(
        attachments.map((a: { contentType: string }) => a.contentType),
        ["image/jpeg", "image/png", "image/webp"],
      );
      assert.deepEqual(
        attachments.map((a: { byteSize: number }) => a.byteSize),
        [JPEG.length, PNG.length, WEBP.length],
      );
      for (const meta of attachments) {
        assert.match(meta.ref, ATTACHMENT_REF);
        assert.equal(meta.url, `/api/me/tickets/${ticket.ref}/attachments/${meta.ref}`);
      }
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM ticket_attachments"), 3);
      assert.equal(
        firstValue(database, "SELECT SUM(byte_size) FROM ticket_attachments"),
        JPEG.length + PNG.length + WEBP.length,
      );

      const replied = await post(app, `/api/me/tickets/${ticket.ref}/messages`, customer.session, {
        body: "one more",
        attachments: [entry("image/png", PNG)],
      });
      assert.equal(replied.statusCode, 200);
      const replyMeta = replied.json().ticket.messages[1].attachments[0];
      assert.match(replyMeta.ref, ATTACHMENT_REF);
      // Binary never appears in list or detail payloads.
      const detail = (await get(app, `/api/me/tickets/${ticket.ref}`, customer.session)).json().ticket;
      assert.equal(JSON.stringify(detail).includes(b64(PNG)), false);
      assert.deepEqual(
        (await get(app, "/api/me/tickets", customer.session)).json().items[0].serviceGrantId,
        null,
      );

      // Owner download returns the exact bytes with locked-down headers.
      const download = await get(app, attachments[1].url, customer.session);
      assert.equal(download.statusCode, 200);
      assert.equal(download.headers["content-type"], "image/png");
      assert.equal(download.headers["x-content-type-options"], "nosniff");
      assert.equal(download.headers["cache-control"], "private, no-store");
      assert.deepEqual(download.rawPayload, PNG);

      // Admin sees the same metadata with the admin entry point and can download.
      const adminDetail = (await get(app, `/api/admin/tickets/${ticket.ref}`, admin.session)).json().ticket;
      const adminMeta = adminDetail.messages[0].attachments[1];
      assert.equal(adminMeta.url, `/api/admin/tickets/${ticket.ref}/attachments/${adminMeta.ref}`);
      const adminDownload = await get(app, adminMeta.url, admin.session);
      assert.equal(adminDownload.statusCode, 200);
      assert.deepEqual(adminDownload.rawPayload, PNG);
    } finally {
      await app.close();
    }
  });
});

test("invalid types, signatures, structures, and shapes are rejected without writes", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    try {
      const cases: Array<[unknown, string]> = [
        [{ contentType: "image/gif", dataBase64: b64(PNG) }, "unsupported_image_type"],
        [{ contentType: "image/svg+xml", dataBase64: b64(Buffer.from("<svg/>")) }, "unsupported_image_type"],
        [{ contentType: "text/html", dataBase64: b64(Buffer.from("<html></html>")) }, "unsupported_image_type"],
        [{ contentType: "image/png", dataBase64: b64(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])) }, "invalid_image"],
        [{ contentType: "image/png", dataBase64: b64(Buffer.from("<svg><script/></svg>")) }, "invalid_image"],
        [{ contentType: "image/jpeg", dataBase64: b64(PNG) }, "image_type_mismatch"],
        [{ contentType: "image/webp", dataBase64: b64(JPEG) }, "image_type_mismatch"],
        [{ contentType: "image/png", dataBase64: b64(PNG.subarray(0, 20)) }, "invalid_image"],
        [{ contentType: "image/jpeg", dataBase64: b64(JPEG.subarray(0, JPEG.length - 2)) }, "invalid_image"],
        [{ contentType: "image/png", dataBase64: b64(Buffer.concat([Buffer.from([0x00]), PNG])) }, "invalid_image"],
        [{ contentType: "image/png", dataBase64: "!!!" }, "invalid_attachments"],
        [{ contentType: "image/png", dataBase64: "" }, "invalid_attachments"],
        [{ contentType: "image/png" }, "invalid_attachments"],
        ["string-not-object", "invalid_attachments"],
        [{ contentType: "image/png", dataBase64: b64(PNG), extra: 1 }, "invalid_attachments"],
      ];
      // Attachment-bearing attempts count against the per-account per-minute
      // limit, so validation-only cases spread across accounts (dedicated quota
      // tests cover the counted-attempt behavior).
      let caseIndex = 0;
      for (const [attachment, code] of cases) {
        const attemptUser = user(database, `case-${caseIndex}@example.test`);
        caseIndex += 1;
        const response = await post(app, "/api/me/tickets", attemptUser.session, {
          subject: "s",
          body: "b",
          attachments: [attachment],
        });
        assert.equal(response.statusCode, 400, JSON.stringify(attachment));
        assert.deepEqual(response.json(), { error: { code } }, JSON.stringify(attachment));
      }
      for (const attachments of [
        "not-an-array",
        [entry("image/png", PNG), entry("image/png", PNG), entry("image/png", PNG), entry("image/png", PNG)],
        null,
        42,
      ]) {
        const response = await post(app, "/api/me/tickets", customer.session, {
          subject: "s",
          body: "b",
          attachments,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(attachments));
      }
      // An explicit empty list is a valid no-op.
      const empty = await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b", attachments: [] });
      assert.equal(empty.statusCode, 200);
      assert.deepEqual(empty.json().ticket.messages[0].attachments, []);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM tickets"), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM ticket_attachments"), 0);
    } finally {
      await app.close();
    }
  });
});

test(
  "per-image, per-message, per-ticket, per-account, and global quotas fail closed",
  { timeout: 120_000 },
  async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    try {
      const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1, 0xff);
      tooLarge[0] = 0xff; tooLarge[1] = 0xd8; tooLarge[2] = 0xff;
      const over5MiB = await post(app, "/api/me/tickets", customer.session, {
        subject: "s", body: "b", attachments: [entry("image/jpeg", tooLarge)],
      });
      assert.equal(over5MiB.statusCode, 400);
      assert.deepEqual(over5MiB.json(), { error: { code: "image_too_large" } });

      const ref = (await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b" })).json().ticket.ref;
      const ticketId = Number(firstValue(database, "SELECT id FROM tickets WHERE ticket_ref = ?", ref));

      // 30MiB per ticket: seed 30MiB then the next image cannot fit.
      seedAttachmentBytes(database, ticketId, customer.id, 30 * 1024 * 1024);
      const ticketFull = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
        body: "b", attachments: [entry("image/png", PNG)],
      });
      assert.equal(ticketFull.statusCode, 409);
      assert.deepEqual(ticketFull.json(), { error: { code: "ticket_storage_exceeded" } });

      // 100MiB per account: spread the rest across more tickets so each stays
      // under the 30MiB ticket cap and only the account cap can fire.
      for (const chunk of [20, 25, 25]) {
        const ref2 = (await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b" })).json().ticket.ref;
        const ticketId2 = Number(firstValue(database, "SELECT id FROM tickets WHERE ticket_ref = ?", ref2));
        seedAttachmentBytes(database, ticketId2, customer.id, chunk * 1024 * 1024);
      }
      const ref5 = (await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b" })).json().ticket.ref;
      const ticketId5 = Number(firstValue(database, "SELECT id FROM tickets WHERE ticket_ref = ?", ref5));
      const accountFull = await post(app, `/api/me/tickets/${ref5}/messages`, customer.session, {
        body: "b", attachments: [entry("image/png", PNG)],
      });
      assert.equal(accountFull.statusCode, 409);
      assert.deepEqual(accountFull.json(), { error: { code: "account_storage_exceeded" } });

      // A failing quota write rolls the reply message back with its attachments;
      // only the creation message (also body 'b') remains.
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = ? AND body = 'b'", ticketId5), 1);
      assert.equal(
        firstValue(
          database,
          `SELECT COUNT(*) FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id
            WHERE m.ticket_id = ? AND m.body = 'b'`,
          ticketId5,
        ),
        0,
      );

      // 1GiB global: seed under fresh accounts so account quota does not fire first.
      for (let index = 0; index < 11; index += 1) {
        const filler = user(database, `filler${index}@example.test`);
        const fillerRef = `TK${(0xb000 + index).toString(16).toUpperCase().padStart(16, "0")}`;
        database
          .prepare(
            `INSERT INTO tickets (ticket_ref, user_id, subject, status, created_at, updated_at)
             VALUES (?, ?, 'x', 'open', ?, ?)`,
          )
          .run(fillerRef, filler.id, TEST_NOW.toISOString(), TEST_NOW.toISOString());
        const fillerTicket = Number(firstValue(database, "SELECT id FROM tickets WHERE ticket_ref = ?", fillerRef));
        seedAttachmentBytes(database, fillerTicket, filler.id, 95 * 1024 * 1024);
      }
      const globalFull = await post(app, "/api/me/tickets", user(database, "fresh@example.test").session, {
        subject: "s", body: "b", attachments: [entry("image/png", PNG)],
      });
      assert.equal(globalFull.statusCode, 409);
      assert.deepEqual(globalFull.json(), { error: { code: "storage_limit_exceeded" } });
    } finally {
      await app.close();
    }
  });
});

test("a failed attachment insert rolls the whole ticket write back", async () => {
  await withAuthenticationDatabase(async (database) => {
    const customer = user(database, "customer@example.test");
    const ticketId = Number(
      database
        .prepare(
          `INSERT INTO tickets (ticket_ref, user_id, subject, status, created_at, updated_at)
           VALUES ('TKAAAAAAAAAAAAAAAA', ?, 'x', 'open', ?, ?)`,
        )
        .run(customer.id, TEST_NOW.toISOString(), TEST_NOW.toISOString()).lastInsertRowid,
    );
    const messageId = Number(
      database
        .prepare(
          `INSERT INTO ticket_messages (ticket_id, author_role, author_user_id, body, created_at)
           VALUES (?, 'customer', ?, 'x', ?)`,
        )
        .run(ticketId, customer.id, TEST_NOW.toISOString()).lastInsertRowid,
    );
    // The second row violates the byte_size CHECK; the first must not survive.
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    let sequence = 0;
    const write = database.transaction(() => {
      insertTicketAttachments(database, {
        ticketId,
        ownerUserId: customer.id,
        messageId,
        attachments: [
          { contentType: "image/png", content: PNG },
          { contentType: "image/png", content: oversized },
        ],
        createdAt: TEST_NOW.toISOString(),
        randomRef: () => {
          sequence += 1;
          return Buffer.from(sequence.toString(16).padStart(16, "0"), "hex");
        },
      });
    });
    assert.throws(() => write(), /CHECK constraint failed/);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM ticket_attachments"), 0);
  });
});

test("owner, admin, foreign, expired, and anonymous access share the same boundaries", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const owner = user(database, "owner@example.test");
    const other = user(database, "other@example.test");
    try {
      const created = await post(app, "/api/me/tickets", owner.session, {
        subject: "s", body: "b", attachments: [entry("image/png", PNG)],
      });
      const ticket = created.json().ticket;
      const ref = ticket.messages[0].attachments[0].ref;
      const notFound = { error: { code: "not_found" } };

      for (const url of [
        `/api/me/tickets/${ticket.ref}/attachments/${ref}`,
        `/api/me/tickets/TKFFFFFFFFFFFFFFFF/attachments/${ref}`,
        `/api/me/tickets/${ticket.ref}/attachments/TAFFFFFFFFFFFFFFFF`,
        `/api/me/tickets/${ticket.ref}/attachments/not-a-ref`,
        `/api/me/tickets/not-a-ref/attachments/${ref}`,
      ]) {
        const response = await get(app, url, other.session);
        assert.equal(response.statusCode, 404, url);
        assert.deepEqual(response.json(), notFound, url);
      }
      // A valid attachment ref under another ticket of the same owner stays hidden.
      const second = await post(app, "/api/me/tickets", owner.session, { subject: "s", body: "b" });
      const ownOther = await get(app, `/api/me/tickets/${second.json().ticket.ref}/attachments/${ref}`, owner.session);
      assert.equal(ownOther.statusCode, 404);

      for (const url of [
        `/api/me/tickets/${ticket.ref}/attachments/${ref}`,
        `/api/admin/tickets/${ticket.ref}/attachments/${ref}`,
      ]) {
        const anonymous = await app.inject({ method: "GET", url });
        assert.equal(anonymous.statusCode, 401, url);
      }
      const customerOnAdmin = await get(app, `/api/admin/tickets/${ticket.ref}/attachments/${ref}`, other.session);
      assert.equal(customerOnAdmin.statusCode, 403);

      // An expired session is rejected before anything else.
      database
        .prepare("UPDATE sessions SET expires_at = ? WHERE token_hash IN (SELECT token_hash FROM sessions)")
        .run(new Date(TEST_NOW.getTime() - 1_000).toISOString());
      const expired = await get(app, `/api/me/tickets/${ticket.ref}/attachments/${ref}`, owner.session);
      assert.equal(expired.statusCode, 401);
      const expiredWrite = await post(app, "/api/me/tickets", owner.session, { subject: "s", body: "b" });
      assert.equal(expiredWrite.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

test("session and CSRF gates run before the enlarged body is parsed", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    const oversized = "x".repeat(21 * 1024 * 1024 + 1);
    try {
      // Anonymous + oversized body → 401 (not a parse/limit error).
      const anonymous = await app.inject({
        method: "POST",
        url: "/api/me/tickets",
        headers: { "content-type": "application/json" },
        payload: { subject: oversized, body: "b" },
      });
      assert.equal(anonymous.statusCode, 401);
      assert.deepEqual(anonymous.json(), { error: { code: "unauthorized" } });

      // Session without CSRF + oversized body → 403 csrf_invalid.
      const noCsrf = await app.inject({
        method: "POST",
        url: "/api/me/tickets",
        headers: { "content-type": "application/json", cookie: customer.session.cookie },
        payload: { subject: oversized, body: "b" },
      });
      assert.equal(noCsrf.statusCode, 403);
      assert.deepEqual(noCsrf.json(), { error: { code: "csrf_invalid" } });

      // Fully authorized + oversized body → the 21MiB limit maps to invalid_request.
      const authorized = await post(app, "/api/me/tickets", customer.session, { subject: oversized, body: "b" });
      assert.equal(authorized.statusCode, 400);
      assert.deepEqual(authorized.json(), { error: { code: "invalid_request" } });

      // Old clients without attachments or links stay byte-for-byte compatible.
      const legacy = await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b" });
      assert.equal(legacy.statusCode, 200);
      const ticket = legacy.json().ticket;
      assert.equal(ticket.serviceOrderRef, null);
      assert.equal(ticket.serviceGrantId, null);
      assert.deepEqual(ticket.messages[0].attachments, []);
      const legacyReply = await post(app, `/api/me/tickets/${ticket.ref}/messages`, customer.session, { body: "still works" });
      assert.equal(legacyReply.statusCode, 200);
      assert.deepEqual(legacyReply.json().ticket.messages[1].attachments, []);
    } finally {
      await app.close();
    }
  });
});

test("attachment upload writes are bounded to ten per account per minute", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    try {
      const ref = (await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b" })).json().ticket.ref;
      for (let index = 0; index < 10; index += 1) {
        const response = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
          body: `u${index}`, attachments: [entry("image/png", PNG)],
        });
        assert.equal(response.statusCode, 200, `write ${index}`);
      }
      const limited = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
        body: "over", attachments: [entry("image/png", PNG)],
      });
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json(), { error: { code: "rate_limited" } });
      // A plain text reply is not counted against the attachment-write bucket.
      const plain = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, { body: "text only" });
      assert.equal(plain.statusCode, 200);
      // Another account keeps its own bucket.
      const other = user(database, "other@example.test");
      const own = await post(app, "/api/me/tickets", other.session, {
        subject: "s", body: "b", attachments: [entry("image/png", PNG)],
      });
      assert.equal(own.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

test("malformed attachment attempts consume the same per-minute bucket", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    try {
      const ref = (await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b" })).json().ticket.ref;
      // Each attempt carries a malformed attachment and is rejected, but still
      // counts: attachment-bearing spam cannot bypass the per-minute limit.
      for (let index = 0; index < 10; index += 1) {
        const rejected = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
          body: `bad${index}`, attachments: [entry("image/gif", PNG)],
        });
        assert.equal(rejected.statusCode, 400, `attempt ${index}`);
        assert.deepEqual(rejected.json(), { error: { code: "unsupported_image_type" } });
      }
      const limited = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
        body: "now blocked", attachments: [entry("image/png", PNG)],
      });
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json(), { error: { code: "rate_limited" } });
      // The rejected attempts wrote nothing: only the creation message exists.
      assert.equal(
        firstValue(database, "SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = (SELECT id FROM tickets WHERE ticket_ref = ?)", ref),
        1,
      );
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM ticket_attachments"), 0);
      // Plain text without an attachments key still does not consume the bucket.
      const plain = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, { body: "text only" });
      assert.equal(plain.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

test("the attachment-write window counts the last minute, not per-bucket bursts", async () => {
  await withAuthenticationDatabase(async (database) => {
    // TEST_NOW is bucket-aligned; a mutable clock proves the retained-bucket sum
    // counts the prior window, so a boundary crossing cannot double the limit.
    let now = new Date(TEST_NOW);
    let sequence = 0;
    const app = buildApp({
      tickets: {
        database,
        tokenHmacKeyring: TOKEN_KEYRING,
        rateLimitKeyring: TOKEN_KEYRING,
        csrfSigningKey: CSRF_KEY,
        now: () => new Date(now),
        randomRef: () => {
          sequence += 1;
          return Buffer.from(sequence.toString(16).padStart(16, "0"), "hex");
        },
      },
    });
    const customer = user(database, "customer@example.test");
    try {
      const ref = (await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "b" })).json().ticket.ref;
      for (let index = 0; index < 10; index += 1) {
        const response = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
          body: `u${index}`, attachments: [entry("image/png", PNG)],
        });
        assert.equal(response.statusCode, 200, `write ${index}`);
      }
      // One bucket boundary later (t+61s) the earlier writes are still inside
      // the retained window: no fixed-window burst reset.
      now = new Date(now.getTime() + 61_000);
      const stillLimited = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
        body: "edge", attachments: [entry("image/png", PNG)],
      });
      assert.equal(stillLimited.statusCode, 429);
      // Once every counted bucket has aged out (t+122s), writes resume.
      now = new Date(now.getTime() + 61_000);
      const resumed = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, {
        body: "after", attachments: [entry("image/png", PNG)],
      });
      assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.json()));
    } finally {
      await app.close();
    }
  });
});

test("a grant link must be owned and active; revoked grants keep history readable", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const owner = user(database, "owner@example.test");
    const other = user(database, "other@example.test");
    const ownGrant = insertGrant(database, owner.id, "active");
    const foreignGrant = insertGrant(database, other.id, "active");
    const revokedGrant = insertGrant(database, owner.id, "revoked");
    try {
      const linked = await post(app, "/api/me/tickets", owner.session, {
        subject: "s", body: "b", serviceGrantId: ownGrant,
      });
      assert.equal(linked.statusCode, 200, JSON.stringify(linked.json()));
      const ticket = linked.json().ticket;
      assert.equal(ticket.serviceGrantId, ownGrant);
      assert.equal(ticket.serviceOrderRef, null);
      assert.equal(firstValue(database, "SELECT grant_id FROM tickets WHERE ticket_ref = ?", ticket.ref), ownGrant);

      for (const [serviceGrantId, code] of [
        [foreignGrant, "invalid_grant"],
        [revokedGrant, "invalid_grant"],
        [999_999, "invalid_grant"],
      ] as const) {
        const rejected = await post(app, "/api/me/tickets", owner.session, { subject: "s", body: "b", serviceGrantId });
        assert.equal(rejected.statusCode, 400);
        assert.deepEqual(rejected.json(), { error: { code } });
      }
      for (const serviceGrantId of ["1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true]) {
        const rejected = await post(app, "/api/me/tickets", owner.session, { subject: "s", body: "b", serviceGrantId });
        assert.equal(rejected.statusCode, 400, JSON.stringify(serviceGrantId));
        assert.deepEqual(rejected.json(), { error: { code: "invalid_request" } });
      }
      const conflict = await post(app, "/api/me/tickets", owner.session, {
        subject: "s", body: "b", serviceOrderRef: "DL00000000", serviceGrantId: ownGrant,
      });
      assert.equal(conflict.statusCode, 400);
      assert.deepEqual(conflict.json(), { error: { code: "invalid_link" } });
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM tickets"), 1);

      // Revoking afterwards never blocks the legitimate owner's reads or replies.
      database.prepare("UPDATE admin_grants SET status = 'revoked' WHERE id = ?").run(ownGrant);
      const detail = await get(app, `/api/me/tickets/${ticket.ref}`, owner.session);
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().ticket.serviceGrantId, ownGrant);
      const reply = await post(app, `/api/me/tickets/${ticket.ref}/messages`, owner.session, { body: "still open" });
      assert.equal(reply.statusCode, 200);
      // Revoked grants cannot seed a new link but the admin view keeps the id.
      const admin = user(database, "admin@example.test", "admin");
      const adminDetail = await get(app, `/api/admin/tickets/${ticket.ref}`, admin.session);
      assert.equal(adminDetail.json().ticket.serviceGrantId, ownGrant);
    } finally {
      await app.close();
    }
  });
});
