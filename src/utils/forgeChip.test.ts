import { describe, it, expect } from "vitest";
import { forgeChip } from "./forgeChip";
import type { CheckState, PullRequest, ReviewDecision, UnitStatus } from "./forgeTypes";
import type { KnownHosts } from "./prUrl";

const GH = "git@github.com:skarif2/tori.git";
const HOSTS: KnownHosts = new Map([["github.com", { provider: "github", baseUrl: "https://github.com" }]]);

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 12,
  title: "Let a branch wear its pull request",
  body: null,
  state: "open",
  isDraft: false,
  author: "skarif2",
  headRef: "wave-3",
  baseRef: "main",
  headSha: "abc123",
  url: "https://github.com/skarif2/tori/pull/12",
  mergeableState: "clean",
  ...over,
});

const status = (over: Partial<UnitStatus> = {}): UnitStatus => ({
  headRef: "wave-3",
  pullRequest: pull(),
  checks: { state: "none", total: 0, failing: 0 },
  reviewDecision: "none",
  ...over,
});

const chip = (over: Partial<Parameters<typeof forgeChip>[0]> = {}) =>
  forgeChip({ origin: GH, hosts: HOSTS, branch: "wave-3", firstUnit: true, paused: null, status: status(), ...over });

describe("the states that render nothing", () => {
  it("tells a remote it cannot serve apart from a branch with no PR yet", () => {
    // The whole point of the pair. Both are an absence on screen, but only one
    // of them is a place a later phase may hang a create control: a Bitbucket
    // checkout can never grow a pull request Tori can read, so a control there
    // is dead the day it ships
    // (`lesson_probe_the_capability_before_building_its_control`).
    expect(chip({ origin: "git@bitbucket.org:skarif2/tori.git" }).kind).toBe("inert");
    expect(chip({ origin: null }).kind).toBe("inert");
    expect(chip({ status: status({ pullRequest: null }) }).kind).toBe("noPr");
  });

  it("separates a branch waiting for a pull request from one that is not", () => {
    const noPr = status({ pullRequest: null });
    expect(chip({ status: noPr, offBase: 3, hasUpstream: true }).kind).toBe("readyForPr");

    // Nothing of its own to open one about, and nothing on the remote to open
    // one from: both are `noPr`, which draws the same quiet mark as today.
    expect(chip({ status: noPr, offBase: 0, hasUpstream: true }).kind).toBe("noPr");
    expect(chip({ status: noPr, offBase: 3, hasUpstream: false }).kind).toBe("noPr");
    // Not answered for yet. A row that claims "ready" on launch and takes it
    // back a second later is the shape of a bug, so silence comes first.
    expect(chip({ status: noPr }).kind).toBe("noPr");

    // The sync facts never outrank the forge's own answer.
    expect(chip({ offBase: 3, hasUpstream: true }).kind).toBe("pr");
    expect(chip({ origin: null, offBase: 3, hasUpstream: true }).kind).toBe("inert");
  });

  it("offers an account for a host with none, once per repo", () => {
    // Before one, a chip promising in-app PR state would be promising a call
    // that comes back `unsupportedRemote`, so the chip offers the account instead.
    const ghe = "https://github.acme.com/skarif2/tori.git";
    expect(chip({ origin: ghe }).connect?.title).toContain("github.acme.com");
    expect(chip({ origin: "git@git.corp.test:skarif2/tori.git" }).kind).toBe("connect");
    expect(chip({ origin: ghe, firstUnit: false }).kind).toBe("inert");
    expect(chip({ origin: ghe, paused: "disabled" }).kind).toBe("inert");
    const registered: KnownHosts = new Map([
      ["github.acme.com", { provider: "github", baseUrl: "https://github.acme.com" }],
    ]);
    expect(chip({ origin: ghe, hosts: registered }).kind).toBe("pr");
  });

  it("has nothing to say about a folder that is not a branch", () => {
    // A `plain-dir` unit. Asked before the origin is even consulted, because
    // the answer cannot change once the repo is probed.
    expect(chip({ branch: null, origin: undefined }).kind).toBe("inert");
    expect(chip({ branch: "" }).kind).toBe("inert");
  });

  it("waits for the origin probe rather than guessing inert", () => {
    // `undefined` is "not asked yet". Read as "no origin", every row in the
    // sidebar would flash inert on launch and silently correct itself, which
    // is indistinguishable from the bug where it does not correct itself.
    expect(chip({ origin: undefined }).kind).toBe("hidden");
  });

  it("stops claiming anything the moment polling stops", () => {
    // The statuses survive a sign-out in the store, so without this the chips
    // would sit there aging, describing a repo state nothing is refreshing.
    for (const paused of ["signedOut", "disabled", "suspect"] as const) {
      expect(chip({ paused }).kind).toBe("hidden");
    }
  });

  it("offers the account pick when the host has several and the repo chose none", () => {
    const c = chip({ paused: "pickAccount" });
    expect(c.kind).toBe("pickAccount");
    expect(c.pr).toBeNull();
  });

  it("says nothing at all about a unit no tick has covered", () => {
    // A unit past the per-tick cap. Rendering "no pull request" here is the
    // failure the `uncovered` count exists to prevent: a partial answer that
    // reads as a complete one.
    const c = chip({ status: null });
    expect(c.kind).toBe("unknown");
    expect(c.pr).toBeNull();
  });
});

