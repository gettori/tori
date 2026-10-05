import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
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

const { adoptSync, resyncRoot, rollupSync, syncFor, syncMarks, syncState, syncUnits } = await import("./branchSync");

const sync = (over: Partial<BranchSync> = {}): BranchSync => ({
  detached: false,
  dirty: false,
  head_committed_at: 1700000000,
  upstream: { ahead: 0, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false },
  base: null,
  ...over,
});

const upstream = (over: Partial<BranchSync["upstream"]>) =>
  sync({
    upstream: { ahead: 0, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false, ...over },
  });

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
    const rewritten = syncState(upstream({ ahead: 2, behind: 1, rewritten: true, superseded: false }));
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

  it("counts commits unique to the base as work to publish before the first push", () => {
    const state = syncState(
      sync({
        upstream: { ahead: 0, behind: 0, has_upstream: false, gone: false, rewritten: false, superseded: false },
        base: { name: "main", ahead: 3, behind: 0, conflicts: [] },
      }),
    );
    expect(state.level).toBe("unpushed");
    expect(state.label).toBe("↑3");
    expect(state.detail).toContain("3 commits to publish");
  });

  it("says a pruned upstream was deleted rather than never pushed", () => {
    const state = syncState(
      sync({
        upstream: { ahead: 0, behind: 0, has_upstream: false, gone: true, rewritten: false, superseded: false },
        base: { name: "main", ahead: 3, behind: 0, conflicts: [] },
      }),
    );
    expect(state.label).toBe("deleted");
    expect(state.detail).toContain("remote branch was deleted");
  });

  it("resolves the loudest level when several hold at once", () => {
    // Diverged from the upstream *and* behind a base that would conflict.
    const loud = sync({
      upstream: { ahead: 2, behind: 1, has_upstream: true, gone: false, rewritten: false, superseded: false },
      base: { name: "main", ahead: 2, behind: 5, conflicts: ["src/a.ts"] },
    });
    expect(syncState(loud).level).toBe("conflicts");

    // The same, with the merge clean: the divergence outranks the base.
    expect(syncState({ ...loud, base: { name: "main", ahead: 2, behind: 5, conflicts: [] } }).level).toBe("diverged");

    // Behind the upstream outranks being behind the base.
    const behindBoth = sync({
      upstream: { ahead: 0, behind: 1, has_upstream: true, gone: false, rewritten: false, superseded: false },
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
    expect(
      syncState(
        sync({
          detached: true,
          upstream: { ahead: 0, behind: 4, has_upstream: true, gone: false, rewritten: false, superseded: false },
        }),
      ).level,
    ).toBe("none");
    expect(syncState(null).level).toBe("none");
    expect(syncState(undefined).level).toBe("none");
  });
});

// The glyphs, for a surface with no room for words. `syncState` picks the one
// thing worth saying; this returns every fact, because a branch can owe two.

