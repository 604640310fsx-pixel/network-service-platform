import type { MailDispatcherRuntimeConfig } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  startMailDispatcher,
  type MailDispatcherPolicy,
  type MailDispatcherRunner,
  type MailTransport,
} from "./mail-dispatcher.js";

export interface RegistrationMailRuntimeDependencies {
  readonly database: DatabaseConnection;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly transport: MailTransport;
}

export function createMailDispatcherPolicy(
  config: MailDispatcherRuntimeConfig,
): MailDispatcherPolicy {
  const retryDelaysMs = Object.freeze([...config.retryDelaysMs]);
  return Object.freeze({
    leaseMs: config.leaseMs,
    maxAttempts: config.maxAttempts,
    retryDelayMs: (attempts: number): number => {
      if (!Number.isSafeInteger(attempts) || attempts < 1) {
        throw new Error("Mail dispatcher retry attempt is invalid");
      }
      const delay = retryDelaysMs[attempts - 1];
      if (delay === undefined) {
        throw new Error("Mail dispatcher retry schedule is exhausted");
      }
      return delay;
    },
  });
}

export function startRegistrationMailRuntime(
  dependencies: RegistrationMailRuntimeDependencies,
  config: MailDispatcherRuntimeConfig,
): MailDispatcherRunner {
  return startMailDispatcher(
    {
      database: dependencies.database,
      mailPayloadEncKeyring: dependencies.mailPayloadEncKeyring,
      transport: dependencies.transport,
      policy: createMailDispatcherPolicy(config),
    },
    config.intervalMs,
  );
}
