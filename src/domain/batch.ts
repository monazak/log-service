import type { RejectedEntry, ValidLogEntry } from "./log.ts";
import { validateLogEntry } from "./validations.ts";

/**
 * Validates a batch, keeping valid entries and recording why each invalid one
 * was rejected.
 *
 * The spec requires partial success: one bad entry must not fail the batch.
 * `now` is captured once per batch rather than per entry — at 15k entries/sec
 * that removes thousands of clock reads, and it makes the five-minute future
 * check consistent across the whole batch.
 */

export interface BatchResult {
  readonly valid: ValidLogEntry[];
  readonly rejected: RejectedEntry[];
}

export function validateBatch(entries: readonly unknown[]): BatchResult {
  const now = Date.now();
  const valid: ValidLogEntry[] = [];
  const rejected: RejectedEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const result = validateLogEntry(entries[index], now);
    if (result.ok) {
      valid.push(result.entry);
    } else {
      rejected.push({ index, reason: result.reason });
    }
  }
  return { valid, rejected };
}
