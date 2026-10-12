import { describe, it, expect } from "vite-plus/test";
import { AWAY_MS, cameBack, digestTime, finishedParts, worthOpening, type Digest, type Finished } from "./digest";

const HOUR = 60 * 60 * 1000;

const row: Finished = {
  session: "s",
  folder: "/p",
  branch: null,
  project: "p",
  title: "t",
  chat: true,
  turns: 3,
  firstTs: 0,
  lastTs: 0,
  lines: { added: 4, removed: 2 },
  verdict: "failed",
};

function digest(extra: Partial<Digest> = {}): Digest {
  return { since: 0, asOf: 1, ready: true, finished: [row], waiting: [], ...extra };
}

describe("the digest's open rule", () => {
  it("does not open before the first composition", () => {
    expect(worthOpening(digest({ ready: false }))).toBe(false);
  });

  it("does not open when empty", () => {
    expect(worthOpening(digest({ finished: [] }))).toBe(false);
    expect(worthOpening(null)).toBe(false);
  });

  it("opens with rows once ready", () => {
    expect(worthOpening(digest())).toBe(true);
  });

  it("counts four hours unfocused or idle as away, and three as not", () => {
    expect(cameBack(0, 3 * HOUR)).toBe(false);
    expect(cameBack(0, 5 * HOUR)).toBe(true);
    expect(cameBack(0, AWAY_MS)).toBe(true);
  });
});

describe("finishedParts", () => {
  it("names turns, lines, the verdict and when", () => {
    const now = new Date(2026, 9, 12, 9, 0).getTime();
    const parts = finishedParts({ ...row, lastTs: new Date(2026, 9, 12, 7, 42).getTime() }, now);
    expect(parts.slice(0, 3)).toEqual(["3 turns", "+4 -2", "Checks failed"]);
  });

  it("leaves out what a terminal session cannot say", () => {
    expect(finishedParts({ ...row, turns: 1, lines: null, verdict: null }).length).toBe(2);
  });
});

describe("digestTime", () => {
  it("says the weekday past yesterday", () => {
    const now = new Date(2026, 9, 12, 9, 0).getTime();
    expect(digestTime(new Date(2026, 9, 11, 22, 0).getTime(), now)).toMatch(/^Yesterday /);
    expect(digestTime(new Date(2026, 9, 9, 22, 0).getTime(), now)).toMatch(/^Fri /);
  });
});
