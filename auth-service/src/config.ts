export const LOOPBACK_HOST = "127.0.0.1" as const;

export type RuntimeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly dbPath: string;
  readonly nodeEnv: RuntimeEnvironment;
}

function requireValue(
  environment: NodeJS.ProcessEnv,
  name: "HOST" | "PORT" | "DB_PATH" | "NODE_ENV",
): string {
  const value = environment[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function parseNodeEnvironment(value: string): RuntimeEnvironment {
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }

  throw new Error("NODE_ENV must be development, test, or production");
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnvironment(requireValue(environment, "NODE_ENV"));
  const host = requireValue(environment, "HOST");

  if (host !== LOOPBACK_HOST) {
    throw new Error(`HOST must be exactly ${LOOPBACK_HOST}`);
  }

  const port = parsePort(requireValue(environment, "PORT"));
  const dbPath = requireValue(environment, "DB_PATH");

  return Object.freeze({
    host: LOOPBACK_HOST,
    port,
    dbPath,
    nodeEnv,
  });
}
