import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  linkSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const OWNER_READ_WRITE_MODE = 0o600;
const BACKUP_ARTIFACT_SUFFIXES = ["", "-wal", "-shm", "-journal"];

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

function assertOwnerOnly(path, label) {
  let mode;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new ToolError("PERMISSION_FAILED", `${label} permissions could not be read`);
  }
  if (mode !== OWNER_READ_WRITE_MODE) {
    throw new ToolError("PERMISSION_FAILED", `${label} permissions must be 0600`);
  }
}

function restrictToOwner(path, label) {
  try {
    chmodSync(path, OWNER_READ_WRITE_MODE);
  } catch {
    throw new ToolError(
      "PERMISSION_FAILED",
      `${label} permissions could not be restricted to 0600`,
    );
  }
  assertOwnerOnly(path, label);
}

function createPrivatePartial(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", OWNER_READ_WRITE_MODE);
  } catch {
    throw new ToolError("BACKUP_FAILED", "private backup workspace could not be created");
  }

  try {
    closeSync(descriptor);
  } catch {
    throw new ToolError("BACKUP_FAILED", "private backup workspace could not be closed");
  }
  restrictToOwner(path, "partial backup");
}

function removeBackupArtifacts(path, includeDatabase = true) {
  let cleanupFailed = false;
  for (const suffix of BACKUP_ARTIFACT_SUFFIXES) {
    if (!includeDatabase && suffix === "") {
      continue;
    }
    const artifact = `${path}${suffix}`;
    if (existsSync(artifact)) {
      try {
        chmodSync(artifact, OWNER_READ_WRITE_MODE);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      rmSync(artifact, { force: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new ToolError("CLEANUP_FAILED", "private backup artifacts could not be removed");
  }
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

  removeBackupArtifacts(path, false);
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

function expectedLastMigration(options) {
  const value = requireValue(options, "--expected-last-migration");
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ToolError(
      "ARGUMENT_ERROR",
      "--expected-last-migration must be a positive integer",
    );
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new ToolError(
      "ARGUMENT_ERROR",
      "--expected-last-migration must be a safe integer",
    );
  }
  return version;
}

function assertExpectedMigrationBoundary(migrations, expectedLast) {
  if (migrations.length !== expectedLast) {
    throw new ToolError(
      "MIGRATION_MISMATCH",
      `backup schema_migrations does not match expected range 1..${expectedLast}`,
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
  let destinationLinked = false;
  let published = false;

  try {
    createPrivatePartial(partial);
    sourceDatabase = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await sourceDatabase.backup(partial);
    } catch {
      throw new ToolError("BACKUP_FAILED", "SQLite online backup failed");
    }

    restrictToOwner(partial, "partial backup");
    normalizeBackupToSingleFile(partial);
    restrictToOwner(partial, "partial backup");
    const backupInspection = inspectDatabase(partial, "backup");
    assertMatchingMigrations(
      sourceInspection.migrations,
      backupInspection.migrations,
    );
    const digest = await sha256(partial);
    const bytes = statSync(partial).size;
    try {
      sourceDatabase.close();
      sourceDatabase = undefined;
    } catch {
      throw new ToolError("BACKUP_FAILED", "SQLite source could not be closed cleanly");
    }

    try {
      linkSync(partial, destination);
      destinationLinked = true;
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "EEXIST") {
        throw new ToolError("DESTINATION_EXISTS", "destination already exists");
      }
      throw new ToolError("DESTINATION_INVALID", "destination could not be created");
    }
    restrictToOwner(destination, "backup");
    published = true;

    return {
      status: "ok",
      operation: "create",
      quickCheck: backupInspection.quickCheck,
      foreignKeyFailures: backupInspection.foreignKeyFailures,
      migrations: backupInspection.migrations,
      sha256: digest,
      bytes,
      fileMode: "0600",
    };
  } finally {
    let closeFailed = false;
    let cleanupFailed = false;
    try {
      sourceDatabase?.close();
    } catch {
      closeFailed = true;
    }
    if (destinationLinked && !published) {
      try {
        removeBackupArtifacts(destination);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      removeBackupArtifacts(partial);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw new ToolError("CLEANUP_FAILED", "private backup artifacts could not be removed");
    }
    if (closeFailed) {
      throw new ToolError("BACKUP_FAILED", "SQLite source could not be closed cleanly");
    }
  }
}

async function verifyBackup(options) {
  requireOnlyOptions(
    options,
    new Set(["--backup", "--expected-sha256", "--expected-last-migration"]),
  );
  const backup = existingFilePath(requireValue(options, "--backup"), "backup");
  const expectedHash = requireValue(options, "--expected-sha256").toLowerCase();
  const expectedLast = expectedLastMigration(options);

  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new ToolError(
      "ARGUMENT_ERROR",
      "--expected-sha256 must be 64 hexadecimal characters",
    );
  }
  assertOwnerOnly(backup, "backup");
  const backupInspection = inspectDatabase(backup, "backup");
  assertExpectedMigrationBoundary(backupInspection.migrations, expectedLast);
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
    fileMode: "0600",
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
