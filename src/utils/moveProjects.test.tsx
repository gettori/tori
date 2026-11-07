import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    cmd === "move_into_space"
      ? Promise.resolve({ moves: [{ from: "/loose/app", to: "/P/work/app", done: true }] })
      : Promise.resolve(null),
}));

const { moveBlockers, moveProjects } = await import("./moveProjects");
const { publishDirtyPaths } = await import("./unsavedPaths");

describe("moveProjects", () => {
  beforeEach(() => {
    localStorage.clear();
    publishDirtyPaths([]);
  });

  it("moves the editor's tabs to the folder's new path", async () => {
    localStorage.setItem(
      "tori.editor.tabs.v1",
      JSON.stringify({ "/loose/app": { tabs: [{ path: "/loose/app/src/a.ts" }] } }),
    );
    await moveProjects("/P", [{ space: "work", name: "app", path: "/loose/app" }]);
    expect(JSON.parse(localStorage.getItem("tori.editor.tabs.v1")!)).toEqual({
      "/P/work/app": { tabs: [{ path: "/P/work/app/src/a.ts" }] },
    });
  });

  it("names a running tab and an unsaved file as blockers", () => {
    publishDirtyPaths(["/loose/app/src/a.ts", "/elsewhere/b.ts"]);
    expect(moveBlockers(1, ["/loose/app"])).toEqual([
      "1 terminal or agent tab is running in this folder. Close it first.",
      "1 file has unsaved changes. Save or discard it first.",
    ]);
    publishDirtyPaths([]);
    expect(moveBlockers(0, ["/loose/app"])).toEqual([]);
  });
});
