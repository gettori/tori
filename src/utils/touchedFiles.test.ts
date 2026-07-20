import { describe, it, expect } from "vitest";
import { writtenPaths, setTouchedPaths, touchedPaths, isTouched, type TouchOp } from "./touchedFiles";

function f(path: string, op: TouchOp) {
  return { path, op };
}

describe("writtenPaths", () => {
  it("keeps creates, edits and deletes", () => {
    const paths = writtenPaths([f("/r/a.ts", "create"), f("/r/b.ts", "edit"), f("/r/c.ts", "delete")]);
    expect([...paths].sort()).toEqual(["/r/a.ts", "/r/b.ts", "/r/c.ts"]);
  });

  it("drops read-only touches, so browsing does not mark the tree", () => {
    const paths = writtenPaths([f("/r/looked.ts", "read"), f("/r/wrote.ts", "edit")]);
    expect([...paths]).toEqual(["/r/wrote.ts"]);
  });

  it("is empty for a session that has only read", () => {
    expect(writtenPaths([f("/r/a.ts", "read"), f("/r/b.ts", "read")]).size).toBe(0);
  });

  it("is empty for a session with no touches at all", () => {
    expect(writtenPaths([]).size).toBe(0);
  });

  it("collapses a path touched more than once", () => {
    const paths = writtenPaths([f("/r/a.ts", "create"), f("/r/a.ts", "edit")]);
    expect(paths.size).toBe(1);
  });
});

describe("the shared touched set", () => {
  it("swaps wholesale, so a previous session leaves no residue", () => {
    setTouchedPaths(new Set(["/r/first.ts"]));
    expect(isTouched("/r/first.ts")).toBe(true);

    setTouchedPaths(new Set(["/r/second.ts"]));
    expect(isTouched("/r/first.ts")).toBe(false);
    expect(isTouched("/r/second.ts")).toBe(true);
  });

  it("clears to empty when no session is selected", () => {
    setTouchedPaths(new Set(["/r/a.ts"]));
    setTouchedPaths(new Set());
    expect(touchedPaths().size).toBe(0);
    expect(isTouched("/r/a.ts")).toBe(false);
  });
});