describe("the marks a row draws for its remote", () => {
  const kinds = (s: BranchSync | null) => syncMarks(s).map((m) => `${m.kind}${m.count ?? ""}`);

  it("draws a count per direction, and the conflict first", () => {
    expect(kinds(upstream({ behind: 3 }))).toEqual(["pull3"]);
    expect(kinds(upstream({ ahead: 2 }))).toEqual(["push2"]);
    expect(kinds(sync({ dirty: true }))).toEqual(["dirty"]);
    // Leading, so the one red glyph in a column keeps its place and never sits
    // against the forge's own marks at the row's other end.
    expect(
      kinds(
        sync({
          dirty: true,
          upstream: { ahead: 0, behind: 9, has_upstream: true, gone: false, rewritten: false, superseded: false },
          base: { name: "main", ahead: 1, behind: 2, conflicts: ["src/a.ts"] },
        }),
      ),
    ).toEqual(["conflict1", "pull9", "dirty"]);
  });

  it("spends colour on the two states that need a decision", () => {
    // Most branches in a sidebar are behind something, so an amber "behind"
    // would be a column of amber and would stop saying anything.
    expect(syncMarks(upstream({ behind: 400 }))[0].tone).toBe("muted");
    expect(syncMarks(sync({ dirty: true }))[0].tone).toBe("muted");
    // Diverged: both arrows, both amber, and no word needed for it.
    const diverged = syncMarks(upstream({ ahead: 2, behind: 3 }));
    expect(diverged.map((m) => m.tone)).toEqual(["warn", "warn"]);
    expect(syncMarks(base({ behind: 1, conflicts: ["src/a.ts"] }))[0].tone).toBe("danger");
  });

  it("marks a branch nobody has pushed with the push glyph and no number", () => {
    const never = syncMarks(upstream({ has_upstream: false }));
    expect(never.map((m) => `${m.kind}${m.count ?? ""}`)).toEqual(["push"]);
    expect(never[0].title).toContain("no upstream");
  });

  it("counts unpublished commits against the base before an upstream exists", () => {
    const never = syncMarks(
      sync({
        upstream: { ahead: 0, behind: 0, has_upstream: false, gone: false, rewritten: false, superseded: false },
        base: { name: "main", ahead: 3, behind: 0, conflicts: [] },
      }),
    );
    expect(never.map((m) => `${m.kind}${m.count ?? ""}`)).toEqual(["push3"]);
    expect(never[0].title).toBe("3 commits to publish");
  });

  it("marks a deleted upstream without counting commits to publish", () => {
    const gone = syncMarks(
      sync({
        upstream: { ahead: 0, behind: 0, has_upstream: false, gone: true, rewritten: false, superseded: false },
        base: { name: "main", ahead: 3, behind: 0, conflicts: [] },
      }),
    );
    expect(gone.map((m) => `${m.kind}${m.count ?? ""}`)).toEqual(["push"]);
    expect(gone[0].title).toContain("remote branch was deleted");
  });

  it("has nothing to push once the pull request merged, unless work came after", () => {
    const gone = sync({
      upstream: { ahead: 0, behind: 0, has_upstream: false, gone: true, rewritten: false, superseded: false },
      base: { name: "main", ahead: 3, behind: 0, conflicts: [] },
    });
    expect(syncMarks(gone, { state: "merged", relation: { kind: "at" } })).toEqual([]);
    expect(syncMarks(gone, { state: "merged", relation: { kind: "behind" } })).toEqual([]);

    const after = syncMarks(gone, { state: "merged", relation: { kind: "ahead", count: 2 } });
    expect(after.map((m) => `${m.kind}${m.count}:${m.tone}`)).toEqual(["push2:warn"]);
    expect(after[0].title).toBe("2 commits after merge");

    // A closed pull request keeps the push, which is how its branch comes back.
    expect(syncMarks(gone, { state: "closed", relation: { kind: "at" } })[0].title).toContain("was deleted");
  });

  it("puts the force-push warning in the tooltip, not on the row", () => {
    const rewritten = syncMarks(upstream({ ahead: 2, behind: 3, rewritten: true, superseded: false }));
    expect(rewritten.map((m) => m.kind)).toEqual(["push", "pull"]);
    expect(rewritten[rewritten.length - 1].title).toContain("force push");
  });

  it("draws nothing for a detached head or a branch nothing has answered for", () => {
    expect(syncMarks(null)).toEqual([]);
    expect(syncMarks(sync({ detached: true, dirty: true }))).toEqual([]);
    expect(syncMarks(sync())).toEqual([]);
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

// The Topic roll-up. Ordering is the whole of it: a Topic reports one thing, so
// which member's thing it is has to be settled the same way a row settles its
// own levels, or the Topic and the row under it disagree.

describe("what a Topic says for its members", () => {
  const at = (label: string, sync: BranchSync | null) => ({ label, sync });

  it("reports the loudest member and names it", () => {
    const rolled = rollupSync([
      at("api", upstream({ ahead: 3 })),
      at("web", base({ behind: 2, conflicts: ["src/a.ts"] })),
      at("cli", upstream({ behind: 1 })),
    ]);
    expect(rolled.state.level).toBe("conflicts");
    expect(rolled.state.tone).toBe("danger");
    expect(rolled.state.detail).toContain("web");
    expect(rolled.state.conflicts).toEqual(["src/a.ts"]);
  });

  it("names one member and counts the rest at its level", () => {
    const rolled = rollupSync([
      at("api", upstream({ behind: 1 })),
      at("web", upstream({ behind: 9 })),
      at("cli", upstream({ ahead: 2 })),
    ]);
    expect(rolled.state.level).toBe("behind");
    // The counts in a detail were measured on one branch, so only that branch
    // is named in front of them.
    expect(rolled.state.detail.startsWith("api: ")).toBe(true);
    expect(rolled.state.detail).toContain("1 commit on the upstream");
    expect(rolled.state.detail).toContain("And 1 other like it.");
    expect(rolled.state.label).toBe(syncState(upstream({ behind: 1 })).label);
  });

  it("counts only the members still at the level it settled on", () => {
    // Two quiet ones first, then the loud one: the tally the quiet pair built
    // up belongs to a level this no longer reports.
    const rolled = rollupSync([
      at("api", upstream({ behind: 1 })),
      at("web", upstream({ behind: 2 })),
      at("cli", base({ behind: 1, conflicts: ["src/a.ts"] })),
    ]);
    expect(rolled.state.level).toBe("conflicts");
    expect(rolled.state.detail.startsWith("cli: ")).toBe(true);
    expect(rolled.state.detail).not.toContain("other");
  });

  it("says nothing when no member has anything to say", () => {
    expect(rollupSync([]).state.level).toBe("none");
    expect(rollupSync([]).marks).toEqual([]);
    expect(rollupSync([at("api", null), at("web", sync())]).state.level).toBe("none");
  });

  it("does not roll up uncommitted work", () => {
    // Dirty never reaches a `SyncState`, so a Topic whose only news is that
    // somebody is mid-edit reports nothing. The marker stays on the member.
    const rolled = rollupSync([at("api", sync({ dirty: true })), at("web", sync({ dirty: true }))]);
    expect(rolled.state.level).toBe("none");
    expect(rolled.state.label).toBe("");
  });
});
