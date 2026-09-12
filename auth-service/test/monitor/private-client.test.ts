import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMonitorPrivateClient,
  MONITOR_PRIVATE_CATALOG_MAX_BYTES,
  MONITOR_PRIVATE_STATUS_MAX_BYTES,
  MonitorPrivateClientError,
  normalizeMonitorPrivateOrigin,
} from "../../src/monitor/private-client.js";

const DUMMY_CREDENTIALS = {
  caCertificate: Buffer.from("ca"),
  clientCertificate: Buffer.from("certificate"),
  clientPrivateKey: Buffer.from("private-key"),
};

function response(
  value: unknown,
  status = 200,
  overrides: Partial<{
    readonly contentType: string;
    readonly cacheControl: string;
    readonly body: Buffer;
  }> = {},
) {
  return {
    status,
    contentType: overrides.contentType ?? "application/json; charset=utf-8",
    cacheControl: overrides.cacheControl ?? "no-store",
    body: overrides.body ?? Buffer.from(JSON.stringify(value), "utf8"),
  };
}

async function rejectsAs(
  operation: Promise<unknown>,
  failure: "timeout" | "unavailable" | "invalid_response" | "target_unbound",
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof MonitorPrivateClientError && error.failure === failure,
  );
}

test("private client requests only fixed routes with exact bounds and projections", async () => {
  const calls: Array<{ path: string; maxBytes: number; signal: AbortSignal | undefined }> = [];
  const signal = new AbortController().signal;
  const client = createMonitorPrivateClient(
    "https://monitor.internal:3443",
    DUMMY_CREDENTIALS,
    async (path, maxBytes, requestSignal) => {
      calls.push({ path, maxBytes, signal: requestSignal });
      if (path === "/api/auth-service/targets") {
        return response({
          items: [
            { key: "DMIT Premium", label: "美国 DMIT Premium", state: "active" },
            { key: "Paused VPS", label: "维护中的 VPS", state: "disabled" },
          ],
        });
      }
      return response({ status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: false });
    },
  );

  assert.deepEqual(await client.list(signal), [
    { key: "DMIT Premium", label: "美国 DMIT Premium", state: "active" },
    { key: "Paused VPS", label: "维护中的 VPS", state: "disabled" },
  ]);
  assert.deepEqual(await client.status("香港 VPS A", signal), {
    status: "online",
    updatedAt: "2030-01-01T00:01:00Z",
    stale: false,
  });
  assert.deepEqual(calls, [
    {
      path: "/api/auth-service/targets",
      maxBytes: MONITOR_PRIVATE_CATALOG_MAX_BYTES,
      signal,
    },
    {
      path: "/api/auth-service/status?target=%E9%A6%99%E6%B8%AF%20VPS%20A",
      maxBytes: MONITOR_PRIVATE_STATUS_MAX_BYTES,
      signal,
    },
  ]);
});

test("private client rejects schema drift, unsafe metadata, oversized bodies, and invalid UTF-8", async () => {
  const invalidCatalogs = [
    { items: [{ key: "a", label: "A", state: "active", host: "hidden" }] },
    { items: [{ key: "a", label: "A", state: "paused" }] },
    { items: [{ key: "a", label: "A", state: "active" }, { key: "a", label: "B", state: "active" }] },
    { items: "not-an-array" },
    { targets: [] },
  ];
  for (const payload of invalidCatalogs) {
    const client = createMonitorPrivateClient(
      "https://127.0.0.1:3443",
      DUMMY_CREDENTIALS,
      async () => response(payload),
    );
    await rejectsAs(client.list(), "invalid_response");
  }

  const invalidStatuses = [
    { status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: true },
    { status: "stale", updatedAt: "2030-01-01T00:01:00Z", stale: false },
    { status: "online", updatedAt: "2030-01-01T00:01:00.000Z", stale: false },
    { status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: false, host: "hidden" },
  ];
  for (const payload of invalidStatuses) {
    const client = createMonitorPrivateClient(
      "https://127.0.0.1:3443",
      DUMMY_CREDENTIALS,
      async () => response(payload),
    );
    await rejectsAs(client.status("target"), "invalid_response");
  }

  for (const overrides of [
    { contentType: "text/json" },
    { cacheControl: "private, no-store" },
    { body: Buffer.from([0xff]) },
    { body: Buffer.alloc(MONITOR_PRIVATE_STATUS_MAX_BYTES + 1, 0x20) },
  ]) {
    const client = createMonitorPrivateClient(
      "https://127.0.0.1:3443",
      DUMMY_CREDENTIALS,
      async () => response({}, 200, overrides),
    );
    await rejectsAs(client.status("target"), "invalid_response");
  }
});

