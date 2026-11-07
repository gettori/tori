import { describe, it, expect } from "vite-plus/test";
import { createGroup, freeName, putInGroup, renameGroup, takeOut, ungroup, type BranchGroup } from "./groups";

const g = (name: string, ...branches: string[]): BranchGroup => ({ name, branches });

describe("group edits", () => {
  it("names a new group New group, then New group 2", () => {
    expect(freeName([])).toBe("New group");
    expect(freeName([g("New group", "a")])).toBe("New group 2");
  });

  it("takes a branch out of its old group when it joins another, and drops an emptied group", () => {
    const out = createGroup([g("A", "x"), g("B", "y", "z")], "C", ["x", "y"]);
    expect(out).toEqual([g("B", "z"), g("C", "x", "y")]);
    expect(putInGroup(out, "B", "x", 0)).toEqual([g("B", "x", "z"), g("C", "y")]);
    expect(takeOut([g("A", "x")], "x")).toEqual([]);
  });

  it("refuses a rename to an empty or taken name", () => {
    expect(renameGroup([g("A", "x"), g("B", "y")], "A", "B")).toBeNull();
    expect(renameGroup([g("A", "x")], "A", "  ")).toBeNull();
    expect(renameGroup([g("A", "x")], "A", " Billing ")).toEqual([g("Billing", "x")]);
    expect(ungroup([g("A", "x"), g("B", "y")], "A")).toEqual([g("B", "y")]);
  });
});
