import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { buildApp, type ReadinessDependencies } from "../../src/app.js";
import { MIGRATION_FILES } from "../../src/db.js";
import { __serverLifecycleTest } from "../../src/server.js";

const KEYRING = JSON.stringify({
  version: 1,
  keys: { "1": Buffer.alloc(32, 0x51).toString("base64") },
});
const CSRF_KEY = Buffer.alloc(32, 0x52).toString("base64");
const LIFECYCLE_SECRET = "must-not-appear-lifecycle-secret";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeSignalTarget {
  exitCode: number | undefined = 0;
  readonly listeners = new Map<"SIGTERM" | "SIGINT", Array<() => void>>();

  constructor(
    private readonly onRegistration: (
      signal: "SIGTERM" | "SIGINT",
    ) => void = () => undefined,
  ) {}

  on(signal: "SIGTERM" | "SIGINT", listener: () => void): void {
    this.onRegistration(signal);
    const listeners = this.listeners.get(signal) ?? [];
    listeners.push(listener);
    this.listeners.set(signal, listeners);
  }

  emit(signal: "SIGTERM" | "SIGINT"): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener();
    }
  }
}

type LifecycleFailureStep =
  | "app.close"
  | "expiry.stop"
  | "mail.stop"
  | "database.close";

function createLifecycleHarness(options: {
  readonly failStep?: LifecycleFailureStep;
  readonly paymentEnabled?: boolean;
  readonly mailEnabled?: boolean;
  readonly expiryMissing?: boolean;
  readonly mailMissing?: boolean;
  readonly mailStartFailure?: boolean;
  readonly listenFailure?: boolean;
  readonly databaseRows?: readonly unknown[];
  readonly databaseProbeThrows?: boolean;
  readonly databasePrepareFailure?: boolean;
} = {}) {
  const events: string[] = [];
  const calls = {
    appClose: 0,
    expiryStop: 0,
    mailStop: 0,
    databaseClose: 0,
  };
  const databaseCalls = {
    prepare: [] as string[],
    all: [] as unknown[][],
  };
  const readinessObservations: Array<{
    readonly point: string;
    readonly ready: boolean;
    readonly databaseProbeCalls: number;
  }> = [];
  let runtimeReadiness: ReadinessDependencies = { isReady: () => false };
  const observeReadiness = (point: string): void => {
    const ready = runtimeReadiness.isReady();
    readinessObservations.push({
      point,
      ready,
      databaseProbeCalls: databaseCalls.all.length,
    });
  };
  const signalTarget = new FakeSignalTarget((signal) => {
    events.push(`signal.${signal}`);
    observeReadiness(`signal.${signal}`);
  });
  const shutdownReported = deferred();
  const reports: string[] = [];
  let onClose = async (): Promise<void> => undefined;
  let databaseClosed = false;
  const paymentEnabled = options.paymentEnabled ?? true;
  const mailEnabled = options.mailEnabled ?? true;
  const expectedRows = MIGRATION_FILES.map((file) => ({
    version: Number.parseInt(file.slice(0, 3), 10),
  }));

  const failIfRequested = (step: LifecycleFailureStep): void => {
    if (options.failStep === step) {
      throw new Error(`${step}: ${LIFECYCLE_SECRET}`);
    }
  };

  return {
    events,
    calls,
    databaseCalls,
    readinessObservations,
    signalTarget,
    shutdownReported,
    reports,
    isReady: (): boolean => runtimeReadiness.isReady(),
    runtimeOptions: {
      paymentEnabled,
      mailEnabled,
      database: {
        prepare: (source: string) => {
          events.push("database.prepare");
          observeReadiness("database.prepare");
          databaseCalls.prepare.push(source);
          if (options.databasePrepareFailure === true) {
            throw new Error(`database.prepare: ${LIFECYCLE_SECRET}`);
          }
          return {
            all: (...parameters: readonly unknown[]): unknown[] => {
              databaseCalls.all.push([...parameters]);
              if (
                databaseClosed ||
                options.databaseProbeThrows === true
              ) {
                throw new Error(`database.probe: ${LIFECYCLE_SECRET}`);
              }
              return [...(options.databaseRows ?? expectedRows)];
            },
            run: () => ({ changes: 0 }),
          };
        },
        close: (): void => {
          calls.databaseClose += 1;
          events.push("database.close");
          databaseClosed = true;
          failIfRequested("database.close");
        },
      },
      createRuntime: (readiness: ReadinessDependencies) => {
        runtimeReadiness = readiness;
        events.push("app.create");
        observeReadiness("app.create");
        const app = {
          addHook: (
            name: "onClose",
            hook: () => Promise<void>,
          ): void => {
            assert.equal(name, "onClose");
            onClose = hook;
          },
          listen: async (): Promise<void> => {
            events.push("listen");
            observeReadiness("listen");
            if (options.listenFailure === true) {
              throw new Error(`listen: ${LIFECYCLE_SECRET}`);
            }
          },
          close: async (): Promise<void> => {
            calls.appClose += 1;
            events.push("app.close");
            observeReadiness("app.close");
            failIfRequested("app.close");
            await onClose();
          },
        };
        return {
          app,
          startExpirySweep: () => {
            events.push("expiry.start");
            observeReadiness("expiry.start");
            if (paymentEnabled === false || options.expiryMissing === true) {
              return null;
            }
            return {
              stop: async (): Promise<void> => {
                calls.expiryStop += 1;
                events.push("expiry.stop");
                observeReadiness("expiry.stop");
                failIfRequested("expiry.stop");
              },
            };
          },
          startMailDispatcher: () => {
            if (mailEnabled === false) {
              return null;
            }
            events.push("mail.start");
            observeReadiness("mail.start");
            if (options.mailStartFailure === true) {
              throw new Error(`mail.start: ${LIFECYCLE_SECRET}`);
            }
            if (options.mailMissing === true) {
              return null;
            }
            return {
              stop: async (): Promise<void> => {
                calls.mailStop += 1;
                events.push("mail.stop");
                observeReadiness("mail.stop");
                failIfRequested("mail.stop");
              },
            };
          },
        };
      },
      listen: { host: "127.0.0.1", port: 1 },
      signalTarget,
      reportShutdownFailure: (): void => {
        reports.push("auth-service failed to shut down");
        shutdownReported.resolve();
      },
    },
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback port reservation failed");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function listenLoopback(
  server: ReturnType<typeof createServer>,
  port = 0,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback listener address was unavailable");
  }
  return address.port;
}

