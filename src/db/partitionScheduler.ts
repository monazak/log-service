import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { ensurePartitions } from "./migrate.ts";

const INTERVAL_MS = 60 * 60 * 1000;

export function startPartitionScheduler(app: FastifyInstance, pool: pg.Pool) {
  const timer = setInterval(() => {
    ensurePartitions(pool)
      .then((created) => {
        if (created > 0) {
          app.log.info({ created }, "Created log partitions");
        }
      })
      .catch((error: unknown) => {
        app.log.error(error, "Partition maintenance failed");
      });
  }, INTERVAL_MS);
  timer.unref();

  return timer;
}
