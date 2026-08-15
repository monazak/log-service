import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadConfig } from "../../src/config/env.ts";
import { createPool } from "../../src/db/pool.ts";
import { runMigrations, ensurePartitions } from "../../src/db/migrate.ts";
import { buildServer } from "../../src/http/server.ts";
import { markReady } from "../../src/http/readiness.ts";

/**
 * Integration test harness.
 *
 * Uses Fastify's inject() rather than a real socket: it exercises the same
 * routing, parsing, and error handling without binding a port, so tests can run
 * alongside a live dev server. This is only possible because buildServer() is
 * separate from listen().
 *
 * Runs against the Compose database on localhost:5432 rather than mocking it.
 * The entire project is about database behaviour; a mock would test the mock.
 */

const TEST_SERVICE_PREFIX = "itest-";

export interface Harness {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  cleanup(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
   DATABASE_URL:
      process.env["TEST_DATABASE_URL"] ??
      "postgres://logservice:logservice@127.0.0.1:5432/logs",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  });

  const pool = createPool(config);
  const app = buildServer(config, pool);

  await runMigrations(pool);
  await ensurePartitions(pool);
  markReady();

  return {
    app,
    pool,
    async cleanup() {
      await pool.query("DELETE FROM logs WHERE service LIKE $1", [
        `${TEST_SERVICE_PREFIX}%`,
      ]);
      await app.close();
    },
  };
}

/** Namespaced so tests never touch seeded or load-test data. */
export function testService(name: string): string {
  return `${TEST_SERVICE_PREFIX}${name}`;
}

export function logEntry(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: new Date().toISOString(),
    level: "info",
    service: testService("default"),
    message: "test message",
    ...overrides,
  };
}