describe("the pull request badge", () => {
  it("shows the number and tells draft from open", () => {
    expect(chip().pr).toEqual({
      state: "open",
      label: "#12",
      title: "Pull request · Let a branch wear its pull request",
    });
    expect(chip({ status: status({ pullRequest: pull({ isDraft: true }) }) }).pr?.state).toBe(
      "draft",
    );
  });

  it("keeps merged and closed apart from open", () => {
    // The poller only asks for open PRs today, so these arrive from the lookup
    // path. Folding them into "open" would show a green chip on a branch whose
    // PR is gone, which is worse than the extra two cases cost.
    expect(chip({ status: status({ pullRequest: pull({ state: "merged" }) }) }).pr?.state).toBe(
      "merged",
    );
    expect(chip({ status: status({ pullRequest: pull({ state: "closed" }) }) }).pr?.state).toBe(
      "closed",
    );
    expect(
      chip({ status: status({ pullRequest: pull({ state: "merged", isDraft: true }) }) }).pr?.state,
    ).toBe("merged");
  });
});

describe("the checks badge", () => {
  const withChecks = (state: CheckState, total: number, failing: number) =>
    chip({ status: status({ checks: { state, total, failing } }) }).checks;

  it("names how many checks are failing rather than that some are", () => {
    // "Checks failing" sends the user to GitHub to find out how bad it is.
    expect(withChecks("failure", 7, 2)).toEqual({ tone: "bad", title: "2 of 7 checks failing" });
  });

  it("separates a repo with no CI from a repo whose CI has not finished", () => {
    // Collapsing them makes every repo without a workflow look permanently in
    // flight, which is the one state a user would act on.
    expect(withChecks("none", 0, 0)).toBeNull();
    expect(withChecks("pending", 3, 0)).toEqual({ tone: "busy", title: "Checks running" });
  });

  it("counts a single check in the singular", () => {
    expect(withChecks("success", 1, 0)?.title).toBe("1 check passed");
    expect(withChecks("success", 4, 0)?.title).toBe("4 checks passed");
  });

  it("has nothing to report on a branch with no pull request", () => {
    const c = chip({ status: status({ pullRequest: null, checks: { state: "failure", total: 1, failing: 1 } }) });
    expect(c.checks).toBeNull();
    expect(c.review).toBeNull();
  });
});

describe("the review badge", () => {
  const withDecision = (d: ReviewDecision) => chip({ status: status({ reviewDecision: d }) }).review;

  it("shows the two verdicts and stays quiet about the resting states", () => {
    // `reviewRequired` is the resting state of every protected PR and `none` of
    // every unprotected one, so a badge for either is a badge on every row.
    expect(withDecision("changesRequested")).toEqual({ tone: "bad", title: "Changes requested" });
    expect(withDecision("approved")).toEqual({ tone: "good", title: "Approved" });
    expect(withDecision("reviewRequired")).toBeNull();
    expect(withDecision("none")).toBeNull();
  });
});
