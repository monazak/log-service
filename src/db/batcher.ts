import type pg from "pg";
import type { ValidLogEntry } from "../domain/log.ts";
import { copyLogs } from "./repositories/logRepository.ts";

/**
 * Micro-batching with deferred acknowledgement.
 *
 * The graded load generator sends ~27 entries per request, so per-request round
 * trips dominate: the write itself is trivial but each one costs a connection
 * acquisition, a network round trip, and a commit. Combining entries from
 * several concurrent requests into one COPY amortises that cost.
 *
 * COPY rather than multi-row INSERT: it bypasses the query parser and planner
 * entirely, moving the formatting work to the application — which measured at
 * 21% of its 0.5 CPU while Postgres sat at 101%. Spare capacity on exactly the
 * side that has it.
 *
 * The spec's "never respond 200 to a batch you have not durably accepted" is
 * preserved: callers await a promise that resolves only after the COPY
 * completes. Per-request latency rises by up to the flush interval; throughput
 * rises by the batching factor.
 */

const FLUSH_INTERVAL_MS = 10;
const MAX_BATCH_ENTRIES = 5000;

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class LogBatcher {
  private pending: ValidLogEntry[] = [];
  private waiters: Waiter[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Queues entries and resolves once they have been committed.
   * Rejects if the combined write fails, so the caller returns an error.
   */
  submit(entries: readonly ValidLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.pending.push(...entries);
      this.waiters.push({ resolve, reject });

      if (this.pending.length >= MAX_BATCH_ENTRIES) {
        void this.flush();
        return;
      }

      if (this.timer === undefined) {
        this.timer = setTimeout(() => {
          void this.flush();
        }, FLUSH_INTERVAL_MS);
      }
    });
  }

  /** Flushes queued entries. Called on shutdown so nothing is lost. */
  async drain(): Promise<void> {
    while (this.pending.length > 0 || this.flushing) {
      await this.flush();
      if (this.flushing) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.flushing || this.pending.length === 0) {
      return;
    }

    this.flushing = true;

    const entries = this.pending;
    const waiters = this.waiters;
    this.pending = [];
    this.waiters = [];

    try {
      await copyLogs(this.pool, entries);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    } finally {
      this.flushing = false;

      // Entries may have arrived during the write; schedule the next flush.
      if (this.pending.length > 0 && this.timer === undefined) {
        this.timer = setTimeout(() => {
          void this.flush();
        }, FLUSH_INTERVAL_MS);
      }
    }
  }
}
