import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

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

  on(signal: "SIGTERM" | "SIGINT", listener: () => void): void {
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
  readonly mailEnabled?: boolean;
  readonly mailStartFailure?: boolean;
  readonly listenFailure?: boolean;
} = {}) {
  const events: string[] = [];
  const calls = {
    appClose: 0,
    expiryStop: 0,
    mailStop: 0,
    databaseClose: 0,
  };
  const signalTarget = new FakeSignalTarget();
  const shutdownReported = deferred();
  const reports: string[] = [];
  let onClose = async (): Promise<void> => undefined;

  const failIfRequested = (step: LifecycleFailureStep): void => {
    if (options.failStep === step) {
      throw new Error(`${step}: ${LIFECYCLE_SECRET}`);
    }
  };

  return {
    events,
    calls,
    signalTarget,
    shutdownReported,
    reports,
    runtimeOptions: {
      database: {
        close: (): void => {
          calls.databaseClose += 1;
          events.push("database.close");
          failIfRequested("database.close");
        },
      },
      createRuntime: () => {
        events.push("app.create");
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
            if (options.listenFailure === true) {
              throw new Error(`listen: ${LIFECYCLE_SECRET}`);
            }
          },
          close: async (): Promise<void> => {
            calls.appClose += 1;
            events.push("app.close");
            failIfRequested("app.close");
            await onClose();
          },
        };
        return {
          app,
          startExpirySweep: () => {
            events.push("expiry.start");
            return {
              stop: async (): Promise<void> => {
                calls.expiryStop += 1;
                events.push("expiry.stop");
                failIfRequested("expiry.stop");
              },
            };
          },
          startMailDispatcher: () => {
            if (options.mailEnabled === false) {
              return null;
            }
            events.push("mail.start");
            if (options.mailStartFailure === true) {
              throw new Error(`mail.start: ${LIFECYCLE_SECRET}`);
            }
            return {
              stop: async (): Promise<void> => {
                calls.mailStop += 1;
                events.push("mail.stop");
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
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    DB_PATH: join(directory, "auth.sqlite"),
    REGISTRATION_ENABLED: "false",
    PAYMENT_ENABLED: "false",
    CREDENTIALS_DIRECTORY: join(directory, "credentials"),
    MAIL_DISPATCH_ENABLED: mailEnabled ? "true" : "false",
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

test("internal lifecycle starts enabled mail before listening and cleans resources in frozen order", async () => {
  const harness = createLifecycleHarness();
  const controller = await __serverLifecycleTest.run(harness.runtimeOptions);
  assert.deepEqual(harness.events, [
    "app.create",
    "expiry.start",
    "mail.start",
    "listen",
  ]);

  const firstShutdown = controller.shutdown();
  const concurrentShutdown = controller.shutdown();
  assert.strictEqual(concurrentShutdown, firstShutdown);
  await firstShutdown;
  assert.deepEqual(harness.events, [
    "app.create",
    "expiry.start",
    "mail.start",
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
});

test("internal lifecycle keeps mail disabled and still closes the database once", async () => {
  const harness = createLifecycleHarness({ mailEnabled: false });
  const controller = await __serverLifecycleTest.run(harness.runtimeOptions);
  await controller.shutdown();
  assert.deepEqual(harness.events, [
    "app.create",
    "expiry.start",
    "listen",
    "app.close",
    "expiry.stop",
    "database.close",
  ]);
  assert.equal(harness.calls.mailStop, 0);
  assert.equal(harness.calls.databaseClose, 1);
});

test("a synchronous startup failure after database creation uses the shared cleanup boundary", async () => {
  const events: string[] = [];
  await assert.rejects(
    __serverLifecycleTest.run({
      database: {
        close: (): void => {
          events.push("database.close");
        },
      },
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
  });

  await t.test("listen failure", async () => {
    const harness = createLifecycleHarness({ listenFailure: true });
    await assert.rejects(
      __serverLifecycleTest.run(harness.runtimeOptions),
      /listen/,
    );
    assert.deepEqual(harness.events, [
      "app.create",
      "expiry.start",
      "mail.start",
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
  });
});

test("repeated mixed signals share one successful shutdown chain", async () => {
  const harness = createLifecycleHarness();
  const controller = await __serverLifecycleTest.run(harness.runtimeOptions);
  harness.signalTarget.emit("SIGTERM");
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
    const child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: serverEnvironment(directory, port, false),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectOutput(child);
    try {
      await waitForHealth(port, child);
      assert.equal(output.stdout(), "");
      assert.equal(output.stderr(), "");
    } finally {
      await stopChild(child);
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
    const child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: serverEnvironment(directory, port, true),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectOutput(child);
    try {
      await waitForHealth(port, child);
      assert.equal(output.stdout(), "");
      assert.equal(output.stderr(), "");
    } finally {
      await stopChild(child);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listen failure exits nonzero after draining the already-started mail runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-runtime-listen-fail-"));
  const blocker = createServer();
  let child: ChildProcess | undefined;
  let port = 0;
  try {
    await createCredentialDirectory(directory, true);
    port = await listenLoopback(blocker);
    child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: serverEnvironment(directory, port, true),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectOutput(child);
    assert.deepEqual(await waitForExit(child), { code: 1, signal: null });
    assert.equal(output.stdout(), "");
    assert.equal(output.stderr(), "auth-service failed to start\n");
    for (const secret of [LIFECYCLE_SECRET, "example_api_key", KEYRING, CSRF_KEY]) {
      assert.equal(output.stderr().includes(secret), false);
    }
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
    try {
      await createCredentialDirectory(directory, false);
      const port = await reserveLoopbackPort();
      child = spawn(process.execPath, ["dist/src/server.js"], {
        cwd: process.cwd(),
        env: serverEnvironment(directory, port, false),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = collectOutput(child);
      await waitForHealth(port, child);

      const exited = waitForExit(child);
      assert.equal(child.kill(signal), true);
      child.kill(signal);
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.equal(output.stdout(), "");
      assert.equal(output.stderr(), "");
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
    const child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: serverEnvironment(directory, port, true),
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
