import { AlipaySdk } from "alipay-sdk";

import { buildApp } from "./app.js";
import {
  loadAlipayConfig,
  loadAuthCredentialConfig,
  loadConfig,
  loadDeliveryCredentialConfig,
  loadMailRuntimeConfig,
  loadResendCredentialConfig,
} from "./config.js";
import { initializeDatabase } from "./db.js";
import { startOrderExpirySweep } from "./payment/order-expiry.js";
import { startRegistrationMailRuntime } from "./registration/mail-runtime.js";
import { ResendMailTransport } from "./registration/resend-mail-transport.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const credentials = loadAuthCredentialConfig();
  const mailConfig = loadMailRuntimeConfig();
  const resendCredentials = mailConfig.enabled
    ? loadResendCredentialConfig()
    : null;
  const mailTransport =
    mailConfig.enabled && resendCredentials !== null
      ? new ResendMailTransport({
          apiKey: resendCredentials.apiKey,
          fromEmail: mailConfig.resend.fromEmail,
          requestTimeoutMs: mailConfig.resend.requestTimeoutMs,
          dispatcherLeaseMs: mailConfig.dispatcher.leaseMs,
        })
      : null;
  const alipay = config.paymentEnabled ? loadAlipayConfig() : null;
  const delivery = config.paymentEnabled
    ? loadDeliveryCredentialConfig()
    : null;
  const alipaySdk =
    alipay === null
      ? null
      : new AlipaySdk({
          appId: alipay.appId,
          gateway: alipay.gateway,
          privateKey: alipay.privateKey,
          alipayPublicKey: alipay.alipayPublicKey,
          keyType: alipay.privateKeyType,
        });
  const database = initializeDatabase(config.dbPath);
  const payment =
    alipay === null || alipaySdk === null || delivery === null
      ? ({ enabled: false } as const)
      : ({
          enabled: true,
          database,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          deliveryEncKeyring: delivery.deliveryEncKeyring,
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
    diagnosis: {
      database,
      nodeEnv: config.nodeEnv,
      tokenHmacKeyring: credentials.tokenHmacKeyring,
      rateLimitKeyring: credentials.rateLimitKeyring,
      csrfSigningKey: credentials.csrfSigningKey,
    },
    payment,
  });
  let databaseClosed = false;
  let mailDispatcher: ReturnType<typeof startRegistrationMailRuntime> | null =
    null;

  const closeDatabase = (): void => {
    if (!databaseClosed) {
      database.close();
      databaseClosed = true;
    }
  };

  const expirySweep = payment.enabled ? startOrderExpirySweep(payment) : null;

  app.addHook("onClose", async () => {
    expirySweep?.stop();
    await mailDispatcher?.stop();
    closeDatabase();
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    if (mailConfig.enabled && mailTransport !== null) {
      mailDispatcher = startRegistrationMailRuntime(
        {
          database,
          mailPayloadEncKeyring: credentials.mailPayloadEncKeyring,
          transport: mailTransport,
        },
        mailConfig.dispatcher,
      );
    }
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
