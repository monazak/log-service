import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, testService, type Harness } from "./helpers.ts";

let h: Harness;
const SERVICE = testService("agg");

interface Bucket {
  start: string;
  group: string | null;
  count: number;
}

beforeAll(async () => {
  h = await createHarness();

  // Recent data, queried through a recent range: this routes to the raw table
  // deterministically. Rollup coverage depends on refresh timing relative to
  // the write, so asserting exact totals against it would be a race.
  const base = Date.now() - 60_000;
  const logs = Array.from({ length: 60 }, (_, i) => ({
    timestamp: new Date(base + i * 500).toISOString(),
    level: i % 4 === 0 ? "error" : "info",
    service: SERVICE,
    message: `aggregate test ${i}`,
    attributes: { region: i % 2 === 0 ? "eu-west" : "us-east" },
  }));

  await h.app.inject({ method: "POST", url: "/logs", payload: { logs } });
});

afterAll(async () => {
  if (h !== undefined) {
    await h.cleanup();
  }
});

/** Inside RECENT_WINDOW_MS, so aggregation reads the raw table. */
function range(): string {
  const until = new Date(Date.now() + 60_000).toISOString();
  const since = new Date(Date.now() - 90_000).toISOString();
  return `since=${since}&until=${until}`;
}

function aggregate(extra: string) {
  return h.app.inject({
    method: "GET",
    url: `/logs/aggregate?${range()}&service=${SERVICE}&${extra}`,
  });
}

describe("GET /logs/aggregate", () => {
  it("returns buckets in ascending start order", async () => {
    const res = await aggregate("bucket=1m");
    expect(res.statusCode).toBe(200);

    const buckets = (res.json() as { buckets: Bucket[] }).buckets;
    expect(buckets.length).toBeGreaterThan(0);

    const starts = buckets.map((b) => new Date(b.start).getTime());
    const sorted = [...starts].sort((a, b) => a - b);
    expect(starts).toEqual(sorted);
  });

  it("sets group to null when group_by is absent", async () => {
    const res = await aggregate("bucket=1h");
    const buckets = (res.json() as { buckets: Bucket[] }).buckets;
    expect(buckets.every((b) => b.group === null)).toBe(true);
  });

  it("totals to the number of ingested rows", async () => {
    const res = await aggregate("bucket=1h");
    const buckets = (res.json() as { buckets: Bucket[] }).buckets;
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(60);
  });

  // The total must not change with bucket size — a partitioning that loses or
  // duplicates rows is the worst failure an aggregation endpoint can have.
  for (const size of ["1m", "5m", "1h", "1d"]) {
    it(`supports bucket=${size}`, async () => {
      const res = await aggregate(`bucket=${size}`);
      expect(res.statusCode).toBe(200);

      const buckets = (res.json() as { buckets: Bucket[] }).buckets;
      const total = buckets.reduce((sum, b) => sum + b.count, 0);
      expect(total).toBe(60);
    });
  }

  it("aligns 5m buckets to five-minute boundaries", async () => {
    const res = await aggregate("bucket=5m");
    const buckets = (res.json() as { buckets: Bucket[] }).buckets;

    for (const b of buckets) {
      const d = new Date(b.start);
      expect(d.getUTCMinutes() % 5).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
    }
  });

  it("groups by level", async () => {
    const res = await aggregate("bucket=1d&group_by=level");
    const buckets = (res.json() as { buckets: Bucket[] }).buckets;

    const groups = new Set(buckets.map((b) => b.group));
    expect(groups.has("error")).toBe(true);
    expect(groups.has("info")).toBe(true);

    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(60);
  });

  it("falls back to the raw table for attribute filters", async () => {
    const res = await aggregate("bucket=1d&attr.region=eu-west");
    expect(res.statusCode).toBe(200);

    const buckets = (res.json() as { buckets: Bucket[] }).buckets;
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(30);
  });

  it("falls back to the raw table for message search", async () => {
    const res = await aggregate("bucket=1d&q=aggregate test 1");
    expect(res.statusCode).toBe(200);
  });

  it("routes older ranges through the rollup transparently", async () => {
    const until = new Date().toISOString();
    const since = new Date(Date.now() - 60 * 60_000).toISOString();

    const res = await h.app.inject({
      method: "GET",
      url: `/logs/aggregate?since=${since}&until=${until}&service=${SERVICE}&bucket=1h`,
    });

    // The rollup lags by design, so its coverage of just-written rows is
    // timing-dependent and totals cannot be asserted here. What must hold is
    // that the query succeeds with an unchanged response shape: routing is
    // invisible to callers.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("buckets");
  });

  describe("required parameters", () => {
    const until = new Date().toISOString();
    const since = new Date(Date.now() - 3600_000).toISOString();

    const cases: Record<string, string> = {
      "missing since": `until=${until}&bucket=1h`,
      "missing until": `since=${since}&bucket=1h`,
      "missing bucket": `since=${since}&until=${until}`,
      "unsupported bucket": `since=${since}&until=${until}&bucket=2h`,
      "unsupported group_by": `since=${since}&until=${until}&bucket=1h&group_by=banana`,
    };

    for (const [name, qs] of Object.entries(cases)) {
      it(`rejects ${name}`, async () => {
        const res = await h.app.inject({
          method: "GET",
          url: `/logs/aggregate?${qs}`,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toHaveProperty("error");
      });
    }
  });
});