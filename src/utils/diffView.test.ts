import { describe, it, expect } from "vitest";
import { buildRows, hunkGaps, pairRun, toSideBySide, wordSegs, similarity } from "./diffView";

const changed = (segs: { text: string; changed: boolean }[] | undefined) =>
  (segs ?? []).filter((s) => s.changed).map((s) => s.text);

describe("wordSegs", () => {
  it("marks only the token that changed", () => {
    const segs = wordSegs("-const a = oldName;", "+const a = newName;");
    expect(changed(segs?.del)).toEqual(["oldName"]);
    expect(changed(segs?.add)).toEqual(["newName"]);
  });

  it("never highlights the +/- marker", () => {
    const segs = wordSegs("-let x = 1;", "+let x = 2;");
    expect(segs?.del[0]).toEqual({ text: "-", changed: false });
    expect(segs?.add[0]).toEqual({ text: "+", changed: false });
  });

  it("handles a pure insertion inside a line", () => {
    const segs = wordSegs("-call(a, c)", "+call(a, b, c)");
    expect(changed(segs?.del)).toEqual([]);
    expect(changed(segs?.add).join("")).toContain("b");
  });

  it("gives up on lines that share nothing", () => {
    expect(wordSegs("-alpha beta", "+gamma delta")).toBeNull();
  });

  it("gives up on a very long line rather than tokenizing it", () => {
    const long = "x".repeat(3000);
    expect(wordSegs(`-${long}a`, `+${long}b`)).toBeNull();
  });
});

describe("pairRun", () => {
  it("pairs an equal-length run positionally", () => {
    expect(pairRun(["-a", "-b"], ["+a1", "+b1"])).toEqual([0, 1]);
  });

  it("pairs only confident matches in an unbalanced run", () => {
    // 3 removals, 5 additions: two removals have a clear counterpart, one does
    // not, and the unmatched one must stay plain rather than be forced.
    const dels = ["-const alpha = 1;", "-const beta = 2;", "-totally unrelated"];
    const adds = ["+const alpha = 10;", "+brand new line", "+const beta = 20;", "+another new", "+and more"];
    const matches = pairRun(dels, adds);
    expect(matches[0]).toBe(0);
    expect(matches[1]).toBe(2);
    expect(matches[2]).toBe(-1);
  });

  it("never assigns one addition to two removals", () => {
    const matches = pairRun(["-value = 1", "-value = 1"], ["+value = 2", "+x", "+y"]);
    const used = matches.filter((m) => m >= 0);
    expect(new Set(used).size).toBe(used.length);
  });

  it("skips similarity pairing on a huge run", () => {
    const dels = Array.from({ length: 60 }, (_, i) => `-line ${i}`);
    const adds = Array.from({ length: 61 }, (_, i) => `+line ${i}`);
    expect(pairRun(dels, adds).every((m) => m === -1)).toBe(true);
  });
});

describe("similarity", () => {
  it("scores identical lines 1 and unrelated lines low", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("alpha beta", "gamma delta")).toBeLessThan(0.3);
  });
});

