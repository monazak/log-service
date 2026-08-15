import { describe, expect, it } from "vitest";
import { validateLogEntry } from "../../src/domain/validation.ts";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

function entry(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-08-12T11:59:00.000Z",
    level: "info",
    service: "checkout",
    message: "payment ok",
    ...overrides,
  };
}

describe("validateLogEntry", () => {
  it("accepts a valid entry", () => {
    const result = validateLogEntry(entry(), NOW);
    expect(result.ok).toBe(true);
  });

  describe("timestamp", () => {
    it("rejects a missing timestamp", () => {
      const result = validateLogEntry(entry({ timestamp: undefined }), NOW);
      expect(result).toMatchObject({
        ok: false,
        reason: "missing required field: timestamp",
      });
    });

    it("rejects an unparseable timestamp", () => {
      const result = validateLogEntry(entry({ timestamp: "not-a-date" }), NOW);
      expect(result.ok).toBe(false);
    });

    it("accepts a timestamp 4 minutes in the future", () => {
      const result = validateLogEntry(
        entry({ timestamp: "2026-08-12T12:04:00.000Z" }),
        NOW,
      );
      expect(result.ok).toBe(true);
    });

    it("rejects a timestamp 6 minutes in the future", () => {
      const result = validateLogEntry(
        entry({ timestamp: "2026-08-12T12:06:00.000Z" }),
        NOW,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "timestamp is more than 5 minutes in the future",
      });
    });

    it("accepts an offset timestamp equal to the same instant", () => {
      const result = validateLogEntry(
        entry({ timestamp: "2026-08-12T14:59:00.000+03:00" }),
        NOW,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("level", () => {
    for (const level of ["debug", "info", "warn", "error"]) {
      it(`accepts level '${level}'`, () => {
        expect(validateLogEntry(entry({ level }), NOW).ok).toBe(true);
      });
    }

    it("rejects an unsupported level", () => {
      const result = validateLogEntry(entry({ level: "critical" }), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("critical");
      }
    });
  });

  describe("service and message", () => {
    it("rejects an empty service", () => {
      const result = validateLogEntry(entry({ service: "" }), NOW);
      expect(result).toMatchObject({
        ok: false,
        reason: "service must be a non-empty string",
      });
    });

    it("rejects an empty message", () => {
      const result = validateLogEntry(entry({ message: "" }), NOW);
      expect(result.ok).toBe(false);
    });
  });

  describe("attributes", () => {
    it("defaults to an empty object when absent", () => {
      const result = validateLogEntry(entry(), NOW);
      expect(result.ok && result.entry.attributes).toEqual({});
    });

    it("coerces numbers and booleans to strings", () => {
      const result = validateLogEntry(
        entry({ attributes: { retries: 3, ok: true, id: "42" } }),
        NOW,
      );
      expect(result.ok && result.entry.attributes).toEqual({
        retries: "3",
        ok: "true",
        id: "42",
      });
    });

    it("rejects nested objects", () => {
      const result = validateLogEntry(
        entry({ attributes: { user: { id: 1 } } }),
        NOW,
      );
      expect(result.ok).toBe(false);
    });

    it("rejects arrays as attribute values", () => {
      const result = validateLogEntry(entry({ attributes: { tags: ["a"] } }), NOW);
      expect(result.ok).toBe(false);
    });

    it("rejects a non-object attributes field", () => {
      const result = validateLogEntry(entry({ attributes: "nope" }), NOW);
      expect(result.ok).toBe(false);
    });
  });

  it("rejects a non-object entry", () => {
    expect(validateLogEntry("hello", NOW).ok).toBe(false);
    expect(validateLogEntry(null, NOW).ok).toBe(false);
    expect(validateLogEntry([1, 2], NOW).ok).toBe(false);
  });
});