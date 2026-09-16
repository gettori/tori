import { describe, it, expect } from "vitest";
import { renameTabsUnder, repoint } from "./renameTabs";

// A rename is not a removal. The whole point of this module is that a tab
// survives it: same tab, same order, same unsaved work, new path.

const tab = (path: string) => ({ path });

describe("repoint", () => {
  it("rewrites the node itself and anything under it", () => {
    expect(repoint("/p/src", "/p/src", "/p/lib")).toBe("/p/lib");
    expect(repoint("/p/src/a.ts", "/p/src", "/p/lib")).toBe("/p/lib/a.ts");
    expect(repoint("/p/src/deep/b.ts", "/p/src", "/p/lib")).toBe("/p/lib/deep/b.ts");
  });

  it("leaves an unrelated path alone", () => {
    expect(repoint("/p/other.ts", "/p/src", "/p/lib")).toBeNull();
  });

  it("does not treat a sibling with a shared prefix as being under the rename", () => {
    // `/p/srcs` starts with `/p/src` as a string but is a different directory.
    // A naive startsWith would drag it along and corrupt its path.
    expect(repoint("/p/srcs/a.ts", "/p/src", "/p/lib")).toBeNull();
  });
});

describe("renameTabsUnder", () => {
  it("keeps the tab and its position, changing only the path", () => {
    const maps = {
      tabs: { w1: [tab("/p/a.ts"), tab("/p/src/b.ts"), tab("/p/z.ts")] },
      active: { w1: "/p/src/b.ts" },
    };
    const next = renameTabsUnder(maps, "/p/src/b.ts", "/p/src/c.ts");

    expect(next.tabs.w1.map((t) => t.path)).toEqual(["/p/a.ts", "/p/src/c.ts", "/p/z.ts"]);
    expect(next.active.w1).toBe("/p/src/c.ts");
    expect(next.moved).toEqual([{ from: "/p/src/b.ts", to: "/p/src/c.ts" }]);
  });

  it("carries every open file inside a renamed folder", () => {
    const maps = {
      tabs: { w1: [tab("/p/src/a.ts"), tab("/p/src/deep/b.ts"), tab("/p/keep.ts")] },
      active: { w1: "/p/src/deep/b.ts" },
    };
    const next = renameTabsUnder(maps, "/p/src", "/p/lib");

    expect(next.tabs.w1.map((t) => t.path)).toEqual(["/p/lib/a.ts", "/p/lib/deep/b.ts", "/p/keep.ts"]);
    expect(next.active.w1).toBe("/p/lib/deep/b.ts");
    expect(next.moved).toHaveLength(2);
  });

  it("rewrites tabs in workspaces that are not on screen", () => {
    // The same repo is open in two branch-units; a rename in one must not leave
    // the other addressing a path that no longer exists.
    const maps = {
      tabs: { w1: [tab("/p/src/a.ts")], w2: [tab("/p/src/a.ts")] },
      active: { w1: "/p/src/a.ts", w2: null },
    };
    const next = renameTabsUnder(maps, "/p/src/a.ts", "/p/src/b.ts");

    expect(next.tabs.w2.map((t) => t.path)).toEqual(["/p/src/b.ts"]);
    expect(next.active.w2).toBeNull();
  });

  it("preserves everything else on the tab, so unsaved work survives", () => {
    const maps = {
      tabs: { w1: [{ path: "/p/a.ts", text: "unsaved edits", dirty: true }] },
      active: { w1: "/p/a.ts" },
    };
    const next = renameTabsUnder(maps, "/p/a.ts", "/p/b.ts");

    expect(next.tabs.w1[0]).toEqual({ path: "/p/b.ts", text: "unsaved edits", dirty: true });
  });

  it("leaves synthetic tabs alone", () => {
    // A `tori://` id is not a filesystem path; prefix-rewriting one would make
    // an id that addresses nothing.
    const maps = {
      tabs: { w1: [tab("tori://commit-log//p/src"), tab("/p/src/a.ts")] },
      active: { w1: "tori://commit-log//p/src" },
    };
    const next = renameTabsUnder(maps, "/p/src", "/p/lib");

    expect(next.tabs.w1[0].path).toBe("tori://commit-log//p/src");
    expect(next.active.w1).toBe("tori://commit-log//p/src");
    expect(next.moved).toEqual([{ from: "/p/src/a.ts", to: "/p/lib/a.ts" }]);
  });

  it("returns the original maps untouched when nothing matched", () => {
    const maps = { tabs: { w1: [tab("/p/a.ts")] }, active: { w1: "/p/a.ts" } };
    const next = renameTabsUnder(maps, "/p/elsewhere", "/p/other");

    expect(next.moved).toEqual([]);
    // Same reference: a no-op rename must not churn the signal and remount tabs.
    expect(next.tabs).toBe(maps.tabs);
    expect(next.active).toBe(maps.active);
  });
});