describe("buildRows", () => {
  it("pairs a single-token change and leaves context plain", () => {
    const rows = buildRows([" keep", "-let x = 1;", "+let x = 2;", " tail"]);
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    expect(changed(del && "segs" in del ? del.segs : undefined)).toEqual(["1"]);
    expect(changed(add && "segs" in add ? add.segs : undefined)).toEqual(["2"]);
    expect(rows.filter((r) => r.kind === "context")).toHaveLength(2);
  });

  it("leaves unpaired lines of an unbalanced hunk without segments", () => {
    const rows = buildRows([
      "-const alpha = 1;",
      "-totally unrelated",
      "+const alpha = 10;",
      "+brand new line",
      "+another new",
    ]);
    const withSegs = rows.filter((r) => (r.kind === "del" || r.kind === "add") && r.segs);
    // Only the alpha pair earns highlights; the rest render plain.
    expect(withSegs).toHaveLength(2);
  });

  it("treats a no-newline marker as meta, not a removal", () => {
    const rows = buildRows(["-a", "+b", "\\ No newline at end of file"]);
    expect(rows[rows.length - 1].kind).toBe("meta");
  });

  it("renders a large diff without a pairing blowup", () => {
    const lines: string[] = [];
    for (let i = 0; i < 2500; i++) {
      lines.push(`-line ${i} old`, `+line ${i} new`);
    }
    const started = Date.now();
    const rows = buildRows(lines);
    expect(rows).toHaveLength(5000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("hunkGaps", () => {
  const h = (startLine: number, endLine: number) => ({ startLine, endLine });

  it("reports the untouched stretch between two hunks", () => {
    // Hunk 1 covers 1-6, hunk 2 covers 40-45: lines 7-39 are simply absent
    // from the diff at default context.
    expect(hunkGaps([h(1, 6), h(40, 45)])).toEqual([{ afterHunk: 0, start: 7, end: 39 }]);
  });

  it("reports the stretch before the first hunk", () => {
    expect(hunkGaps([h(20, 25)])).toEqual([{ afterHunk: -1, start: 1, end: 19 }]);
  });

  it("reports nothing when a hunk starts at line 1", () => {
    expect(hunkGaps([h(1, 5)])).toEqual([]);
  });

  it("reports nothing between adjacent hunks", () => {
    expect(hunkGaps([h(1, 6), h(7, 9)])).toEqual([]);
  });

  it("never reports a gap after the last hunk", () => {
    // The diff does not say how long the file is, so a trailing count would be
    // a guess. Nothing is claimed rather than something wrong.
    const gaps = hunkGaps([h(1, 6), h(40, 45)]);
    expect(gaps.every((g) => g.afterHunk < 1)).toBe(true);
  });

  it("handles a pure deletion that does not advance the new side", () => {
    // A deletion hunk has endLine == startLine with nothing on the new side, so
    // the next hunk can start at or before it; that must not yield a backwards
    // or zero-length range.
    // Only the between-hunk gaps matter here (a first hunk at line 10 still
    // has a legitimate leading gap of 1-9).
    const between = (hs: { startLine: number; endLine: number }[]) => hunkGaps(hs).filter((g) => g.afterHunk >= 0);
    expect(between([h(10, 10), h(10, 12)])).toEqual([]);
    expect(between([h(10, 10), h(11, 12)])).toEqual([]);
    expect(between([h(10, 10), h(20, 22)])).toEqual([{ afterHunk: 0, start: 11, end: 19 }]);
  });

  it("chains several gaps across many hunks", () => {
    expect(hunkGaps([h(5, 8), h(20, 22), h(50, 51)])).toEqual([
      { afterHunk: -1, start: 1, end: 4 },
      { afterHunk: 0, start: 9, end: 19 },
      { afterHunk: 1, start: 23, end: 49 },
    ]);
  });
});

describe("toSideBySide", () => {
  it("puts a matched pair on one row and spans context across both", () => {
    const rows = buildRows([" keep", "-let x = 1;", "+let x = 2;"]);
    const sides = toSideBySide(rows);
    expect(sides[0].left).toBe(sides[0].right);
    expect(sides[1].left?.kind).toBe("del");
    expect(sides[1].right?.kind).toBe("add");
    expect(sides).toHaveLength(2);
  });

  it("gives an unpaired removal an empty right cell", () => {
    const sides = toSideBySide([{ kind: "del", text: "-gone" }]);
    expect(sides[0].left?.kind).toBe("del");
    expect(sides[0].right).toBeNull();
  });

  it("gives an unpaired addition an empty left cell", () => {
    const sides = toSideBySide([{ kind: "add", text: "+new" }]);
    expect(sides[0].left).toBeNull();
    expect(sides[0].right?.kind).toBe("add");
  });

  it("lays out a large diff without a quadratic scan", () => {
    const lines: string[] = [];
    for (let i = 0; i < 2500; i++) {
      lines.push(`-line ${i} old`, `+line ${i} new`);
    }
    const rows = buildRows(lines);
    const started = Date.now();
    const sides = toSideBySide(rows);
    // Each pair collapses onto one row.
    expect(sides).toHaveLength(2500);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("emits every row exactly once", () => {
    const rows = buildRows([" a", "-x1", "-x2", "+y1", "+y2", " b"]);
    const sides = toSideBySide(rows);
    const seen = sides.flatMap((s) => [s.left, s.right]).filter(Boolean);
    // Context rows appear in both cells, so count distinct row objects.
    expect(new Set(seen).size).toBe(rows.length);
  });
});
