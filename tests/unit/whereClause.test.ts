import { describe, expect, it } from "vitest";
import { buildWhereClause } from "../../src/db/queries/whereClause.ts";
import type { LogFilters } from "../../src/domain/query.ts";

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: {}, limit: 100, ...overrides };
}

describe("buildWhereClause", () => {
  it("returns empty SQL when there are no filters", () => {
    const result = buildWhereClause(filters());
    expect(result.sql).toBe("");
    expect(result.values).toEqual([]);
  });

  it("numbers placeholders sequentially", () => {
    const result = buildWhereClause(
      filters({ service: "checkout", level: "error" }),
    );
    expect(result.sql).toBe("WHERE service = $1 AND level = $2");
    expect(result.values).toEqual(["checkout", "error"]);
  });

  describe("injection safety", () => {
    const HOSTILE = "'); DROP TABLE logs; --";

    it("never places a service value into the SQL text", () => {
      const result = buildWhereClause(filters({ service: HOSTILE }));
      expect(result.sql).not.toContain("DROP");
      expect(result.sql).toBe("WHERE service = $1");
      expect(result.values).toEqual([HOSTILE]);
    });

    it("never places an attribute key into the SQL text", () => {
      const result = buildWhereClause(
        filters({ attributes: { [HOSTILE]: "x" } }),
      );
      expect(result.sql).not.toContain("DROP");
      expect(result.sql).toBe("WHERE attributes @> $1");
    });

    it("never places a search term into the SQL text", () => {
      const result = buildWhereClause(filters({ q: HOSTILE }));
      expect(result.sql).not.toContain("DROP");
    });

    it("produces SQL containing only placeholders, never quoted literals", () => {
      const result = buildWhereClause(
        filters({
          service: HOSTILE,
          level: "error",
          q: HOSTILE,
          attributes: { [HOSTILE]: HOSTILE },
        }),
      );
      // Every value lives in the parameter array; the text has no user input.
      for (const value of result.values) {
        if (typeof value === "string") {
          expect(result.sql).not.toContain(value);
        }
      }
    });
  });

  describe("LIKE escaping", () => {
    it("escapes a percent sign so it matches literally", () => {
      const result = buildWhereClause(filters({ q: "100%" }));
      expect(result.values[0]).toBe("%100\\%%");
    });

    it("escapes an underscore", () => {
      const result = buildWhereClause(filters({ q: "a_b" }));
      expect(result.values[0]).toBe("%a\\_b%");
    });

    it("escapes a lone wildcard rather than matching everything", () => {
      const result = buildWhereClause(filters({ q: "%" }));
      expect(result.values[0]).toBe("%\\%%");
    });
  });

  describe("attributes", () => {
    it("collapses all attribute filters into one JSON parameter", () => {
      const result = buildWhereClause(
        filters({ attributes: { user_id: "42", region: "eu-west" } }),
      );
      expect(result.sql).toBe("WHERE attributes @> $1");
      expect(result.values).toEqual([
        JSON.stringify({ user_id: "42", region: "eu-west" }),
      ]);
    });

    it("omits the condition entirely when there are no attributes", () => {
      const result = buildWhereClause(filters({ service: "api" }));
      expect(result.sql).not.toContain("attributes");
    });
  });

  describe("time range", () => {
    it("uses an inclusive lower bound and exclusive upper bound", () => {
      const since = new Date("2026-08-01T00:00:00Z");
      const until = new Date("2026-08-02T00:00:00Z");
      const result = buildWhereClause(filters({ since, until }));
      expect(result.sql).toContain('"timestamp" >= $1');
      expect(result.sql).toContain('"timestamp" < $2');
    });
  });

  it("appends the cursor as a row comparison", () => {
    const result = buildWhereClause(filters({ service: "api" }), {
      timestamp: new Date("2026-08-01T00:00:00Z"),
      id: "4521",
    });
    expect(result.sql).toContain('("timestamp", id) < ($2, $3)');
    expect(result.values).toHaveLength(3);
  });
});