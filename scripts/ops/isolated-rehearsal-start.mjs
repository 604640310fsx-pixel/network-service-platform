#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* Fail-closed start guard for isolated Auth rehearsals.
   Run it as the rehearsal process itself (for example the ExecStart of a
   transient unit), so it checks the environment AFTER the service manager
   has resolved every Environment= and EnvironmentFile= source. It refuses to
   start the server unless DB_PATH is an existing regular file inside the
   rehearsal root, is not the protected live database (by path and by inode),
   and PORT differs from the protected live port. Output never contains a path,
   port, or other environment value. */

export class RehearsalGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RehearsalGuardError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new RehearsalGuardError(code, message);
}

function existingRealPath(path, label, kind) {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    refuse("ARGUMENT_ERROR", `${label} must be an absolute path`);
  }
  let real;
  try {
    real = realpathSync(path);
  } catch {
    refuse("REHEARSAL_REFUSED", `${label} does not exist`);
  }
  const state = statSync(real);
  if (kind === "file" ? !state.isFile() : !state.isDirectory()) {
    refuse("REHEARSAL_REFUSED", `${label} is not a ${kind}`);
  }
  return { real, state };
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function parsedPort(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) {
    refuse("REHEARSAL_REFUSED", `${label} must be a TCP port number`);
  }
  const port = Number(value);
  if (port > 65535) {
    refuse("REHEARSAL_REFUSED", `${label} must be a TCP port number`);
  }
  return port;
}

export function assertIsolatedRehearsal({
  protectedDb,
  protectedPort,
  rehearsalRoot,
  environment = process.env,
}) {
  const live = existingRealPath(protectedDb, "--protected-db", "file");
  const root = existingRealPath(rehearsalRoot, "--rehearsal-root", "directory");
  const livePort = parsedPort(protectedPort, "--protected-port");
  if (
    root.real === dirname(live.real) ||
    isInside(root.real, live.real) ||
    isInside(root.real, dirname(live.real))
  ) {
    refuse(
      "REHEARSAL_REFUSED",
      "the rehearsal root must not contain the protected database",
    );
  }

  const dbPath = environment.DB_PATH;
  if (typeof dbPath !== "string" || !isAbsolute(dbPath)) {
    refuse("REHEARSAL_REFUSED", "resolved DB_PATH must be an absolute path");
  }
  if (lstatSync(dbPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    refuse("REHEARSAL_REFUSED", "resolved DB_PATH must not be a symbolic link");
  }
  const candidate = existingRealPath(dbPath, "resolved DB_PATH", "file");
  if (
    candidate.real === live.real ||
    (candidate.state.dev === live.state.dev &&
      candidate.state.ino === live.state.ino)
  ) {
    refuse(
      "REHEARSAL_REFUSED",
      "resolved DB_PATH is the protected live database",
    );
  }
  if (!isInside(root.real, candidate.real)) {
    refuse(
      "REHEARSAL_REFUSED",
      "resolved DB_PATH is outside the rehearsal root",
    );
  }
  if (parsedPort(environment.PORT, "resolved PORT") === livePort) {
    refuse("REHEARSAL_REFUSED", "resolved PORT is the protected live port");
  }
  return Object.freeze({
    status: "ok",
    guard: "isolated-rehearsal",
    database: "rehearsal-copy",
    port: "not-live",
  });
}

function parseArguments(arguments_) {
  const allowed = new Set([
    "--protected-db",
    "--protected-port",
    "--rehearsal-root",
    "--server",
  ]);
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(name) || value === undefined || options.has(name)) {
      refuse(
        "ARGUMENT_ERROR",
        "usage: --protected-db <file> --protected-port <port> --rehearsal-root <dir> --server <server.js>",
      );
    }
    options.set(name, value);
  }
  for (const name of allowed) {
    if (!options.has(name)) {
      refuse("ARGUMENT_ERROR", `${name} is required`);
    }
  }
  return options;
}

export function run(arguments_, environment = process.env) {
  const options = parseArguments(arguments_);
  const result = assertIsolatedRehearsal({
    protectedDb: options.get("--protected-db"),
    protectedPort: options.get("--protected-port"),
    rehearsalRoot: options.get("--rehearsal-root"),
    environment,
  });
  const server = existingRealPath(options.get("--server"), "--server", "file");
  return { result, server: server.real };
}

function main() {
  let checked;
  try {
    checked = run(process.argv.slice(2));
  } catch (error) {
    const safe =
      error instanceof RehearsalGuardError
        ? error
        : new RehearsalGuardError(
            "INTERNAL_FAILURE",
            "isolated rehearsal guard failed",
          );
    process.stderr.write(
      `${JSON.stringify({ status: "error", code: safe.code, message: safe.message })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${JSON.stringify(checked.result)}\n`);
  startGuardedServer(checked.server);
}

/* Starts the already-checked server. A spawn failure exits non-zero with a
   fixed message that carries no path or environment value. */
export function startGuardedServer(server, executable = process.execPath) {
  const child = spawn(executable, [server], {
    env: process.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", () => {
    process.stderr.write(
      `${JSON.stringify({
        status: "error",
        code: "SERVER_START_FAILED",
        message: "rehearsal server process could not be started",
      })}\n`,
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128);
  });
  return child;
}

function isDirectExecution(moduleUrl, argumentPath) {
  if (argumentPath === undefined) {
    return false;
  }
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) ===
      realpathSync(resolve(argumentPath))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main();
}
