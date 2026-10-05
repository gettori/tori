import { describe, it, expect } from "vite-plus/test";
import { forgeChip } from "./forgeChip";
import { pullsPanelState, type DirectRead, type PullsPanelState } from "./pullsPanelState";
import type { BranchSync } from "./gitActions";
import type { PauseReason } from "./forgePoll";
import type { PullRequest, UnitStatus } from "./forgeTypes";
import type { KnownHosts } from "./prUrl";

// The panel is scoped to one branch, so nearly all of it is the absence of a
// pull request. Two things it has to get right that a working-looking panel
// would not show:
//
//   1. **Every kind says which one it is.** Ten ways of having nothing to draw,
//      each with a different next action. Two of them sharing a sentence is the
//      failure nobody reports, because the panel looks fine in both.
//   2. **A unit the poll never covered still resolves.** The per-tick cap can
//      leave a branch in `unknown` forever, and a panel that waited on the poll
//      would spin against a pull request the API answers for at once.

const GH = "git@github.com:skarif2/tori.git";
const HOSTS: KnownHosts = new Map([
  ["github.com", { provider: "github", baseUrl: "https://github.com" }],
]);

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 412,
  title: "Let a pull request be read in place",
  body: null,
  state: "open",
  isDraft: false,
  createdAt: "2026-09-17T08:14:00Z",
  mergedAt: null,
  closedAt: null,
  comments: 0,
  author: "skarif2",
  headRef: "wave-3",
  baseRef: "main",
  headSha: "abc123",
  headRepoIsOrigin: true,
  url: "https://github.com/skarif2/tori/pull/412",
  mergeableState: "clean",
  ...over,
});

const status = (over: Partial<UnitStatus> = {}): UnitStatus => ({
  headRef: "wave-3",
  pullRequest: pull(),
  checks: { state: "none", total: 0, failing: 0, contexts: [] },
  reviewDecision: "none",
  ...over,
});

const sync = (over: Partial<BranchSync> = {}): BranchSync => ({
  detached: false,
  dirty: false,
  head_committed_at: 0,
  upstream: { ahead: 0, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false },
  base: { name: "main", ahead: 12, behind: 0, conflicts: [] },
  ...over,
});

type Input = Parameters<typeof pullsPanelState>[0];

/// One panel state, built the way the panel builds it: the chip first, from the
/// same inputs the sidebar uses, then everything the panel knows on top.
function state(over: Partial<Input> & { chipOver?: Partial<Parameters<typeof forgeChip>[0]> } = {}) {
  const { chipOver, ...rest } = over;
  const unit = rest.status === undefined ? status() : rest.status;
  return pullsPanelState({
    chip: forgeChip({
      origin: GH,
      hosts: HOSTS,
      branch: "wave-3",
      paused: null,
      status: unit,
      ...chipOver,
    }),
    status: unit,
    paused: null,
    door: null,
    origin: GH,
    branch: "wave-3",
    base: "main",
    sync: sync(),
    direct: { kind: "idle" },
    viewing: null,
    ...rest,
  });
}

const noPrStatus = status({ pullRequest: null });
const PAUSES: PauseReason[] = ["disabled", "signedOut", "suspect", "pickAccount"];

/// Every state the panel can be in, each built from the facts that produce it.
/// Keyed by the name a failure should print, which is the kind plus the pause
/// reason where one kind covers four.
const EVERY: Record<string, PullsPanelState> = {
  ...Object.fromEntries(
    PAUSES.map((why) => [`paused:${why}`, state({ paused: why, chipOver: { paused: why } })]),
  ),
  noBranch: state({ branch: null, chipOver: { branch: null } }),
  noRemote: state({ origin: null, chipOver: { origin: null } }),
  inert: state({
    origin: "git@bitbucket.org:skarif2/tori.git",
    chipOver: { origin: "git@bitbucket.org:skarif2/tori.git" },
  }),
  onBase: state({
    branch: "main",
    status: noPrStatus,
    chipOver: { branch: "main", status: noPrStatus },
  }),
  noPrUnpushed: state({
    status: noPrStatus,
    chipOver: { status: noPrStatus },
    sync: sync({ upstream: { ahead: 0, behind: 0, has_upstream: false, gone: false, rewritten: false, superseded: false } }),
  }),
  noPrPushed: state({ status: noPrStatus, chipOver: { status: noPrStatus } }),
  error: state({
    status: null,
    chipOver: { status: null },
    direct: { kind: "error", message: "the GitHub rate limit is spent" },
  }),
  loading: state({ status: null, chipOver: { status: null }, direct: { kind: "loading" } }),
  loaded: state(),
};

/// The two lines a state puts on screen. `loaded` has none: it draws the pull
/// request itself, so asking it for a sentence is a test that meant a different
/// state.
const say = (s: PullsPanelState) => {
  if (s.kind === "loaded") throw new Error("loaded draws a pull request, not a sentence");
  return s;
};

