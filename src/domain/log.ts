/**
 * Core log entry types.
 *
 * These describe validated data only. Anything arriving over HTTP is `unknown`
 * until it passes through validation — TypeScript types are erased at compile
 * time and provide no runtime guarantee about network input.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AttributeValue = string;

export type Attributes = Readonly<Record<string, AttributeValue>>;

export interface ValidLogEntry {
  readonly timestamp: Date;
  readonly level: LogLevel;
  readonly service: string;
  readonly messsage: string;
  readonly attributes: Attributes;
}

export interface RejectedEntry {
  readonly index: number;
  readonly reason: string;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}
