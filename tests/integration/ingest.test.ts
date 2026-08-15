import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, logEntry, testService, type Harness } from "./helpers.ts";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  if (h !== undefined) {
    await h.cleanup();
  }
});

async function post(payload: unknown) {
  return h.app.inject({
    method: "POST",
    url: "/logs",
    payload: payload as object,
  });
}

describe("POST /logs", () => {
  it("accepts a single valid entry", async () => {
    const res = await post({ logs: [logEntry()] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, rejected: [] });
  });

  it("reports the original array index of each rejection", async () => {
    const res = await post({
      logs: [
        logEntry(),
        logEntry({ level: "critical" }),
        logEntry(),
        logEntry({ timestamp: "not-a-date" }),
      ],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected[0].index).toBe(1);
    expect(body.rejected[1].index).toBe(3);
  });

  it("returns 400 when every entry is rejected, with reasons intact", async () => {
    const res = await post({ logs: [logEntry({ level: "critical" })] });
    expect(res.statusCode).toBe(400);
    expect(res.json().accepted).toBe(0);
    expect(res.json().rejected).toHaveLength(1);
  });

  describe("malformed requests", () => {
    it("rejects malformed JSON", async () => {
      const res = await h.app.inject({
        method: "POST",
        url: "/logs",
        headers: { "content-type": "application/json" },
        payload: '{"logs":[',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
    });

    it("rejects a bare array", async () => {
      const res = await post([logEntry()]);
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-array logs field", async () => {
      const res = await post({ logs: "hello" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an empty batch", async () => {
      const res = await post({ logs: [] });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a missing logs field", async () => {
      const res = await post({ entries: [] });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("edge cases", () => {
    it("stores a SQL injection attempt as literal text", async () => {
      const hostile = `${testService("x")}'); DROP TABLE logs; --`;
      const res = await post({ logs: [logEntry({ service: hostile })] });
      expect(res.statusCode).toBe(200);

      const { rows } = await h.pool.query(
        "SELECT count(*) AS n FROM logs WHERE service = $1",
        [hostile],
      );
      expect(Number(rows[0].n)).toBe(1);
    });

it("handles unicode and emoji in messages", async () => {
      const message = "تجاوز الحد ⚠️ 日本語 emoji 🎉";
      const res = await post({
        logs: [logEntry({ service: testService("unicode"), message })],
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects null bytes rather than failing the batch", async () => {
      const res = await post({
        logs: [
          logEntry({ service: testService("nul") }),
          logEntry({
            service: testService("nul"),
            message: "before\u0000after",
          }),
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(1);
      expect(body.rejected[0].index).toBe(1);
    });

    it("accepts a large batch", async () => {
      const logs = Array.from({ length: 2000 }, () =>
        logEntry({ service: testService("bulk") }),
      );
      const res = await post({ logs });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(2000);
    });

    it("accepts a message of substantial length", async () => {
      const res = await post({
        logs: [
          logEntry({
            service: testService("long"),
            message: "x".repeat(100_000),
          }),
        ],
      });
      expect(res.statusCode).toBe(200);
    });

    it("accepts many attributes on one entry", async () => {
      const attributes: Record<string, string> = {};
      for (let i = 0; i < 200; i += 1) {
        attributes[`key_${i}`] = `value_${i}`;
      }
      const res = await post({
        logs: [logEntry({ service: testService("attrs"), attributes })],
      });
      expect(res.statusCode).toBe(200);
    });

    it("routes rows to daily partitions, never the default partition", async () => {
      await post({ logs: [logEntry({ service: testService("partition") })] });
      const { rows } = await h.pool.query(
        "SELECT count(*) AS n FROM logs_default WHERE service LIKE 'itest-%'",
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});