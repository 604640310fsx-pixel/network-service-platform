import { AlipaySdk } from "alipay-sdk";

import { buildApp } from "./app.js";
import {
  loadAlipayConfig,
  loadAuthCredentialConfig,
  loadConfig,
} from "./config.js";
import { initializeDatabase } from "./db.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const credentials = loadAuthCredentialConfig();
  const alipay = config.paymentEnabled ? loadAlipayConfig() : null;
  const alipaySdk =
    alipay === null
      ? null
      : new AlipaySdk({
          appId: alipay.appId,
          privateKey: alipay.privateKey,
          alipayPublicKey: alipay.alipayPublicKey,
          keyType: alipay.privateKeyType,
        });
  const database = initializeDatabase(config.dbPath);
  const payment =
    alipay === null || alipaySdk === null
      ? ({ enabled: false } as const)
      : ({
          enabled: true,
          database,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          csrfSigningKey: credentials.csrfSigningKey,
          appId: alipay.appId,
          sellerId: alipay.sellerId,
          notifyUrl: alipay.notifyUrl,
          returnUrl: alipay.returnUrl,
          sdk: alipaySdk,
        } as const);
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
    payment,
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
