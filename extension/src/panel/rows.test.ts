import { describe, expect, it } from "vite-plus/test";
import type { LogEntry } from "../pick";
import { BODY_CAP, rows, withDetail, type NetRequest } from "./rows";

const entry = (over: Partial<LogEntry>): LogEntry => ({
  seq: 1,
  at: 10_000,
  kind: "request",
  text: "POST /api/save -> 500",
  count: 1,
  reportable: true,
  ...over,
});

const request = (over: Partial<NetRequest>): NetRequest => ({
  id: 1,
  finishedAt: 10_100,
  what: "POST /api/save",
  status: 500,
  ...over,
});

describe("rows", () => {
  it("makes one row of a 500 the page log and DevTools both saw", () => {
    const merged = rows([entry({})], [request({})]);
    expect(merged).toHaveLength(1);
    expect(merged[0].fromPageLog).toBe(true);
    expect(merged[0].requests.map((r) => r.id)).toEqual([1]);
  });

  it("gives a repeat's later requests to the entry it collapsed into", () => {
    const merged = rows([entry({ count: 3 })], [request({ id: 1 }), request({ id: 2, finishedAt: 40_000 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].requests).toHaveLength(2);
  });

  it("keeps a request the page log never saw as its own row, newest first", () => {
    const merged = rows([entry({})], [request({ id: 2, finishedAt: 20_000, what: "GET /", status: 502 })]);
    expect(merged.map((r) => [r.key, r.fromPageLog])).toEqual([
      ["net-2", false],
      ["log-1", true],
    ]);
    expect(merged[0].entry.text).toBe("GET / -> 502");
  });

  it("does not match a request that finished well before the entry", () => {
    expect(rows([entry({})], [request({ finishedAt: 5_000 })])).toHaveLength(2);
  });
});

describe("withDetail", () => {
  it("adds the address and both bodies, capped", () => {
    const long = "x".repeat(BODY_CAP + 10);
    const sent = withDetail(entry({}), { url: "http://localhost:3000/api/save", request: '{"a":1}', response: long });
    expect(sent.text.split("\n")).toEqual([
      "POST /api/save -> 500",
      "url: http://localhost:3000/api/save",
      'request body: {"a":1}',
      `response body: ${"x".repeat(BODY_CAP)}...`,
    ]);
  });

  it("leaves the entry alone with no detail", () => {
    expect(withDetail(entry({}), null).text).toBe("POST /api/save -> 500");
  });
});
