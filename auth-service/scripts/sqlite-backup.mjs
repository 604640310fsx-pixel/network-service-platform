import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  linkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

function requireValue(options, name) {
  const value = options.get(name);
  if (value === undefined || value.trim() === "") {
    throw new ToolError("ARGUMENT_ERROR", `${name} is required`);
  }
  return value;
}

function parseOptions(arguments_) {
  const options = new Map();

  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      throw new ToolError("ARGUMENT_ERROR", "options must be --name value pairs");
    }
    if (options.has(name)) {
      throw new ToolError("ARGUMENT_ERROR", `${name} may be provided only once`);
    }
    options.set(name, value);
  }

  return options;
}

function requireOnlyOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new ToolError("ARGUMENT_ERROR", `unsupported option ${name}`);
    }
  }
}

function existingFilePath(input, label) {
  let path;
  try {
    path = realpathSync(resolve(input));
  } catch {
    throw new ToolError("SOURCE_INVALID", `${label} must be an existing file`);
  }

  try {
    if (!statSync(path).isFile()) {
      throw new ToolError("SOURCE_INVALID", `${label} must be an existing file`);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError("SOURCE_INVALID", `${label} must be an existing file`);
  }

  return path;
}

function newDestinationPath(input) {
  const requestedPath = resolve(input);
  let parent;
  try {
    parent = realpathSync(dirname(requestedPath));
  } catch {
    throw new ToolError("DESTINATION_INVALID", "destination directory must exist");
  }
  return join(parent, basename(requestedPath));
}

function migrationSequence(database, label) {
  let rows;
  try {
    rows = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
  } catch {
    throw new ToolError(
      "VERIFICATION_FAILED",
      `${label} schema_migrations could not be read`,
    );
  }

  const versions = rows.map((row) => row.version);
  if (
    versions.length === 0 ||
    versions.some(
      (version, index) =>
        !Number.isSafeInteger(version) || version !== index + 1,
    )
  ) {
    throw new ToolError(
      "VERIFICATION_FAILED",
      `${label} schema_migrations is not a continuous sequence from 1`,
    );
  }

  return versions;
}

function inspectDatabase(path, label) {
  let database;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    throw new ToolError("VERIFICATION_FAILED", `${label} database could not be opened`);
  }

  try {
    const quickCheck = database.pragma("quick_check");
    if (
      quickCheck.length !== 1 ||
      quickCheck[0] === undefined ||
      quickCheck[0].quick_check !== "ok"
    ) {
      throw new ToolError("VERIFICATION_FAILED", `${label} quick_check failed`);
    }

    const foreignKeyFailures = database.pragma("foreign_key_check");
    if (foreignKeyFailures.length !== 0) {
      throw new ToolError(
        "VERIFICATION_FAILED",
        `${label} foreign_key_check failed`,
      );
    }

    return {
      quickCheck: "ok",
      foreignKeyFailures: 0,
      migrations: migrationSequence(database, label),
    };
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError("VERIFICATION_FAILED", `${label} verification failed`);
  } finally {
    database.close();
  }
}

