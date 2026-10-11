import { describe, it, expect, beforeEach } from "vite-plus/test";
import { moveStoredWorkspaces } from "./moveWorkspace";

describe("moveStoredWorkspaces", () => {
  beforeEach(() => localStorage.clear());

  it("rewrites keys and paths in a store no live owner holds, the deepest move winning", () => {
    localStorage.setItem(
      "tori.editor.tabs.v1",
      JSON.stringify({
        "/w/repo": { tabs: [{ path: "/w/repo/src/a.ts" }, { path: "/w/repo/.tori/worktrees/t/b.ts" }] },
        "/w/other": { tabs: [{ path: "/w/repository/c.ts" }] },
      }),
    );

    moveStoredWorkspaces([
      { from: "/w/repo", to: "/w/repo/main" },
      { from: "/w/repo/.tori/worktrees/t", to: "/w/repo/t" },
    ]);

    expect(JSON.parse(localStorage.getItem("tori.editor.tabs.v1")!)).toEqual({
      "/w/repo/main": { tabs: [{ path: "/w/repo/main/src/a.ts" }, { path: "/w/repo/t/b.ts" }] },
      "/w/other": { tabs: [{ path: "/w/repository/c.ts" }] },
    });
  });
});