describe("what the pull requests panel is showing", () => {
  it("reaches every kind it declares", () => {
    // The table below only proves the sentences differ. This proves it covers
    // the union: a kind added and never reached here would pass every other
    // test in the file.
    const reached = new Set(Object.values(EVERY).map((s) => s.kind));
    expect([...reached].sort()).toEqual(
      [
        "error",
        "inert",
        "loaded",
        "loading",
        "noBranch",
        "noPrPushed",
        "noPrUnpushed",
        "noRemote",
        "onBase",
        "paused",
      ].sort(),
    );
  });

  it("gives every kind its own sentence, and no two the same", () => {
    // Each of these renders no pull request, and each wants a different next
    // action: sign in, sign in again, pick an account, turn it back on, push,
    // open one, or check out a branch that has one. A panel that draws the same
    // blank for two of them is the one bug the user cannot report.
    const said = new Map<string, string>();
    for (const [name, s] of Object.entries(EVERY)) {
      if (s.kind === "loaded") continue;
      expect(s.headline, `${name} says nothing`).toBeTruthy();
      const both = `${s.headline}\n${s.detail}`;
      expect(said.get(both), `${name} and ${said.get(both)} share a sentence`).toBeUndefined();
      said.set(both, name);
    }
    expect(said.size).toBe(Object.keys(EVERY).length - 1);
  });

  it("names the branch, the counts and the remote in the sentence that needs them", () => {
    // The headline alone is a category. What makes it actionable is the fact in
    // it, and a fact left out is a sentence that reads true for any repo.
    expect(say(EVERY.onBase).headline).toContain("main");
    expect(say(EVERY.noPrUnpushed).detail).toContain("wave-3");
    expect(say(EVERY.noPrUnpushed).detail).toContain("12 commits");
    expect(say(EVERY.noPrPushed).detail).toContain("12 commits");
    expect(say(EVERY.noPrPushed).detail).toContain("main");
    expect(say(EVERY.error).detail).toBe("the GitHub rate limit is spent");
  });
});

describe("a branch no poll tick has reached", () => {
  const uncovered = (direct: DirectRead) =>
    state({ status: null, chipOver: { status: null }, direct });

  it("resolves through the direct read rather than loading forever", () => {
    // The poll has a per-tick cap, and a unit past it sits in `unknown` until
    // some later tick happens to include it. `forge_pr_for_branch` answers for
    // one branch on demand, which is the whole reason the panel asks it.
    expect(uncovered({ kind: "loading" }).kind).toBe("loading");
    const found = uncovered({ kind: "done", pr: pull({ number: 77 }) });
    expect(found).toMatchObject({ kind: "loaded", number: 77 });
    expect(uncovered({ kind: "done", pr: null }).kind).toBe("noPrPushed");
  });

  it("keeps the poll's answer ahead of the direct read's", () => {
    // Two sources for one question is how a panel and the chip above it end up
    // disagreeing. The poll is the one every chip on screen already reads.
    const both = state({ direct: { kind: "done", pr: pull({ number: 77 }) } });
    expect(both).toMatchObject({ kind: "loaded", number: 412 });
  });

  it("does not turn a failed direct read into an error over an answered branch", () => {
    // The poll already said there is no pull request. A whole error surface for
    // the second opinion failing would replace an answer with a complaint.
    const answered = state({
      status: noPrStatus,
      chipOver: { status: noPrStatus },
      direct: { kind: "error", message: "the GitHub rate limit is spent" },
    });
    expect(answered.kind).toBe("noPrPushed");
  });
});

describe("what outranks what", () => {
  it("puts the pause ahead of every pull request it could otherwise draw", () => {
    // The poller is stopped, so the newest thing any store holds is whatever
    // was true before it stopped. Rendering it puts a stale verdict under
    // controls that cannot act on it.
    const paused = state({ paused: "suspect", chipOver: { paused: "suspect" } });
    expect(paused).toMatchObject({ kind: "paused", why: "suspect" });
  });

  it("shows the pull request the list tab picked instead of the branch's own", () => {
    const picked = state({ viewing: { number: 77, pr: pull({ number: 77 }) } });
    expect(picked).toMatchObject({ kind: "loaded", number: 77, viewing: true });
  });

  it("waits rather than claiming nothing when the pick has not been handed over", () => {
    // There is no read by number anywhere in the app, so a picked number with
    // no `PullRequest` behind it cannot be resolved: the honest answer is that
    // it is still opening, never that this branch has no pull request.
    const picked = state({ viewing: { number: 77, pr: null } });
    expect(picked.kind).toBe("loading");
  });

  it("reads a remote the API cannot serve as that, not as a branch with no PR", () => {
    // Both are an absence on screen, and only one of them is ever going to
    // change: a Bitbucket checkout can never grow a pull request Tori reads.
    expect(EVERY.inert).toMatchObject({ kind: "inert", origin: "git@bitbucket.org:skarif2/tori.git" });
  });

  it("tells a detached HEAD from a repo with no origin", () => {
    // `forgeChip` collapses both into `inert`, which is right for a 16px glyph
    // and wrong for a panel: one is fixed by checking out a branch and the
    // other by adding a remote.
    expect(EVERY.noBranch.kind).toBe("noBranch");
    expect(EVERY.noRemote.kind).toBe("noRemote");
  });
});

describe("a finished pull request", () => {
  const merged = status({ pullRequest: pull({ state: "merged", mergedAt: "2026-09-20T00:00:00Z" }) });
  const closed = status({ pullRequest: pull({ state: "closed", closedAt: "2026-09-20T00:00:00Z" }) });

  it("loads merged and closed pull requests the way it loads an open one", () => {
    const m = state({ status: merged });
    expect(m.kind === "loaded" && m.pr.state).toBe("merged");
    const c = state({ status: closed });
    expect(c.kind === "loaded" && c.pr.state).toBe("closed");
  });

  it("agrees with the row when the branch name was reused", () => {
    const reused = { relation: { kind: "unrelated" } as const };
    expect(state({ status: merged, chipOver: reused }).kind).not.toBe("loaded");
    expect(state({ status: merged, chipOver: { relation: { kind: "at" } } }).kind).toBe("loaded");
  });
});