test("private client maps only the frozen nested error envelopes", async () => {
  for (const [status, code, expected] of [
    [404, "target_not_found", "target_unbound"],
    [409, "target_unavailable", "target_unbound"],
    [502, "monitor_invalid_response", "invalid_response"],
    [503, "monitor_unavailable", "unavailable"],
    [504, "monitor_unavailable", "timeout"],
  ] as const) {
    const client = createMonitorPrivateClient(
      "https://127.0.0.1:3443",
      DUMMY_CREDENTIALS,
      async () => response({ error: { code } }, status),
    );
    await rejectsAs(client.status("target"), expected);
  }
  const malformed = createMonitorPrivateClient(
    "https://127.0.0.1:3443",
    DUMMY_CREDENTIALS,
    async () => response({ error: "monitor_unavailable" }, 503),
  );
  await rejectsAs(malformed.list(), "invalid_response");
});

test("private origin is HTTPS, private-only, credential-free, and path-free", () => {
  assert.equal(normalizeMonitorPrivateOrigin("https://10.0.0.2:3443"), "https://10.0.0.2:3443");
  assert.equal(normalizeMonitorPrivateOrigin("https://monitor.internal"), "https://monitor.internal");
  for (const value of [
    "http://10.0.0.2:3443",
    "https://8.8.8.8:3443",
    "https://user:pass@10.0.0.2:3443",
    "https://10.0.0.2:3443/path",
    " https://10.0.0.2:3443",
  ]) {
    assert.equal(normalizeMonitorPrivateOrigin(value), null);
  }
});

const HAS_OPENSSL = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

function openssl(...arguments_: string[]): void {
  execFileSync("openssl", arguments_, { stdio: "ignore" });
}

test("private client presents a rotatable client certificate and verifies the server hostname", {
  skip: !HAS_OPENSSL,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "auth-monitor-mtls-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = (name: string) => join(directory, name);

  openssl(
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-keyout", path("ca.key"), "-out", path("ca.crt"), "-days", "1",
    "-subj", "/CN=auth-monitor-test-ca",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  );
  await writeFile(
    path("server.ext"),
    "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n",
    "ascii",
  );
  await writeFile(path("client.ext"), "extendedKeyUsage=clientAuth\n", "ascii");

  const issue = (name: string, commonName: string, extension: string, first: boolean) => {
    openssl(
      "req", "-newkey", "rsa:2048", "-nodes", "-sha256",
      "-keyout", path(`${name}.key`), "-out", path(`${name}.csr`),
      "-subj", `/CN=${commonName}`,
    );
    openssl(
      "x509", "-req", "-in", path(`${name}.csr`), "-CA", path("ca.crt"),
      "-CAkey", path("ca.key"), first ? "-CAcreateserial" : "-CAserial",
      ...(first ? [] : [path("ca.srl")]),
      "-out", path(`${name}.crt`), "-days", "1", "-sha256",
      "-extfile", path(extension),
    );
  };
  issue("server", "localhost", "server.ext", true);
  issue("auth-one", "auth-service-one", "client.ext", false);
  issue("auth-two", "auth-service-two", "client.ext", false);

  const peerNames: string[] = [];
  const server = createServer({
    key: await readFile(path("server.key")),
    cert: await readFile(path("server.crt")),
    ca: await readFile(path("ca.crt")),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  }, (request, reply) => {
    const peer = (request.socket as TLSSocket).getPeerCertificate();
    const commonName = peer.subject?.CN;
    peerNames.push(Array.isArray(commonName) ? commonName.join(",") : (commonName ?? ""));
    reply.statusCode = 200;
    reply.setHeader("Content-Type", "application/json; charset=utf-8");
    reply.setHeader("Cache-Control", "no-store");
    if (request.url === "/api/auth-service/targets") {
      reply.end(JSON.stringify({ items: [{ key: "target", label: "Target", state: "active" }] }));
      return;
    }
    reply.end(JSON.stringify({ status: "online", updatedAt: "2030-01-01T00:01:00Z", stale: false }));
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener unavailable");

  const credentials = async (name: string) => ({
    caCertificate: await readFile(path("ca.crt")),
    clientCertificate: await readFile(path(`${name}.crt`)),
    clientPrivateKey: await readFile(path(`${name}.key`)),
  });
  const first = createMonitorPrivateClient(
    `https://localhost:${address.port}`,
    await credentials("auth-one"),
  );
  assert.equal((await first.list())[0]?.key, "target");
  const rotated = createMonitorPrivateClient(
    `https://localhost:${address.port}`,
    await credentials("auth-two"),
  );
  assert.equal((await rotated.status("target")).status, "online");
  assert.deepEqual(peerNames, ["auth-service-one", "auth-service-two"]);

  const hostnameMismatch = createMonitorPrivateClient(
    `https://127.0.0.1:${address.port}`,
    await credentials("auth-two"),
  );
  await rejectsAs(hostnameMismatch.list(), "unavailable");
});
