import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, testService, type Harness } from "./helpers.ts";

let h: Harness;
const SERVICE = testService("query");

beforeAll(async () => {
  h = await createHarness();

  const base = Date.now() - 60 * 60 * 1000;
  const logs = Array.from({ length: 25 }, (_, i) => ({
    timestamp: new Date(base + i * 60_000).toISOString(),
    level: i % 5 === 0 ? "error" : "info",
    service: SERVICE,
    message: `query test message ${i}`,
    attributes: { user_id: String(i % 3), region: "eu-west" },
  }));

  await h.app.inject({ method: "POST", url: "/logs", payload: { logs } });
});

afterAll(async () => {
  if (h !== undefined) {
    await h.cleanup();
  }
});

function query(qs: string) {
  return h.app.inject({ method: "GET", url: `/logs?service=${SERVICE}&${qs}` });
}

describe("GET /logs", () => {
  it("returns results in descending timestamp order", async () => {
    const res = await query("limit=10");
    expect(res.statusCode).toBe(200);

    const logs = res.json().logs;
    expect(logs).toHaveLength(10);

    for (let i = 1; i < logs.length; i += 1) {
      expect(
        new Date(logs[i - 1].timestamp).getTime(),
      ).toBeGreaterThanOrEqual(new Date(logs[i].timestamp).getTime());
    }
  });

  it("filters by level", async () => {
    const res = await query("level=error&limit=100");
    const logs = res.json().logs;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l: { level: string }) => l.level === "error")).toBe(true);
  });

  it("filters by attribute", async () => {
    const res = await query("attr.user_id=1&limit=100");
    const logs = res.json().logs;
    expect(logs.length).toBeGreaterThan(0);
    expect(
      logs.every((l: { attributes: Record<string, string> }) =>
        l.attributes.user_id === "1",
      ),
    ).toBe(true);
  });

  it("filters by message substring", async () => {
    const res = await query("q=message 7&limit=100");
    const logs = res.json().logs;
    expect(logs.length).toBeGreaterThan(0);
    expect(
      logs.every((l: { message: string }) => l.message.includes("message 7")),
    ).toBe(true);
  });

  it("treats a lone percent sign as a literal, not a wildcard", async () => {
    const res = await query("q=%25&limit=100");
    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toHaveLength(0);
  });

  describe("pagination", () => {
it("pages without duplicates or gaps", async () => {
      interface LogPage {
        logs: Array<{ id: string }>;
        next_cursor: string | null;
      }

      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;

      do {
        const url: string =
          cursor === null
            ? `/logs?service=${SERVICE}&limit=7`
            : `/logs?service=${SERVICE}&limit=7&cursor=${encodeURIComponent(cursor)}`;

        const res = await h.app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);

        const body = res.json() as LogPage;

        for (const log of body.logs) {
          expect(seen.has(log.id)).toBe(false);
          seen.add(log.id);
        }

        cursor = body.next_cursor;
        pages += 1;
      } while (cursor !== null && pages < 20);

      expect(seen.size).toBe(25);
      expect(cursor).toBeNull();
    });
  });

  describe("invalid parameters return 400", () => {
    const cases: Record<string, string> = {
      "non-numeric limit": "limit=abc",
      "limit above maximum": "limit=5000",
      "limit below minimum": "limit=0",
      "unsupported level": "level=critical",
      "unparseable since": "since=not-a-date",
      "until before since":
        "since=2026-08-10T00:00:00Z&until=2026-08-09T00:00:00Z",
      "malformed cursor": "cursor=garbage",
    };

    for (const [name, qs] of Object.entries(cases)) {
      it(`rejects ${name}`, async () => {
        const res = await query(qs);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toHaveProperty("error");
      });
    }
  });

  it("returns an empty result for a range with no data", async () => {
    const res = await query(
      "since=2020-01-01T00:00:00Z&until=2020-01-02T00:00:00Z",
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toEqual([]);
    expect(res.json().next_cursor).toBeNull();
  });
});