function normalizeBackupToSingleFile(path) {
  let database;
  try {
    database = new Database(path, { fileMustExist: true });
    const journalMode = database.pragma("journal_mode = DELETE", {
      simple: true,
    });
    if (
      typeof journalMode !== "string" ||
      journalMode.toLowerCase() !== "delete"
    ) {
      throw new ToolError(
        "VERIFICATION_FAILED",
        "backup could not be normalized to single-file journal mode",
      );
    }
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError(
      "VERIFICATION_FAILED",
      "backup could not be normalized to single-file journal mode",
    );
  } finally {
    database?.close();
  }

  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function assertMatchingMigrations(source, backup) {
  if (
    source.length !== backup.length ||
    source.some((version, index) => version !== backup[index])
  ) {
    throw new ToolError(
      "MIGRATION_MISMATCH",
      "backup schema_migrations does not match source",
    );
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
  } catch {
    throw new ToolError("VERIFICATION_FAILED", "backup hash could not be computed");
  }
  return hash.digest("hex");
}

async function createBackup(options) {
  requireOnlyOptions(options, new Set(["--source", "--destination"]));
  const source = existingFilePath(requireValue(options, "--source"), "source");
  const destination = newDestinationPath(
    requireValue(options, "--destination"),
  );

  if (source === destination) {
    throw new ToolError("SAME_PATH", "source and destination must differ");
  }
  if (existsSync(destination)) {
    throw new ToolError("DESTINATION_EXISTS", "destination already exists");
  }

  const sourceInspection = inspectDatabase(source, "source");
  const partial = join(
    dirname(destination),
    `.${basename(destination)}.partial-${process.pid}-${randomUUID()}`,
  );
  let sourceDatabase;

  try {
    sourceDatabase = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await sourceDatabase.backup(partial);
    } catch {
      throw new ToolError("BACKUP_FAILED", "SQLite online backup failed");
    }

    normalizeBackupToSingleFile(partial);
    const backupInspection = inspectDatabase(partial, "backup");
    assertMatchingMigrations(
      sourceInspection.migrations,
      backupInspection.migrations,
    );
    const digest = await sha256(partial);
    const bytes = statSync(partial).size;

    try {
      linkSync(partial, destination);
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "EEXIST") {
        throw new ToolError("DESTINATION_EXISTS", "destination already exists");
      }
      throw new ToolError("DESTINATION_INVALID", "destination could not be created");
    }

    return {
      status: "ok",
      operation: "create",
      quickCheck: backupInspection.quickCheck,
      foreignKeyFailures: backupInspection.foreignKeyFailures,
      migrations: backupInspection.migrations,
      sha256: digest,
      bytes,
    };
  } finally {
    sourceDatabase?.close();
    rmSync(partial, { force: true });
    rmSync(`${partial}-wal`, { force: true });
    rmSync(`${partial}-shm`, { force: true });
  }
}

async function verifyBackup(options) {
  requireOnlyOptions(
    options,
    new Set(["--source", "--backup", "--expected-sha256"]),
  );
  const source = existingFilePath(requireValue(options, "--source"), "source");
  const backup = existingFilePath(requireValue(options, "--backup"), "backup");
  const expectedHash = requireValue(options, "--expected-sha256").toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new ToolError(
      "ARGUMENT_ERROR",
      "--expected-sha256 must be 64 hexadecimal characters",
    );
  }
  if (source === backup) {
    throw new ToolError("SAME_PATH", "source and backup must differ");
  }

  const sourceInspection = inspectDatabase(source, "source");
  const backupInspection = inspectDatabase(backup, "backup");
  assertMatchingMigrations(
    sourceInspection.migrations,
    backupInspection.migrations,
  );
  const digest = await sha256(backup);
  if (digest !== expectedHash) {
    throw new ToolError("HASH_MISMATCH", "backup SHA-256 does not match expected value");
  }

  return {
    status: "ok",
    operation: "verify",
    quickCheck: backupInspection.quickCheck,
    foreignKeyFailures: backupInspection.foreignKeyFailures,
    migrations: backupInspection.migrations,
    sha256: digest,
    bytes: statSync(backup).size,
  };
}

export async function run(arguments_) {
  const [command, ...optionArguments] = arguments_;
  const options = parseOptions(optionArguments);

  if (command === "create") {
    return createBackup(options);
  }
  if (command === "verify") {
    return verifyBackup(options);
  }
  throw new ToolError("ARGUMENT_ERROR", "command must be create or verify");
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const safeError =
      error instanceof ToolError
        ? error
        : new ToolError("INTERNAL_FAILURE", "SQLite backup operation failed");
    process.stderr.write(
      `${JSON.stringify({
        status: "error",
        code: safeError.code,
        message: safeError.message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
