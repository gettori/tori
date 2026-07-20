import { describe, it, expect } from "vitest";
import { buildRows, collapseRows, pairRun, toSideBySide, wordSegs, similarity, type DiffRow } from "./diffView";

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

describe("collapseRows", () => {
  const ctx = (n: number): DiffRow[] => Array.from({ length: n }, (_, i) => ({ kind: "context", text: ` c${i}` }));

  it("collapses a large untouched middle to one gap", () => {
    const rows: DiffRow[] = [{ kind: "del", text: "-a" }, ...ctx(20), { kind: "add", text: "+b" }];
    const out = collapseRows(rows, 3);
    const gaps = out.filter((r) => r.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind === "gap" && gaps[0].hidden).toHaveLength(14);
    // Three context lines survive on each side of the gap.
    expect(out.filter((r) => r.kind === "context")).toHaveLength(6);
  });

  it("leaves a short run alone", () => {
    const rows: DiffRow[] = [{ kind: "del", text: "-a" }, ...ctx(4), { kind: "add", text: "+b" }];
    expect(collapseRows(rows, 3).some((r) => r.kind === "gap")).toBe(false);
  });

  it("keeps context only on the inner side of an edge run", () => {
    const rows: DiffRow[] = [...ctx(20), { kind: "del", text: "-a" }];
    const out = collapseRows(rows, 3);
    expect(out[0].kind).toBe("gap");
    expect(out.filter((r) => r.kind === "context")).toHaveLength(3);
  });

  it("expanding a gap recovers every hidden line in order", () => {
    const rows: DiffRow[] = [{ kind: "del", text: "-a" }, ...ctx(20), { kind: "add", text: "+b" }];
    const gap = collapseRows(rows, 3).find((r) => r.kind === "gap");
    const hidden = gap?.kind === "gap" ? gap.hidden : [];
    expect(hidden.map((r) => ("text" in r ? r.text : ""))).toEqual(ctx(20).slice(3, 17).map((r) => ("text" in r ? r.text : "")));
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
