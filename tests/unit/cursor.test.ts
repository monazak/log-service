import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/domain/cursor.ts";

describe("cursor", () => {
  it("round-trips a position", () => {
    const timestamp = new Date("2026-08-08T10:00:00.000Z");
    const encoded = encodeCursor(timestamp, "4521");
    const decoded = decodeCursor(encoded);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.position.timestamp.toISOString()).toBe(
        "2026-08-08T10:00:00.000Z",
      );
      expect(decoded.position.id).toBe("4521");
    }
  });

  it("produces a URL-safe string", () => {
    const encoded = encodeCursor(new Date("2026-08-08T10:00:00.000Z"), "1");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("keeps id as a string so BIGINT precision is not lost", () => {
    const big = "9007199254740993";
    const decoded = decodeCursor(
      encodeCursor(new Date("2026-08-08T10:00:00.000Z"), big),
    );
    expect(decoded.ok && decoded.position.id).toBe(big);
  });

  describe("rejects malformed input", () => {
    const cases: Record<string, string> = {
      "not base64": "!!!not-base64!!!",
      "valid base64, not JSON": Buffer.from("hello").toString("base64url"),
      "JSON array": Buffer.from("[1,2]").toString("base64url"),
      "JSON null": Buffer.from("null").toString("base64url"),
      "missing fields": Buffer.from("{}").toString("base64url"),
      "non-numeric id": Buffer.from(
        JSON.stringify({ t: "2026-08-08T10:00:00.000Z", i: "abc" }),
      ).toString("base64url"),
      "invalid timestamp": Buffer.from(
        JSON.stringify({ t: "not-a-date", i: "1" }),
      ).toString("base64url"),
      "empty string": "",
    };

    for (const [name, value] of Object.entries(cases)) {
      it(`rejects ${name}`, () => {
        const result = decodeCursor(value);
        expect(result).toEqual({ ok: false, error: "invalid cursor" });
      });
    }
  });
});