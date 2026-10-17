import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(
      cmd === "run_list"
        ? [
            { kind: "run", worktree: "/p/feat", state: "running", code: null, log: "/l1" },
            { kind: "run", worktree: "/p/fix", state: "running", code: null, log: "/l2" },
          ]
        : null,
    ),
  ),
}));

import { noteRun, runAt, seedRuns } from "./runStore";

describe("runStore", () => {
  it("shows a seeded run before any event, and an event newer than the seed wins", async () => {
    noteRun({ kind: "run", worktree: "/p/fix", state: "stopping", code: null, log: "/l2" });
    await seedRuns();
    expect(runAt("/p/feat")?.state).toBe("running");
    expect(runAt("/p/fix")?.state).toBe("stopping");

    noteRun({ kind: "run", worktree: "/p/feat", state: "stopped", code: null, log: "/l1" });
    noteRun({ kind: "setup", worktree: "/p/fix", state: "done", code: 0, log: "/l3" });
    expect(runAt("/p/feat")).toBeNull();
    expect(runAt("/p/fix")?.state).toBe("stopping");
  });
});
