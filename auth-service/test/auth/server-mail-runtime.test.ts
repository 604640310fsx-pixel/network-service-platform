import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const KEYRING = JSON.stringify({
  version: 1,
  keys: { "1": Buffer.alloc(32, 0x51).toString("base64") },
});
const CSRF_KEY = Buffer.alloc(32, 0x52).toString("base64");

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
    assert.match(
      output.stderr(),
      /^auth-service failed to start: Resend credential configuration is invalid\n$/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
