// The contract this helper exists to hold: PURGE_UNDER_PATH goes out before the
// worktree does, and it goes out even when the removal then fails.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const bridge = vi.hoisted(() => ({
  steps: [] as string[],
  args: [] as Record<string, unknown>[],
  fail: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.steps.push(cmd);
    bridge.args.push(args);
    return bridge.fail ? Promise.reject(new Error("nope")) : Promise.resolve(null);
  },
}));

const { removeMemberWorktree } = await import("./memberWorktree");
const { PURGE_UNDER_PATH } = await import("./events");

const MEMBER = { repoPath: "/w/api", worktreePath: "/w/api/.tori/worktrees/auth" };

describe("removeMemberWorktree", () => {
  const purged: unknown[] = [];
  const onPurge = (e: Event) => {
    bridge.steps.push("purge");
    purged.push((e as CustomEvent).detail);
  };

  beforeEach(() => {
    bridge.steps = [];
    bridge.args = [];
    bridge.fail = false;
    purged.length = 0;
    window.addEventListener(PURGE_UNDER_PATH, onPurge);
  });
  afterEach(() => window.removeEventListener(PURGE_UNDER_PATH, onPurge));

  it("purges under the worktree before it invokes", async () => {
    await removeMemberWorktree(MEMBER, { branch: "feat/auth" });
    expect(bridge.steps).toEqual(["purge", "remove_worktree"]);
    expect(purged).toEqual([{ path: MEMBER.worktreePath }]);
    expect(bridge.args[0]).toEqual({
      repoPath: MEMBER.repoPath,
      worktreePath: MEMBER.worktreePath,
      force: true,
    });
  });

  it("deletes the branch too when asked", async () => {
    await removeMemberWorktree(MEMBER, { branch: "feat/auth", deleteBranch: true });
    expect(bridge.steps).toEqual(["purge", "remove_worktree_and_branch"]);
    expect(bridge.args[0]).toEqual({
      repoPath: MEMBER.repoPath,
      worktreePath: MEMBER.worktreePath,
      branch: "feat/auth",
      force: true,
    });
  });

  // A caller that ticks the box with nothing to delete must not lose the
  // worktree removal along with the branch it had no name for.
  it("falls back to the plain removal with no branch to delete", async () => {
    await removeMemberWorktree(MEMBER, { branch: null, deleteBranch: true });
    expect(bridge.steps).toEqual(["purge", "remove_worktree"]);
  });

  it("still sent the purge when the removal rejects", async () => {
    bridge.fail = true;
    await expect(removeMemberWorktree(MEMBER, {})).rejects.toThrow("nope");
    expect(bridge.steps).toEqual(["purge", "remove_worktree"]);
  });
});
