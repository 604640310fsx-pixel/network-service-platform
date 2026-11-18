#!/usr/bin/env node
// Loopback-only integrated referral demo. Run after the existing auth build.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";

import { buildApp } from "../../auth-service/dist/src/app.js";
import { initializeDatabase } from "../../auth-service/dist/src/db.js";
import { hashPassword } from "../../auth-service/dist/src/auth/password.js";
import { ensureReferralProfile } from "../../auth-service/dist/src/referral/profile.js";
import { createAdminInviteCode } from "../../auth-service/dist/src/registration/invite-admin-service.js";
import { lookupInviteCode } from "../../auth-service/dist/src/registration/invite-code.js";
import { decryptRegistrationOtpPayload } from "../../auth-service/dist/src/registration/mail-outbox.js";

const websiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = process.env.REFERRAL_PREVIEW_DIR
  ? resolve(process.env.REFERRAL_PREVIEW_DIR)
  : join(tmpdir(), `nsp-referral-local-${randomBytes(6).toString("hex")}`);
const marker = join(demoRoot, ".referral-integrated-local");
if (existsSync(demoRoot) && !existsSync(marker)) {
  throw new Error("Refusing to use a directory without the local demo marker");
}
mkdirSync(demoRoot, { recursive: true, mode: 0o700 });
if (!existsSync(marker)) writeFileSync(marker, "synthetic referral demo only\n", { mode: 0o600 });

const secretsPath = join(demoRoot, "synthetic-keys.json");
const statePath = join(demoRoot, "synthetic-state.json");
const dbPath = join(demoRoot, "referral-demo.sqlite");
const PROMOTERS = ["promoter-a@example.test", "promoter-b@example.test"];
const VISITORS = ["visitor-a@example.test", "visitor-b@example.test"];

function newKeyring() {
  return { version: 1, keys: { "1": randomBytes(32).toString("base64") } };
}

const keys = existsSync(secretsPath)
  ? JSON.parse(readFileSync(secretsPath, "utf8"))
  : { token: newKeyring(), invite: newKeyring(), mail: newKeyring(), rate: newKeyring(), csrf: randomBytes(32).toString("base64"), demoPassword: randomBytes(24).toString("base64url") };
if (!existsSync(secretsPath)) writeFileSync(secretsPath, JSON.stringify(keys), { mode: 0o600 });
if (typeof keys.demoPassword !== "string" || keys.demoPassword.length < 20) throw new Error("Demo credentials are invalid");
const csrfSigningKey = Buffer.from(keys.csrf, "base64");
const database = initializeDatabase(dbPath);

function row(sql, ...args) { return database.prepare(sql).all(...args)[0]; }
async function seed() {
  const now = new Date().toISOString();
  let bootstrap = row("SELECT id FROM invite_codes WHERE is_bootstrap = 1");
  if (!bootstrap) {
    database.prepare(`INSERT INTO invite_codes (code_hash, is_bootstrap, max_uses, used_count, expires_at, revoked_at, created_at)
      VALUES (?, 1, 1, 0, ?, ?, ?)`).run(randomBytes(32).toString("base64url"), now, now, now);
    bootstrap = row("SELECT id FROM invite_codes WHERE is_bootstrap = 1");
  }
  const passwordHash = await hashPassword(keys.demoPassword);
  for (const email of ["seed-admin@example.test", ...PROMOTERS]) {
    if (!row("SELECT id FROM users WHERE email = ?", email)) {
      database.prepare(`INSERT INTO users (email, password_hash, role, status, invited_by_code_id, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(email, passwordHash, email.startsWith("seed-admin") ? "admin" : "user", bootstrap.id, now, now);
    }
  }
  for (const email of PROMOTERS) {
    ensureReferralProfile(database, row("SELECT id FROM users WHERE email = ?", email).id);
  }
  const adminId = row("SELECT id FROM users WHERE email = 'seed-admin@example.test'").id;
  const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const inviteCodes = {};
  for (const email of VISITORS) {
    const previous = prior.inviteCodes?.[email];
    if (previous && lookupInviteCode(database, previous, keys.invite)?.recipient_email === email) {
      inviteCodes[email] = previous;
      continue;
    }
    inviteCodes[email] = createAdminInviteCode(database, keys.invite, keys.mail, {
      adminUserId: adminId,
      recipientEmail: email,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }).inviteCode;
  }
  writeFileSync(statePath, JSON.stringify({ inviteCodes }), { mode: 0o600 });
  return inviteCodes;
}

function latestMail() {
  const rows = database.prepare(`SELECT idempotency_key AS idempotencyKey, to_email AS toEmail,
    template, key_version AS keyVersion, nonce, ciphertext, tag
    FROM mail_outbox ORDER BY created_at DESC LIMIT 20`).all();
  const seen = new Set();
  return rows.flatMap((item) => {
    if (!VISITORS.includes(item.toEmail) || seen.has(item.toEmail)) return [];
    seen.add(item.toEmail);
    return [{ email: item.toEmail, otp: decryptRegistrationOtpPayload(item, keys.mail) }];
  });
}

function allocatedPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

const inviteCodes = await seed();
const apiPort = await allocatedPort();
const webPort = await allocatedPort();
const webOrigin = `http://127.0.0.1:${webPort}`;
const app = buildApp({
  auth: { database, nodeEnv: "development", tokenHmacKeyring: keys.token, rateLimitKeyring: keys.rate, csrfSigningKey },
  registration: { database, nodeEnv: "development", tokenHmacKeyring: keys.token, inviteHmacKeyring: keys.invite, mailPayloadEncKeyring: keys.mail, rateLimitKeyring: keys.rate },
  referral: { database, nodeEnv: "development", tokenHmacKeyring: keys.token, rateLimitKeyring: keys.rate, csrfSigningKey,
    publicLink: { enabled: true, origin: webOrigin, path: "/referral.html" } },
  readiness: { isReady: () => true },
});
let vite;
try {
  await app.listen({ host: "127.0.0.1", port: apiPort });
  vite = await createViteServer({
    configFile: false,
    root: websiteRoot,
    cacheDir: join(demoRoot, "vite-cache"),
    plugins: [react(), {
      name: "referral-demo-state",
      configureServer(server) {
        server.middlewares.use("/__referral_demo/state", (request, response) => {
          if (request.method !== "GET") { response.writeHead(405).end(); return; }
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({
            demoPassword: keys.demoPassword,
            promoters: PROMOTERS.map((email) => ({ email })),
            visitors: VISITORS.map((email) => ({ email, inviteCode: inviteCodes[email] })),
            mail: latestMail(),
          }));
        });
      },
    }],
    server: {
      host: "127.0.0.1", port: webPort, strictPort: true, cors: false,
      proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyReq", (proxied, request) => {
            // The frozen backend development origin is localhost:5173. This
            // loopback-only proxy maps this launcher's allocated browser origin.
            if (request.headers.origin === webOrigin) proxied.setHeader("origin", "http://localhost:5173");
          });
        },
      } },
    },
  });
  await vite.listen();
} catch (error) {
  await vite?.close();
  await app.close();
  database.close();
  throw error;
}

console.log(`LOCAL_REFERRAL_URL=${webOrigin}/referral-integrated-local.html`);
console.log(`LOCAL_REFERRAL_PID=${process.pid}`);
console.log(`LOCAL_REFERRAL_DB=${dbPath}`);
console.log("Stop with Ctrl+C or kill -TERM the printed PID.");
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await vite.close();
  await app.close();
  database.close();
}
process.on("SIGINT", () => void stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
