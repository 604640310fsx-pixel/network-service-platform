import { buildApp } from "./app.js";
import { loadAuthCredentialConfig, loadConfig } from "./config.js";
import { initializeDatabase } from "./db.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const credentials = loadAuthCredentialConfig();
  const database = initializeDatabase(config.dbPath);
  const app = buildApp({
    auth: {
      database,
      nodeEnv: config.nodeEnv,
      tokenHmacKeyring: credentials.tokenHmacKeyring,
      rateLimitKeyring: credentials.rateLimitKeyring,
      csrfSigningKey: credentials.csrfSigningKey,
    },
    registration: config.registrationEnabled
      ? {
          database,
          nodeEnv: config.nodeEnv,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          inviteHmacKeyring: credentials.inviteHmacKeyring,
          mailPayloadEncKeyring: credentials.mailPayloadEncKeyring,
          rateLimitKeyring: credentials.rateLimitKeyring,
        }
      : undefined,
  });
  let databaseClosed = false;

  const closeDatabase = (): void => {
    if (!databaseClosed) {
      database.close();
      databaseClosed = true;
    }
  };

  app.addHook("onClose", async () => {
    closeDatabase();
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => undefined);
    closeDatabase();
    throw error;
  }
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  console.error(`auth-service failed to start: ${message}`);
  process.exitCode = 1;
});