async function closeLoopback(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function createCredentialDirectory(
  directory: string,
  includeResendKey: boolean,
): Promise<void> {
  const credentialsDirectory = join(directory, "credentials");
  await mkdir(credentialsDirectory, { mode: 0o700 });
  for (const name of [
    "token_hmac_keyring",
    "invite_hmac_keyring",
    "mail_payload_enc_keyring",
    "rate_limit_key",
  ]) {
    await writeFile(join(credentialsDirectory, name), KEYRING, { mode: 0o600 });
  }
  await writeFile(join(credentialsDirectory, "csrf_signing_key"), CSRF_KEY, {
    mode: 0o600,
  });
  if (includeResendKey) {
    await writeFile(
      join(credentialsDirectory, "resend_api_key"),
      "example_api_key",
      { mode: 0o600 },
    );
  }
}

interface PaymentTestConfiguration {
  readonly privateKeyFile: string;
  readonly publicKeyFile: string;
}

async function createPaymentTestConfiguration(
  directory: string,
): Promise<PaymentTestConfiguration> {
  const credentialsDirectory = join(directory, "credentials");
  await writeFile(
    join(credentialsDirectory, "delivery_payload_enc_keyring"),
    KEYRING,
    { mode: 0o600 },
  );
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const privateKeyFile = join(directory, "merchant-private.pem");
  const publicKeyFile = join(directory, "provider-public.pem");
  await writeFile(privateKeyFile, privateKey, { mode: 0o600 });
  await writeFile(publicKeyFile, publicKey, { mode: 0o600 });
  return { privateKeyFile, publicKeyFile };
}

async function spawnNetworkGuardedServer(
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<{
  readonly child: ChildProcess;
  readonly outboundMarker: string;
}> {
  const outboundMarker = join(directory, "unexpected-outbound-network");
  const guardPath = join(directory, "forbid-outbound-network.mjs");
  await writeFile(
    guardPath,
    [
      'import { appendFileSync } from "node:fs";',
      'import net from "node:net";',
      "net.Socket.prototype.connect = function guardedConnect() {",
      '  appendFileSync(process.env.TEST_OUTBOUND_MARKER, "attempt\\n");',
      '  throw new Error("outbound network is forbidden in readiness tests");',
      "};",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    ["--import", guardPath, "dist/src/server.js"],
    {
      cwd: process.cwd(),
      env: { ...environment, TEST_OUTBOUND_MARKER: outboundMarker },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { child, outboundMarker };
}

async function assertNoOutboundAttempt(path: string): Promise<void> {
  await assert.rejects(
    access(path),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
}

function collectOutput(child: ChildProcess): {
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("auth-service exited before health was ready");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) {
        assert.deepEqual(await response.json(), { status: "ok" });
        return;
      }
    } catch {
      // The loopback listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("auth-service health did not become ready");
}

async function waitForFirstReadiness(
  port: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("auth-service exited before readiness was reachable");
    }
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/ready`);
    } catch {
      await delay(20);
      continue;
    }
    assert.equal(response.status, 200, "the first accepted /ready must be ready");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal(await response.text(), '{"status":"ready"}');
    return;
  }
  throw new Error("auth-service readiness was not reachable");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await waitForExit(child);
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("auth-service did not exit after signal"));
    }, timeoutMs);
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

function serverEnvironment(
  directory: string,
  port: number,
  mailEnabled: boolean,
  payment?: PaymentTestConfiguration,
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    DB_PATH: join(directory, "auth.sqlite"),
    REGISTRATION_ENABLED: "false",
    PAYMENT_ENABLED: payment === undefined ? "false" : "true",
    CREDENTIALS_DIRECTORY: join(directory, "credentials"),
    MAIL_DISPATCH_ENABLED: mailEnabled ? "true" : "false",
    ...(payment === undefined
      ? {}
      : {
          ALIPAY_ENVIRONMENT: "sandbox",
          ALIPAY_APP_ID: "2026000000000000",
          ALIPAY_SELLER_ID: "2088000000000000",
          ALIPAY_NOTIFY_URL: "https://example.invalid/api/pay/alipay/notify",
          ALIPAY_RETURN_URL: "https://example.invalid/payment/return",
          ALIPAY_PRIVATE_KEY_FILE: payment.privateKeyFile,
          ALIPAY_PUBLIC_KEY_FILE: payment.publicKeyFile,
          ALIPAY_PRIVATE_KEY_TYPE: "PKCS8",
        }),
    ...(mailEnabled
      ? {
          MAIL_DISPATCH_INTERVAL_MS: "5",
          MAIL_DISPATCH_LEASE_MS: "1000",
          MAIL_DISPATCH_MAX_ATTEMPTS: "1",
          MAIL_DISPATCH_RETRY_DELAYS_MS: "[]",
          RESEND_FROM_EMAIL: "sender@example.com",
          RESEND_REQUEST_TIMEOUT_MS: "100",
        }
      : {}),
  };
}

async function assertLoopbackLifecycleReadiness(options: {
  readonly paymentEnabled: boolean;
  readonly mailEnabled: boolean;
  readonly expiryHandle: boolean;
  readonly mailHandle: boolean;
  readonly database: "ready" | "not_ready" | "throw";
  readonly expected: "ready" | "not_ready";
}): Promise<void> {
  const exactRows = MIGRATION_FILES.map((file) => ({
    version: Number.parseInt(file.slice(0, 3), 10),
  }));
  let app = buildApp();
  let readiness: ReadinessDependencies = { isReady: () => false };
  let databaseClosed = false;
  let prepareCalls = 0;
  let probeCalls = 0;
  const signalTarget = new FakeSignalTarget();
  const controller = await __serverLifecycleTest.run({
    paymentEnabled: options.paymentEnabled,
    mailEnabled: options.mailEnabled,
    database: {
      prepare: (source: string) => {
        prepareCalls += 1;
        assert.equal(
          source,
          "SELECT version FROM schema_migrations ORDER BY version LIMIT ?",
        );
        return {
          all: (...parameters: readonly unknown[]): unknown[] => {
            probeCalls += 1;
            assert.deepEqual(parameters, [17]);
            if (databaseClosed || options.database === "throw") {
              throw new Error(`database unavailable: ${LIFECYCLE_SECRET}`);
            }
            return options.database === "ready"
              ? exactRows
              : exactRows.slice(0, -1);
          },
          run: () => ({ changes: 0 }),
        };
      },
      close: () => {
        databaseClosed = true;
      },
    },
    createRuntime: (dependency) => {
      readiness = dependency;
      app = buildApp({ readiness });
      return {
        app: {
          addHook: (name: "onClose", hook: () => Promise<void>) =>
            app.addHook(name, hook),
          listen: (listenOptions: {
            readonly host: string;
            readonly port: number;
          }) => app.listen(listenOptions),
          close: () => app.close(),
        },
        startExpirySweep: () => {
          if (!options.expiryHandle) {
            return null;
          }
          return { stop: async () => undefined };
        },
        startMailDispatcher: () => {
          if (!options.mailHandle) {
            return null;
          }
          return { stop: async () => undefined };
        },
      };
    },
    listen: { host: "127.0.0.1", port: 0 },
    signalTarget,
  });

  try {
    const address = app.server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const port = (address as { readonly port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(response.status, options.expected === "ready" ? 200 : 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal(await response.text(), `{"status":"${options.expected}"}`);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"status":"ok"}');
    assert.equal(prepareCalls, 1);
    assert.equal(probeCalls, 1);

    const shutdown = controller.shutdown();
    assert.equal(readiness.isReady(), false);
    assert.equal(probeCalls, 1, "non-serving readiness must not query SQLite");
    await shutdown;
  } finally {
    await controller.shutdown().catch(() => undefined);
  }
}

test("isolated loopback /ready reflects the exact DB and configured-worker predicate", async () => {
  const scenarios = [
    {
      name: "disabled payment and mail with ready schema",
      paymentEnabled: false,
      mailEnabled: false,
      expiryHandle: false,
      mailHandle: false,
      database: "ready",
      expected: "ready",
    },
    {
      name: "enabled payment has an expiry handle and mail is disabled",
      paymentEnabled: true,
      mailEnabled: false,
      expiryHandle: true,
      mailHandle: false,
      database: "ready",
      expected: "ready",
    },
    {
      name: "enabled payment and enabled idle mail have handles",
      paymentEnabled: true,
      mailEnabled: true,
      expiryHandle: true,
      mailHandle: true,
      database: "ready",
      expected: "ready",
    },
    {
      name: "enabled payment is missing its expiry handle",
      paymentEnabled: true,
      mailEnabled: false,
      expiryHandle: false,
      mailHandle: false,
      database: "ready",
      expected: "not_ready",
    },
    {
      name: "database schema is incomplete",
      paymentEnabled: false,
      mailEnabled: false,
      expiryHandle: false,
      mailHandle: false,
      database: "not_ready",
      expected: "not_ready",
    },
    {
      name: "database query throws",
      paymentEnabled: false,
      mailEnabled: false,
      expiryHandle: false,
      mailHandle: false,
      database: "throw",
      expected: "not_ready",
    },
  ] as const;

  for (const scenario of scenarios) {
    await assertLoopbackLifecycleReadiness(scenario);
  }
});

test("internal lifecycle starts enabled mail before listening and cleans resources in frozen order", async () => {
  const harness = createLifecycleHarness();
  const controller = await __serverLifecycleTest.run(harness.runtimeOptions);
  assert.deepEqual(harness.events, [
    "app.create",
    "database.prepare",
    "expiry.start",
    "mail.start",
    "signal.SIGTERM",
    "signal.SIGINT",
    "listen",
  ]);
  assert.deepEqual(harness.databaseCalls, {
    prepare: ["SELECT version FROM schema_migrations ORDER BY version LIMIT ?"],
    all: [[17]],
  });
  assert.deepEqual(harness.readinessObservations, [
    { point: "app.create", ready: false, databaseProbeCalls: 0 },
    { point: "database.prepare", ready: false, databaseProbeCalls: 0 },
    { point: "expiry.start", ready: false, databaseProbeCalls: 0 },
    { point: "mail.start", ready: false, databaseProbeCalls: 0 },
    { point: "signal.SIGTERM", ready: false, databaseProbeCalls: 0 },
    { point: "signal.SIGINT", ready: false, databaseProbeCalls: 0 },
    { point: "listen", ready: true, databaseProbeCalls: 1 },
  ]);

  const firstShutdown = controller.shutdown();
  assert.equal(harness.isReady(), false);
  assert.equal(harness.databaseCalls.all.length, 1);
  const concurrentShutdown = controller.shutdown();
  assert.strictEqual(concurrentShutdown, firstShutdown);
  await firstShutdown;
  assert.deepEqual(harness.events, [
    "app.create",
    "database.prepare",
    "expiry.start",
    "mail.start",
    "signal.SIGTERM",
    "signal.SIGINT",
    "listen",
    "app.close",
    "expiry.stop",
    "mail.stop",
    "database.close",
  ]);
  assert.deepEqual(harness.calls, {
    appClose: 1,
    expiryStop: 1,
    mailStop: 1,
    databaseClose: 1,
  });
  assert.equal(harness.isReady(), false);
  assert.equal(harness.databaseCalls.all.length, 1);
  assert.equal(
    harness.readinessObservations
      .filter(({ point }) => point !== "listen")
      .every(({ ready }) => ready === false),
    true,
  );
});

test("internal lifecycle keeps mail disabled and still closes the database once", async () => {
  const harness = createLifecycleHarness({ mailEnabled: false });
  const controller = await __serverLifecycleTest.run(harness.runtimeOptions);
  await controller.shutdown();
  assert.deepEqual(harness.events, [
    "app.create",
    "database.prepare",
    "expiry.start",
    "signal.SIGTERM",
    "signal.SIGINT",
    "listen",
    "app.close",
    "expiry.stop",
    "database.close",
  ]);
  assert.equal(harness.calls.mailStop, 0);
  assert.equal(harness.calls.databaseClose, 1);
  assert.equal(harness.isReady(), false);
});

test("lifecycle readiness accepts disabled workers and requires enabled handles plus the database", async () => {
  const expectedRows = MIGRATION_FILES.map((file) => ({
    version: Number.parseInt(file.slice(0, 3), 10),
  }));
  const scenarios = [
    {
      name: "payment and mail disabled",
      options: { paymentEnabled: false, mailEnabled: false },
      expected: true,
    },
    {
      name: "payment enabled with expiry handle and mail disabled",
      options: { paymentEnabled: true, mailEnabled: false },
      expected: true,
    },
    {
      name: "payment enabled without expiry handle",
      options: { paymentEnabled: true, mailEnabled: false, expiryMissing: true },
      expected: false,
    },
    {
      name: "enabled payment and mail both have started handles",
      options: { paymentEnabled: true, mailEnabled: true },
      expected: true,
    },
    {
      name: "enabled mail without a started handle",
      options: { paymentEnabled: false, mailEnabled: true, mailMissing: true },
      expected: false,
    },
    {
      name: "database has a migration gap",
      options: {
        paymentEnabled: false,
        mailEnabled: false,
        databaseRows: expectedRows.map((row, index) =>
          index === 7 ? { version: 9 } : row,
        ),
      },
      expected: false,
    },
    {
      name: "database query throws",
      options: {
        paymentEnabled: false,
        mailEnabled: false,
        databaseProbeThrows: true,
      },
      expected: false,
    },
    {
      name: "database prepare throws",
      options: {
        paymentEnabled: false,
        mailEnabled: false,
        databasePrepareFailure: true,
      },
      expected: false,
    },
  ] as const;

  for (const scenario of scenarios) {
    const harness = createLifecycleHarness(scenario.options);
    const controller = await __serverLifecycleTest.run(harness.runtimeOptions);
    const listenObservation = harness.readinessObservations.find(
      ({ point }) => point === "listen",
    );
    assert.equal(listenObservation?.ready, scenario.expected, scenario.name);
    assert.equal(
      harness.readinessObservations
        .filter(({ point }) => point !== "listen")
        .every(({ ready }) => ready === false),
      true,
      scenario.name,
    );
    await controller.shutdown();
    assert.equal(harness.isReady(), false, scenario.name);
  }
});

test("a synchronous startup failure after database creation uses the shared cleanup boundary", async () => {
  const events: string[] = [];
  await assert.rejects(
    __serverLifecycleTest.run({
      database: {
        prepare: (): never => {
          throw new Error("database prepare must not run after app creation fails");
        },
        close: (): void => {
          events.push("database.close");
        },
      },
      paymentEnabled: false,
      mailEnabled: false,
      createRuntime: () => {
        events.push("app.create");
        throw new Error(`app.create: ${LIFECYCLE_SECRET}`);
      },
      listen: { host: "127.0.0.1", port: 1 },
      signalTarget: new FakeSignalTarget(),
    }),
    /app\.create/,
  );
  assert.deepEqual(events, ["app.create", "database.close"]);
});

test("mail-start and listen startup failures leave no later runtime resource open", async (t) => {
  await t.test("mail start failure", async () => {
    const harness = createLifecycleHarness({ mailStartFailure: true });
    await assert.rejects(
      __serverLifecycleTest.run(harness.runtimeOptions),
      /mail\.start/,
    );
    assert.deepEqual(harness.events, [
      "app.create",
      "database.prepare",
      "expiry.start",
      "mail.start",
      "app.close",
      "expiry.stop",
      "database.close",
    ]);
    assert.deepEqual(harness.calls, {
      appClose: 1,
      expiryStop: 1,
      mailStop: 0,
      databaseClose: 1,
    });
    assert.equal(harness.isReady(), false);
    assert.equal(harness.events.includes("listen"), false);
  });

  await t.test("listen failure", async () => {
    const harness = createLifecycleHarness({ listenFailure: true });
    await assert.rejects(
      __serverLifecycleTest.run(harness.runtimeOptions),
      /listen/,
    );
    assert.deepEqual(harness.events, [
      "app.create",
      "database.prepare",
      "expiry.start",
      "mail.start",
      "signal.SIGTERM",
      "signal.SIGINT",
      "listen",
      "app.close",
      "expiry.stop",
      "mail.stop",
      "database.close",
    ]);
    assert.deepEqual(harness.calls, {
      appClose: 1,
      expiryStop: 1,
      mailStop: 1,
      databaseClose: 1,
    });
    assert.equal(harness.isReady(), false);
    assert.equal(harness.databaseCalls.all.length, 1);
    assert.equal(
      harness.readinessObservations.find(({ point }) => point === "app.close")
        ?.ready,
      false,
    );
  });
});

test("repeated mixed signals share one successful shutdown chain", async () => {
  const harness = createLifecycleHarness();
  const controller = await __serverLifecycleTest.run(harness.runtimeOptions);
  harness.signalTarget.emit("SIGTERM");
  assert.equal(harness.isReady(), false);
  harness.signalTarget.emit("SIGINT");
  await controller.shutdown();
  assert.equal(harness.signalTarget.exitCode, 0);
  assert.equal(harness.reports.length, 0);
  assert.deepEqual(harness.calls, {
    appClose: 1,
    expiryStop: 1,
    mailStop: 1,
    databaseClose: 1,
  });
  assert.equal(harness.isReady(), false);
});

for (const failStep of [
  "app.close",
  "expiry.stop",
  "mail.stop",
  "database.close",
] as const) {
  test(`${failStep} failure reports once, remains handled, and attempts every later cleanup`, async () => {
    const harness = createLifecycleHarness({ failStep });
    const unhandledRejections: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", captureUnhandled);
    try {
      const controller = await __serverLifecycleTest.run(
        harness.runtimeOptions,
      );
      harness.signalTarget.emit("SIGTERM");
      harness.signalTarget.emit("SIGINT");
      await Promise.race([
        harness.shutdownReported.promise,
        delay(1_000).then(() => {
          throw new Error("shutdown failure was not reported");
        }),
      ]);
      await assert.rejects(controller.shutdown());
      await delay(0);

      assert.equal(harness.signalTarget.exitCode, 1);
      assert.deepEqual(harness.reports, [
        "auth-service failed to shut down",
      ]);
      assert.equal(harness.reports.join("\n").includes(LIFECYCLE_SECRET), false);
      assert.deepEqual(harness.events.slice(-4), [
        "app.close",
        "expiry.stop",
        "mail.stop",
        "database.close",
      ]);
      assert.deepEqual(harness.calls, {
        appClose: 1,
        expiryStop: 1,
        mailStop: 1,
        databaseClose: 1,
      });
      assert.equal(harness.isReady(), false);
      assert.equal(
        harness.readinessObservations
          .filter(({ point }) =>
            ["app.close", "expiry.stop", "mail.stop"].includes(point),
          )
          .every(({ ready }) => ready === false),
        true,
      );
      assert.deepEqual(unhandledRejections, []);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }
  });
}

test("server leaves mail disabled without reading a Resend credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-runtime-server-off-"));
  try {
    await createCredentialDirectory(directory, false);
    const port = await reserveLoopbackPort();
    const { child, outboundMarker } = await spawnNetworkGuardedServer(
      directory,
      serverEnvironment(directory, port, false),
    );
    const output = collectOutput(child);
    try {
      await waitForFirstReadiness(port, child);
      await waitForHealth(port, child);
      assert.equal(output.stdout(), "");
      assert.equal(output.stderr(), "");
    } finally {
      await stopChild(child);
      await assertNoOutboundAttempt(outboundMarker);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("server starts an explicitly configured idle mail runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-runtime-server-on-"));
  try {
    await createCredentialDirectory(directory, true);
    const port = await reserveLoopbackPort();
    const { child, outboundMarker } = await spawnNetworkGuardedServer(
      directory,
      serverEnvironment(directory, port, true),
    );
    const output = collectOutput(child);
    try {
      await waitForFirstReadiness(port, child);
      await waitForHealth(port, child);
      assert.equal(output.stdout(), "");
      assert.equal(output.stderr(), "");
    } finally {
      await stopChild(child);
      await assertNoOutboundAttempt(outboundMarker);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabled payment has a ready expiry handle with disabled or idle mail and makes no provider request", async () => {
  for (const mailEnabled of [false, true]) {
    const directory = await mkdtemp(
      join(tmpdir(), `payment-readiness-${mailEnabled ? "mail-on" : "mail-off"}-`),
    );
    try {
      await createCredentialDirectory(directory, mailEnabled);
      const payment = await createPaymentTestConfiguration(directory);
      const port = await reserveLoopbackPort();
      const { child, outboundMarker } = await spawnNetworkGuardedServer(
        directory,
        serverEnvironment(directory, port, mailEnabled, payment),
      );
      const output = collectOutput(child);
      try {
        await waitForFirstReadiness(port, child);
        await waitForHealth(port, child);
        assert.equal(output.stdout(), "");
        assert.equal(output.stderr(), "");
      } finally {
        await stopChild(child);
        await assertNoOutboundAttempt(outboundMarker);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("listen failure exits nonzero after draining the already-started mail runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-runtime-listen-fail-"));
  const blocker = createServer();
  let child: ChildProcess | undefined;
  let outboundMarker: string | undefined;
  let port = 0;
  try {
    await createCredentialDirectory(directory, true);
    port = await listenLoopback(blocker);
    const guarded = await spawnNetworkGuardedServer(
      directory,
      serverEnvironment(directory, port, true),
    );
    child = guarded.child;
    outboundMarker = guarded.outboundMarker;
    const output = collectOutput(child);
    assert.deepEqual(await waitForExit(child), { code: 1, signal: null });
    assert.equal(output.stdout(), "");
    assert.equal(output.stderr(), "auth-service failed to start\n");
    for (const secret of [LIFECYCLE_SECRET, "example_api_key", KEYRING, CSRF_KEY]) {
      assert.equal(output.stderr().includes(secret), false);
    }
    await assertNoOutboundAttempt(outboundMarker);
  } finally {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await closeLoopback(blocker);
    if (port !== 0) {
      const probe = createServer();
      try {
        assert.equal(await listenLoopback(probe, port), port);
      } finally {
        await closeLoopback(probe);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`server handles repeated ${signal} with one graceful close`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "signal-shutdown-server-"));
    let child: ChildProcess | undefined;
    let outboundMarker: string | undefined;
    try {
      await createCredentialDirectory(directory, false);
      const port = await reserveLoopbackPort();
      const guarded = await spawnNetworkGuardedServer(
        directory,
        serverEnvironment(directory, port, false),
      );
      child = guarded.child;
      outboundMarker = guarded.outboundMarker;
      const output = collectOutput(child);
      await waitForFirstReadiness(port, child);
      await waitForHealth(port, child);

      const exited = waitForExit(child);
      assert.equal(child.kill(signal), true);
      child.kill(signal);
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.equal(output.stdout(), "");
      assert.equal(output.stderr(), "");
      await assertNoOutboundAttempt(outboundMarker);
    } finally {
      if (child !== undefined && child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          child?.once("exit", () => resolve());
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("enabled mail fails before listening when its credential is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-runtime-server-fail-"));
  try {
    await createCredentialDirectory(directory, false);
    const port = await reserveLoopbackPort();
    const { child, outboundMarker } = await spawnNetworkGuardedServer(
      directory,
      serverEnvironment(directory, port, true),
    );
    const output = collectOutput(child);
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    assert.equal(exitCode, 1);
    assert.equal(output.stdout(), "");
    assert.equal(output.stderr(), "auth-service failed to start\n");
    for (const secret of [LIFECYCLE_SECRET, KEYRING, CSRF_KEY]) {
      assert.equal(output.stderr().includes(secret), false);
    }
    await assertNoOutboundAttempt(outboundMarker);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
