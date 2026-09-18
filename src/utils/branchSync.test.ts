import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BranchSync } from "./gitActions";

type Asked = { path: string; branch: string };

const batches: Asked[][] = [];
let reply: Record<string, BranchSync> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { units: Asked[] }) => {
    if (cmd !== "git_branch_sync_many") return Promise.resolve(null);
    batches.push(args.units);
    return Promise.resolve(reply);
  },
}));

const { adoptSync, resyncRoot, syncFor, syncState, syncUnits } = await import("./branchSync");

const sync = (over: Partial<BranchSync> = {}): BranchSync => ({
  detached: false,
  dirty: false,
  head_committed_at: 1700000000,
  upstream: { ahead: 0, behind: 0, has_upstream: true, rewritten: false },
  base: null,
  ...over,
});

const upstream = (over: Partial<BranchSync["upstream"]>) =>
  sync({ upstream: { ahead: 0, behind: 0, has_upstream: true, rewritten: false, ...over } });

const base = (over: Partial<NonNullable<BranchSync["base"]>>) =>
  sync({ base: { name: "main", ahead: 0, behind: 0, conflicts: [], ...over } });

describe("what a branch's sync facts are worth saying", () => {
  it("says nothing when the branch is level with everything", () => {
    expect(syncState(base({ behind: 0 })).level).toBe("none");
    expect(syncState(base({ behind: 0 })).label).toBe("");
  });

  it("names the base and the files a catch-up would fight over", () => {
    const state = syncState(base({ behind: 3, conflicts: ["src/a.ts", "src/b.ts"] }));
    expect(state.level).toBe("conflicts");
    expect(state.tone).toBe("danger");
    expect(state.label).toBe("main: 2 conflicts");
    expect(state.conflicts).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("sends a rewritten divergence to a force push and any other one to a pull", () => {
    const rewritten = syncState(upstream({ ahead: 2, behind: 1, rewritten: true }));
    expect(rewritten.level).toBe("diverged");
    expect(rewritten.tone).toBe("warn");
    expect(rewritten.detail).toMatch(/force push/);

    const theirs = syncState(upstream({ ahead: 2, behind: 1 }));
    expect(theirs.level).toBe("diverged");
    expect(theirs.detail).toMatch(/Pull before you push/);
    expect(theirs.detail).not.toMatch(/force/);
  });

  it("draws being behind as a down arrow and a count", () => {
    const state = syncState(upstream({ behind: 3 }));
    expect(state.level).toBe("behind");
    expect(state.tone).toBe("attention");
    expect(state.label).toBe("↓3");
  });

  it("draws a base that moved on as its name and a plus", () => {
    const state = syncState(base({ behind: 14 }));
    expect(state.level).toBe("baseBehind");
    expect(state.tone).toBe("muted");
    expect(state.label).toBe("main +14");
  });

  it("draws work to push as an up arrow and a count", () => {
    const state = syncState(upstream({ ahead: 2 }));
    expect(state.level).toBe("ahead");
    expect(state.tone).toBe("muted");
    expect(state.label).toBe("↑2");
  });

  it("calls a branch that tracks nothing unpushed", () => {
    const state = syncState(upstream({ has_upstream: false }));
    expect(state.level).toBe("unpushed");
    expect(state.tone).toBe("muted");
  });

  it("resolves the loudest level when several hold at once", () => {
    // Diverged from the upstream *and* behind a base that would conflict.
    const loud = sync({
      upstream: { ahead: 2, behind: 1, has_upstream: true, rewritten: false },
      base: { name: "main", ahead: 2, behind: 5, conflicts: ["src/a.ts"] },
    });
    expect(syncState(loud).level).toBe("conflicts");

    // The same, with the merge clean: the divergence outranks the base.
    expect(syncState({ ...loud, base: { name: "main", ahead: 2, behind: 5, conflicts: [] } }).level).toBe("diverged");

    // Behind the upstream outranks being behind the base.
    const behindBoth = sync({
      upstream: { ahead: 0, behind: 1, has_upstream: true, rewritten: false },
      base: { name: "main", ahead: 2, behind: 5, conflicts: [] },
    });
    expect(syncState(behindBoth).level).toBe("behind");
  });

  it("treats an unasked conflict check as a base that merely moved, never as a clean one", () => {
    // Git below 2.38, or a shallow clone: `null` is not an empty list.
    const state = syncState(base({ behind: 2, conflicts: null }));
    expect(state.level).toBe("baseBehind");
  });

  it("says nothing for a detached HEAD, or for a branch nothing has answered for", () => {
    expect(syncState(sync({ detached: true, upstream: { ahead: 0, behind: 4, has_upstream: true, rewritten: false } })).level).toBe("none");
    expect(syncState(null).level).toBe("none");
    expect(syncState(undefined).level).toBe("none");
  });
});

// The store around it. What is asserted here is *which rows are asked about*,
// because the answers are the backend's and the cost of getting this wrong is a
// `git` process per row on every config change.

const unit = (folderPath: string, branch: string | null, kind = "plain") => ({ folderPath, branch, kind });
const key = (path: string, branch: string) => `${path}\u0000${branch}`;
const paths = (batch: Asked[]) => batch.map((u) => `${u.path}:${u.branch}`).sort();

describe("the sync store's bookkeeping", () => {
  beforeEach(async () => {
    reply = {};
    await syncUnits([]);
    batches.length = 0;
  });

  it("asks about the rows that arrive, and never again about the ones already there", async () => {
    await syncUnits([unit("/a", "main"), unit("/a", "wip"), unit("/b", null, "worktree")]);
    expect(paths(batches[0])).toEqual(["/a:main", "/a:wip", "/b:"]);

    await syncUnits([unit("/a", "main"), unit("/a", "wip"), unit("/b", null, "worktree"), unit("/c", "feat")]);
    expect(batches.length).toBe(2);
    expect(paths(batches[1])).toEqual(["/c:feat"]);
  });

  it("leaves folders that are not repos out of the batch", async () => {
    await syncUnits([unit("/a", "main"), unit("/notes", null, "plain-dir"), unit("/stub", "x", "incomplete")]);
    expect(paths(batches[0])).toEqual(["/a:main"]);
  });

  it("refreshes only the rows on the folder that fetched", async () => {
    await syncUnits([unit("/a", "main"), unit("/a", "wip"), unit("/b", "main")]);
    batches.length = 0;

    await resyncRoot("/a");
    expect(paths(batches[0])).toEqual(["/a:main", "/a:wip"]);
    expect(batches.length).toBe(1);
  });

  it("keeps each row's own answer, under the backend's key", async () => {
    reply = { [key("/a", "main")]: base({ behind: 2 }), [key("/a", "wip")]: upstream({ ahead: 1 }) };
    await syncUnits([unit("/a", "main"), unit("/a", "wip")]);

    expect(syncState(syncFor("/a", "main")).level).toBe("baseBehind");
    expect(syncState(syncFor("/a", "wip")).level).toBe("ahead");
  });

  it("drops a row that left the tree, and one the backend stopped answering for", async () => {
    reply = { [key("/a", "main")]: base({ behind: 2 }), [key("/b", "main")]: base({ behind: 2 }) };
    await syncUnits([unit("/a", "main"), unit("/b", "main")]);

    await syncUnits([unit("/a", "main")]);
    expect(syncFor("/b", "main")).toBe(null);

    // The folder stopped being a repo: its old answer must go with it, not sit
    // there reading as current.
    reply = {};
    await resyncRoot("/a");
    expect(syncFor("/a", "main")).toBe(null);
  });

  it("takes the answer refreshMeta already paid for, and only for a drawn row", async () => {
    await syncUnits([unit("/a", "main")]);
    batches.length = 0;

    adoptSync("/a", "main", base({ behind: 5 }));
    expect(syncState(syncFor("/a", "main")).level).toBe("baseBehind");

    adoptSync("/gone", "main", base({ behind: 5 }));
    expect(syncFor("/gone", "main")).toBe(null);
    expect(batches.length).toBe(0);
  });
});
