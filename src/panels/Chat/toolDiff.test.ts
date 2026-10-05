import { describe, it, expect } from "vite-plus/test";
import { diffCounts, lineDiff, patchHunks, toolDiffBody } from "./toolDiff";
import type { PatchHunk } from "../../utils/chatTypes";

const hunk = (over: Partial<PatchHunk> = {}): PatchHunk => ({
  oldStart: 12,
  oldLines: 3,
  newStart: 12,
  newLines: 4,
  lines: [" ctx", "-was", "+is", "+and", " ctx"],
  ...over,
});

describe("patchHunks", () => {
  // The whole reason the patch is carried rather than recomputed: these numbers
  // exist nowhere else.
  it("numbers each side of the change the way the file does", () => {
    const [h] = patchHunks([hunk()]);
    expect(h.rows).toEqual([
      { kind: "ctx", oldLine: 12, newLine: 12, text: "ctx" },
      { kind: "del", oldLine: 13, newLine: null, text: "was" },
      { kind: "add", oldLine: null, newLine: 13, text: "is" },
      { kind: "add", oldLine: null, newLine: 14, text: "and" },
      { kind: "ctx", oldLine: 14, newLine: 15, text: "ctx" },
    ]);
    expect(h.header).toBe("@@ -12,3 +12,4 @@");
  });

  // `structuredPatch` drops the marker on a blank context line rather than
  // sending a lone space, so a strict `slice(1)` would eat a real character.
  it("reads a blank context line as blank rather than eating a character", () => {
    const [h] = patchHunks([hunk({ lines: ["", "+x"] })]);
    expect(h.rows[0]).toEqual({ kind: "ctx", oldLine: 12, newLine: 12, text: "" });
  });

  it("keeps every hunk of a multi-hunk patch, in order", () => {
    const hunks = patchHunks([hunk(), hunk({ oldStart: 90, newStart: 91 })]);
    expect(hunks).toHaveLength(2);
    expect(hunks[1].rows[0].oldLine).toBe(90);
    expect(hunks[1].rows[0].newLine).toBe(91);
  });
});

describe("lineDiff", () => {
  it("marks only what changed, keeping the matching lines as context", () => {
    const rows = lineDiff("a\nb\nc", "a\nB\nc");
    expect(rows.map((r) => `${r.kind} ${r.text}`)).toEqual(["ctx a", "del b", "add B", "ctx c"]);
  });

  it("reads an insertion as added rather than as a rewrite of everything after it", () => {
    const rows = lineDiff("a\nb", "a\nnew\nb");
    expect(rows.map((r) => `${r.kind} ${r.text}`)).toEqual(["ctx a", "add new", "ctx b"]);
  });

  it("reads a creation as all added and a deletion as all removed", () => {
    expect(lineDiff("", "one\ntwo").every((r) => r.kind === "add")).toBe(true);
    expect(lineDiff("one\ntwo", "").every((r) => r.kind === "del")).toBe(true);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("says nothing changed when nothing did", () => {
    expect(lineDiff("a\nb", "a\nb").every((r) => r.kind === "ctx")).toBe(true);
  });

  // Nothing here can number a row: an `Edit` names a fragment and never says
  // where in the file it sits.
  it("numbers no row, because the arguments cannot say", () => {
    expect(lineDiff("a", "b").every((r) => r.oldLine === null && r.newLine === null)).toBe(true);
  });
});

describe("toolDiffBody", () => {
  it("prefers the measured patch, and says the rows are numbered", () => {
    const body = toolDiffBody([hunk()], { old_string: "was", new_string: "is" });
    expect(body?.computed).toBe(false);
    expect(body?.hunks[0].rows[0].oldLine).toBe(12);
  });

  it("falls back to the arguments where no patch arrived, and says so", () => {
    const body = toolDiffBody([], { old_string: "a\nb", new_string: "a\nB" });
    expect(body?.computed).toBe(true);
    expect(body?.hunks[0].rows.map((r) => r.kind)).toEqual(["ctx", "del", "add"]);
  });

  // A creating `Write` has an empty patch by definition: there is nothing to
  // diff against, and the content is the whole change.
  it("reads a write's content as the whole diff", () => {
    const body = toolDiffBody([], { content: "one\ntwo" });
    expect(body?.computed).toBe(true);
    expect(diffCounts(body!.hunks)).toEqual({ added: 2, removed: 0 });
  });

  it("has nothing to draw for a call that wrote nothing", () => {
    expect(toolDiffBody([], { command: "ls" })).toBeNull();
    expect(toolDiffBody([], null)).toBeNull();
    expect(toolDiffBody([], "a string")).toBeNull();
  });
});

describe("diffCounts", () => {
  it("counts what changed and ignores what did not", () => {
    expect(diffCounts(patchHunks([hunk()]))).toEqual({ added: 2, removed: 1 });
  });
});
