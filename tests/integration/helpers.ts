import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { LogBatcher } from "../../src/db/batcher.ts";
import { loadConfig } from "../../src/config/env.ts";
import { ensurePartitions, runMigrations } from "../../src/db/migrate.ts";
import { closePools, createPools, type Pools } from "../../src/db/pool.ts";
import { markReady } from "../../src/http/readiness.ts";
import { buildServer } from "../../src/http/server.ts";

/**
 * Integration test harness.
 *
 * Uses Fastify's inject() rather than a real socket: it exercises the same
 * routing, parsing, and error handling without binding a port, so tests can run
 * alongside a live dev server. This is only possible because buildServer() is
 * separate from listen().
 *
 * Runs against the Compose database rather than mocking it. The entire project
 * is about database behaviour; a mock would test the mock.
 */

const TEST_SERVICE_PREFIX = "itest-";

export interface Harness {
  readonly app: FastifyInstance;
  readonly pools: Pools;
  /** The write pool, for tests that need direct SQL. */
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

  const pools = createPools(config);
  const batcher = new LogBatcher(pools.write);
  const app = buildServer(config, pools, batcher);

  await runMigrations(pools.write);
  await ensurePartitions(pools.write);
  markReady();

  return {
    app,
    pools,
    pool: pools.write,

    async cleanup() {
      // Rollup rows are cleaned first: they reference buckets that the log
      // deletion below is about to empty, and a stale rollup row would make the
      // next test's aggregate totals wrong.
      //
      // Both grains, not just the minute one. The aggregate query reads
      // `log_rollup_1s` for the partial minute at each end of a range, so a
      // second-grain row left behind here is counted by the next test even
      // though the raw rows it summarises are gone.
      for (const table of ["log_rollup_1s", "log_rollup_1m"] as const) {
        await pools.write.query(
          `DELETE FROM ${table} WHERE service LIKE $1`,
          [`${TEST_SERVICE_PREFIX}%`],
        );
      }

      await pools.write.query("DELETE FROM logs WHERE service LIKE $1", [
        `${TEST_SERVICE_PREFIX}%`,
      ]);

      await app.close();
      await closePools(pools);
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