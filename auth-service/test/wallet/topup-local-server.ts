import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { initializeDatabase } from "../../src/db.js";
import { TOPUP_IDEMPOTENCY_CANDIDATE_DDL } from "../../src/wallet/topup-idempotency.js";
import { generateSessionToken } from "../../src/session/session-token.js";
import { insertAuthenticationUser } from "../auth/helpers.js";
import { CSRF_KEY, TEST_NOW, TOKEN_KEYRING } from "../payment/helpers.js";
import { registerLocalTopupAdapter } from "./local-topup-adapter.js";

/** Explicit localhost entrypoint for browser verification. Never imported by production. */
if (process.env.NODE_ENV === "production" || process.env.TEST_ONLY !== "1") {
  throw new Error("topup-local-server requires TEST_ONLY=1 outside production");
}

const directory = await mkdtemp(join(tmpdir(), "nsp-topup-local-"));
const database = initializeDatabase(join(directory, "local-test.sqlite"));
database.exec(TOPUP_IDEMPOTENCY_CANDIDATE_DDL);
const userId = insertAuthenticationUser(database, {
  email: "topup-local@example.test", passwordHash: "local-test-only", status: "active", role: "user",
});
const adapter = { mode: "TEST_ONLY", runtime: "test",
  checkoutUrl: (topupId: string) => `/api/__test/topups/${topupId}/checkout` } as const;
const app = buildApp({
  auth: { database, nodeEnv: "test", tokenHmacKeyring: TOKEN_KEYRING,
    rateLimitKeyring: { version: 1, keys: { "1": Buffer.alloc(32, 0x52).toString("base64") } },
    csrfSigningKey: CSRF_KEY, sessionLookupDependencies: { now: () => TEST_NOW } },
  wallet: { database, tokenHmacKeyring: TOKEN_KEYRING, csrfSigningKey: CSRF_KEY,
    now: () => TEST_NOW, topupCheckout: adapter },
});
registerLocalTopupAdapter(app, database, Buffer.alloc(32, 0x51), "local-test-merchant");
app.get("/api/__test/session", (_request, reply) => {
  const token = generateSessionToken(TOKEN_KEYRING);
  const familyId = randomUUID();
  database.prepare("INSERT INTO session_families(id,user_id,created_at) VALUES (?,?,?)")
    .run(familyId, userId, TEST_NOW.toISOString());
  database.prepare(`INSERT INTO sessions(token_hash,hmac_key_version,user_id,session_family_id,audience,
    created_at,expires_at,last_seen_at,revoked_at) VALUES (?,?,?,?,'web',?,?,?,NULL)`)
    .run(token.tokenHash, token.hmacKeyVersion, userId, familyId, TEST_NOW.toISOString(),
      new Date(TEST_NOW.getTime() + 31 * 86400000).toISOString(), TEST_NOW.toISOString());
  reply.header("Cache-Control", "no-store");
  reply.header("Set-Cookie", `__Host-web_session=${token.rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return reply.redirect("/profile");
});

const close = async () => {
  await app.close();
  database.close();
  await rm(directory, { recursive: true, force: true });
};
process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
try {
  await app.listen({ host: "127.0.0.1", port: 3101 });
  process.stdout.write("TEST_ONLY local topup API on 127.0.0.1:3101\n");
} catch (error) {
  await close();
  throw error;
}
