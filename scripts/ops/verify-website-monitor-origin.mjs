#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* Build-time gate for the public monitor origin embedded in the website.
   The value comes only from the VITE_MONITOR_URL environment variable (never
   from arguments), and no output, error, or log line ever contains it.
   Policy "required" (integration release candidates) fails closed when the
   origin is missing, malformed, or absent from the built website; policy
   "optional" (pull requests and test builds) reports an absent origin as
   test-only instead of failing. */

export const MONITOR_ORIGIN_ENVIRONMENT = "VITE_MONITOR_URL";
const POLICIES = new Set(["required", "optional"]);
const PHASES = new Set(["configured", "embedded"]);
const SCANNED_EXTENSIONS = [".html", ".js"];

export class MonitorOriginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MonitorOriginError";
    this.code = code;
  }
}

function isIpLiteral(hostname) {
  return /^[0-9.]+$/.test(hostname) || hostname.startsWith("[");
}

/* Returns the validated origin or throws without echoing the input. */
export function validatedMonitorOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MonitorOriginError(
      "MONITOR_ORIGIN_INVALID",
      "public monitor origin is not a valid URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/" ||
    raw !== url.origin ||
    !url.hostname.includes(".") ||
    isIpLiteral(url.hostname)
  ) {
    throw new MonitorOriginError(
      "MONITOR_ORIGIN_INVALID",
      "public monitor origin must be a bare https origin with a DNS hostname",
    );
  }
  return url.origin;
}

function collectScannedFiles(root, relative = "") {
  const absolute = join(root, relative);
  const state = lstatSync(absolute);
  if (state.isSymbolicLink()) {
    throw new MonitorOriginError(
      "WEBSITE_DIST_INVALID",
      "website dist must not contain symbolic links",
    );
  }
  if (state.isDirectory()) {
    return readdirSync(absolute)
      .sort()
      .flatMap((entry) => collectScannedFiles(root, join(relative, entry)));
  }
  if (!state.isFile()) {
    return [];
  }
  return SCANNED_EXTENSIONS.some((extension) => relative.endsWith(extension))
    ? [absolute]
    : [];
}

function countEmbeddingFiles(distRoot, origin) {
  let root;
  try {
    root = realpathSync(resolve(distRoot));
    if (!lstatSync(root).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new MonitorOriginError(
      "WEBSITE_DIST_INVALID",
      "website dist directory is missing",
    );
  }
  return collectScannedFiles(root).filter((file) =>
    readFileSync(file, "utf8").includes(origin),
  ).length;
}

export function verifyWebsiteMonitorOrigin({
  phase,
  policy,
  dist,
  environment = process.env,
}) {
  if (!PHASES.has(phase)) {
    throw new MonitorOriginError(
      "ARGUMENT_ERROR",
      "--phase must be configured or embedded",
    );
  }
  if (!POLICIES.has(policy)) {
    throw new MonitorOriginError(
      "ARGUMENT_ERROR",
      "--policy must be required or optional",
    );
  }
  const raw = environment[MONITOR_ORIGIN_ENVIRONMENT] ?? "";
  if (raw === "") {
    if (policy === "required") {
      throw new MonitorOriginError(
        "MONITOR_ORIGIN_REQUIRED",
        "a release candidate build requires the public monitor origin",
      );
    }
    return Object.freeze({
      status: "ok",
      phase,
      monitorOrigin: "absent",
      releaseUse: "test-only",
    });
  }
  const origin = validatedMonitorOrigin(raw);
  if (phase === "configured") {
    return Object.freeze({ status: "ok", phase, monitorOrigin: "configured" });
  }
  if (dist === undefined) {
    throw new MonitorOriginError(
      "ARGUMENT_ERROR",
      "--dist is required for the embedded phase",
    );
  }
  const files = countEmbeddingFiles(dist, origin);
  if (files === 0) {
    throw new MonitorOriginError(
      "MONITOR_ORIGIN_NOT_EMBEDDED",
      "the built website does not embed the configured public monitor origin",
    );
  }
  return Object.freeze({
    status: "ok",
    phase,
    monitorOrigin: "embedded",
    embeddingFiles: files,
  });
}

function parseArguments(arguments_) {
  const allowed = new Set(["--phase", "--policy", "--dist"]);
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(name) || value === undefined || options.has(name)) {
      throw new MonitorOriginError(
        "ARGUMENT_ERROR",
        "usage: --phase configured|embedded --policy required|optional [--dist <dir>]",
      );
    }
    options.set(name, value);
  }
  return options;
}

export function run(arguments_, environment = process.env) {
  const options = parseArguments(arguments_);
  return verifyWebsiteMonitorOrigin({
    phase: options.get("--phase"),
    policy: options.get("--policy"),
    dist: options.get("--dist"),
    environment,
  });
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (error) {
    const safe =
      error instanceof MonitorOriginError
        ? error
        : new MonitorOriginError(
            "INTERNAL_FAILURE",
            "public monitor origin verification failed",
          );
    process.stderr.write(
      `${JSON.stringify({ status: "error", code: safe.code, message: safe.message })}\n`,
    );
    process.exitCode = 1;
  }
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
