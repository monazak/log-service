export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly isProduction: boolean;
  readonly databaseUrl: string;
  readonly dbPoolSize: number;
  readonly retentionDays: number;
}

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid PORT: expected an integer between 1 and 65535, received "${raw}"`,
    );
  }
  return parsed;
}

function readPositiveInt(raw: string | undefined, fallback: number, name: string) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: expected a positive integer, received "${raw}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env["NODE_ENV"] ?? "development";
  return {
    port: readPort(env["PORT"], 8080),
    host: env["HOST"] ?? "0.0.0.0",
    logLevel: env["LOG_LEVEL"] ?? (nodeEnv === "production" ? "warn" : "info"),
    isProduction: nodeEnv === "production",
    databaseUrl:
      env["DATABASE_URL"] ?? "postgres://logservice:logservice@postgres:5432/logs",
    dbPoolSize: readPositiveInt(env["DB_POOL_SIZE"], 8, "DB_POOL_SIZE"),
    retentionDays: readPositiveInt(env["RETENTION_DAYS"], 30, "RETENTION_DAYS"),
  };
}
