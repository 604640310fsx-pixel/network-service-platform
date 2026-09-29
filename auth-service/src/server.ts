import { pathToFileURL } from "node:url";

import { AlipaySdk } from "alipay-sdk";

import { buildApp, type ReadinessDependencies } from "./app.js";
import {
  loadAlipayConfig,
  loadAuthCredentialConfig,
  loadConfig,
  loadDeliveryCredentialConfig,
  loadMailRuntimeConfig,
  loadMonitorCredentialConfig,
  loadMonitorRuntimeConfig,
  loadResendCredentialConfig,
} from "./config.js";
import {
  initializeDatabase,
  prepareDatabaseReadinessProbe,
  type DatabaseReadinessProbe,
} from "./db.js";
import { createMonitorPrivateClient } from "./monitor/private-client.js";
import { startOrderExpirySweep } from "./payment/order-expiry.js";
import { startRegistrationMailRuntime } from "./registration/mail-runtime.js";
import { ResendMailTransport } from "./registration/resend-mail-transport.js";

interface RuntimeLifecycleApp {
  addHook(name: "onClose", hook: () => Promise<void>): unknown;
  listen(options: {
    readonly host: string;
    readonly port: number;
  }): Promise<unknown>;
  close(): Promise<void>;
}

interface RuntimeSignalTarget {
  exitCode: number | undefined;
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

interface RuntimeLifecycleOptions {
  readonly database: Pick<
    ReturnType<typeof initializeDatabase>,
    "close" | "prepare"
  >;
  readonly paymentEnabled: boolean;
  readonly mailEnabled: boolean;
  readonly createRuntime: (readiness: ReadinessDependencies) => {
    readonly app: RuntimeLifecycleApp;
    readonly startExpirySweep: () =>
      | ReturnType<typeof startOrderExpirySweep>
      | null;
    readonly startMailDispatcher: () =>
      | ReturnType<typeof startRegistrationMailRuntime>
      | null;
  };
  readonly listen: { readonly host: string; readonly port: number };
  readonly signalTarget?: RuntimeSignalTarget;
  readonly reportShutdownFailure?: () => void;
}

interface RuntimeLifecycleController {
  readonly shutdown: () => Promise<void>;
}

function appendFailure(failures: unknown[], error: unknown): void {
  if (!failures.some((failure) => Object.is(failure, error))) {
    failures.push(error);
  }
}

function combinedFailure(message: string, failures: readonly unknown[]): unknown {
  if (failures.length === 1) {
    return failures[0];
  }
  return new AggregateError(failures, message);
}

async function runRuntimeLifecycle(
  options: RuntimeLifecycleOptions,
): Promise<RuntimeLifecycleController> {
  const signalTarget = options.signalTarget ?? process;
  const reportShutdownFailure =
    options.reportShutdownFailure ??
    (() => {
      console.error("auth-service failed to shut down");
    });
  let app: RuntimeLifecycleApp | null = null;
  let expirySweep: ReturnType<typeof startOrderExpirySweep> | null = null;
  let mailDispatcher: ReturnType<typeof startRegistrationMailRuntime> | null =
    null;
  let databaseProbe: DatabaseReadinessProbe | null = null;
  let phase: "non_serving" | "serving" = "non_serving";
  let expiryHandleReady = false;
  let mailHandleReady = false;
  let cleanupPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let shutdownFailureReported = false;

  const markNonServing = (): void => {
    phase = "non_serving";
    expiryHandleReady = false;
    mailHandleReady = false;
  };

  const readiness = Object.freeze({
    isReady: (): boolean => {
      if (phase !== "serving" || databaseProbe === null) {
        return false;
      }
      return (
        databaseProbe.isReady() &&
        (!options.paymentEnabled || expiryHandleReady) &&
        (!options.mailEnabled || mailHandleReady)
      );
    },
  });

  const cleanupRuntime = (): Promise<void> => {
    markNonServing();
    if (cleanupPromise === null) {
      cleanupPromise = (async () => {
        const failures: unknown[] = [];
        try {
          await expirySweep?.stop();
        } catch (error) {
          appendFailure(failures, error);
        }
        try {
          await mailDispatcher?.stop();
        } catch (error) {
          appendFailure(failures, error);
        }
        try {
          options.database.close();
        } catch (error) {
          appendFailure(failures, error);
        }
        if (failures.length > 0) {
          throw combinedFailure("auth-service runtime cleanup failed", failures);
        }
      })();
    }
    return cleanupPromise;
  };

  const shutdown = (): Promise<void> => {
    markNonServing();
    if (shutdownPromise === null) {
      shutdownPromise = (async () => {
        const failures: unknown[] = [];
        if (app !== null) {
          try {
            await app.close();
          } catch (error) {
            appendFailure(failures, error);
          }
        }
        try {
          await cleanupRuntime();
        } catch (error) {
          appendFailure(failures, error);
        }
        if (failures.length > 0) {
          throw combinedFailure("auth-service shutdown failed", failures);
        }
      })();
    }
    return shutdownPromise;
  };

  const requestSignalShutdown = (): void => {
    void shutdown().catch(() => {
      signalTarget.exitCode = 1;
      if (!shutdownFailureReported) {
        shutdownFailureReported = true;
        reportShutdownFailure();
      }
    });
  };

  try {
    const runtime = options.createRuntime(readiness);
    app = runtime.app;
    app.addHook("onClose", cleanupRuntime);
    databaseProbe = prepareDatabaseReadinessProbe(options.database);
    expirySweep = runtime.startExpirySweep();
    expiryHandleReady = expirySweep !== null;
    mailDispatcher = runtime.startMailDispatcher();
    mailHandleReady = mailDispatcher !== null;
    if (options.signalTarget === undefined) {
      process.on("SIGTERM", requestSignalShutdown);
      process.on("SIGINT", requestSignalShutdown);
    } else {
      signalTarget.on("SIGTERM", requestSignalShutdown);
      signalTarget.on("SIGINT", requestSignalShutdown);
    }
    phase = "serving";
    await app.listen(options.listen);
  } catch (startupError) {
    const failures: unknown[] = [startupError];
    try {
      await shutdown();
    } catch (shutdownError) {
      appendFailure(failures, shutdownError);
    }
    throw combinedFailure("auth-service startup failed", failures);
  }

  return Object.freeze({ shutdown });
}

export const __serverLifecycleTest = Object.freeze({
  run: runRuntimeLifecycle,
});

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
  const monitor = loadMonitorRuntimeConfig();
  const monitorCredentials = monitor.enabled
    ? loadMonitorCredentialConfig()
    : null;
  const monitorPrivateClient =
    monitor.enabled && monitorCredentials !== null
      ? createMonitorPrivateClient(monitor.privateOrigin, monitorCredentials)
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
  await runRuntimeLifecycle({
    database,
    paymentEnabled: config.paymentEnabled,
    mailEnabled: mailConfig.enabled,
    createRuntime: (readiness) => {
      const payment =
        alipay === null || alipaySdk === null || delivery === null
          ? ({ enabled: false } as const)
          : ({
              enabled: true,
              database,
              tokenHmacKeyring: credentials.tokenHmacKeyring,
              deliveryEncKeyring: delivery.deliveryEncKeyring,
              csrfSigningKey: credentials.csrfSigningKey,
              monitorTargetCatalog: monitorPrivateClient,
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
        inviteAdmin: {
          database,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          inviteHmacKeyring: credentials.inviteHmacKeyring,
          mailPayloadEncKeyring: credentials.mailPayloadEncKeyring,
          csrfSigningKey: credentials.csrfSigningKey,
        },
        diagnosis: {
          database,
          nodeEnv: config.nodeEnv,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          rateLimitKeyring: credentials.rateLimitKeyring,
          csrfSigningKey: credentials.csrfSigningKey,
        },
        tickets: {
          database,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          csrfSigningKey: credentials.csrfSigningKey,
        },
        invites: {
          database,
          nodeEnv: config.nodeEnv,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          csrfSigningKey: credentials.csrfSigningKey,
        },
        account: {
          database,
          nodeEnv: config.nodeEnv,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          mailPayloadEncKeyring: credentials.mailPayloadEncKeyring,
          rateLimitKeyring: credentials.rateLimitKeyring,
          csrfSigningKey: credentials.csrfSigningKey,
        },
        referral: {
          database,
          nodeEnv: config.nodeEnv,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          rateLimitKeyring: credentials.rateLimitKeyring,
          csrfSigningKey: credentials.csrfSigningKey,
          publicLink: config.referralPublicLink,
        },
        monitor: {
          database,
          tokenHmacKeyring: credentials.tokenHmacKeyring,
          rateLimitKeyring: credentials.rateLimitKeyring,
          privateClient: monitorPrivateClient,
        },
        payment,
        readiness,
      });
      return {
        app,
        startExpirySweep: () =>
          payment.enabled ? startOrderExpirySweep(payment) : null,
        startMailDispatcher: () =>
          mailConfig.enabled && mailTransport !== null
            ? startRegistrationMailRuntime(
                {
                  database,
                  mailPayloadEncKeyring: credentials.mailPayloadEncKeyring,
                  transport: mailTransport,
                },
                mailConfig.dispatcher,
              )
            : null,
      };
    },
    listen: { host: config.host, port: config.port },
  });
}

const serverEntryPoint = process.argv[1];
if (
  serverEntryPoint !== undefined &&
  import.meta.url === pathToFileURL(serverEntryPoint).href
) {
  void start().catch(() => {
    console.error("auth-service failed to start");
    process.exitCode = 1;
  });
}
