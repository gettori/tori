// What a branch-unit's forge chip says, decided without a DOM.
//
// The sidebar renders many of these, one per branch row, so every rule about
// *whether* a chip appears lives here rather than in JSX conditionals: a row
// that draws "no pull request" when the truth is "this remote is not GitHub" is
// wrong in a way nobody reports, because both look like an absence.
//
// ## Seven kinds, and the two that matter
//
// The distinction the plan cares about is **inert vs noPr**. `noPr` means the
// forge answered and there is no PR yet, which is a normal, temporary state of a
// working branch and something a later phase can hang a control on. `inert`
// means the forge can never answer for this unit: no origin, an origin the API
// does not serve, or no branch at all. Collapsing the two would put a create
// affordance on a GitLab checkout, which is the exact shape
// `[[lesson_probe_the_capability_before_building_its_control]]` warns about.
//
// `hidden` and `unknown` both render nothing, and are separate on purpose:
// `hidden` is "the poller is not running, so anything drawn would be a claim
// about the past", `unknown` is "servable, but no tick has reached it yet". A
// unit past the per-tick cap sits in `unknown` forever if the cap never reaches
// it, and rendering nothing is what keeps that partial answer from reading as a
// complete one.

import { apiCanServe, connectHost } from "./createPr";
import type { PauseReason } from "./forgePoll";
import type { KnownHosts } from "./prUrl";
import type { CheckRollup, ReviewDecision, UnitStatus } from "./forgeTypes";

export type ForgeChipKind = "hidden" | "inert" | "unknown" | "noPr" | "pr" | "pickAccount" | "connect";

/// What the PR glyph depicts. `none` is the no-PR marker, which is a state of
/// the branch rather than of a pull request, hence a value here rather than a
/// null badge.
export type PrChipState = "open" | "draft" | "merged" | "closed" | "none";

export type BadgeTone = "good" | "bad" | "busy";

export type ForgeChip = {
  kind: ForgeChipKind;
  /** Null for every kind that renders nothing. */
  pr: { state: PrChipState; label: string; title: string } | null;
  checks: { tone: BadgeTone; title: string } | null;
  review: { tone: BadgeTone; title: string } | null;
  connect: { title: string } | null;
};

const NOTHING: ForgeChip = { kind: "hidden", pr: null, checks: null, review: null, connect: null };

/// The whole chip for one branch-unit.
///
/// `origin` is tri-state on purpose: `undefined` is "not probed yet" and
/// `null` is "probed, this repo has no origin". Reading the first as the second
/// would flash every row as inert on launch and then quietly correct itself,
/// which is indistinguishable from a bug the one time it is real.
export function forgeChip(input: {
  origin: string | null | undefined;
  hosts: KnownHosts;
  branch: string | null;
  firstUnit: boolean;
  paused: PauseReason | null;
  status: UnitStatus | null;
}): ForgeChip {
  // A `plain-dir` folder is not a branch and never will be, so this outranks
  // every other question, including whether the origin has been probed.
  if (!input.branch) return { ...NOTHING, kind: "inert" };
  if (input.origin === undefined) return NOTHING;
  if (!apiCanServe(input.origin, input.hosts)) {
    // One door per repo, not per branch: signed out, every row would carry one.
    const host = input.firstUnit && input.paused !== "disabled" ? connectHost(input.origin, input.hosts) : null;
    if (!host) return { ...NOTHING, kind: "inert" };
    return { ...NOTHING, kind: "connect", connect: { title: `Add an account for ${host} in Settings` } };
  }
  // Several accounts on the host and none picked for this repo: the pick is the
  // one thing worth drawing.
  if (input.paused === "pickAccount") return { ...NOTHING, kind: "pickAccount" };
  // Signed out, switched off, or a credential the forge rejected: the poller is
  // stopped, so the newest thing this store holds is whatever was true before it
  // stopped. Rendering it would age silently.
  if (input.paused !== null) return NOTHING;
  if (input.status === null) return { ...NOTHING, kind: "unknown" };

  const pr = input.status.pullRequest;
  if (pr === null) {
    return {
      kind: "noPr",
      pr: { state: "none", label: "", title: "No pull request for this branch" },
      checks: null,
      review: null,
      connect: null,
    };
  }
  const state: PrChipState = pr.state === "open" ? (pr.isDraft ? "draft" : "open") : pr.state;
  return {
    kind: "pr",
    pr: { state, label: `#${pr.number}`, title: `${prWord(state)} · ${pr.title}` },
    // Checks and the verdict hang off the PR rather than off the branch,
    // matching what the client returns: a branch with no PR reports `none` for
    // both, and a badge for "no checks" is a badge for nothing.
    checks: checksBadge(input.status.checks),
    review: reviewBadge(input.status.reviewDecision),
    connect: null,
  };
}

/// The checks and verdict badges alone, for a surface listing pull requests the
/// API just returned.
///
/// Every question `forgeChip` asks ahead of those two is already settled there:
/// an API that answered serves this repo, a listed PR exists, and a paused
/// poller could not have produced the list. What is left is the pair of badges,
/// with the PR glyph deliberately absent because the row beside them already
/// names the number.
export function forgeBadges(status: UnitStatus | null): ForgeChip {
  if (status === null || status.pullRequest === null) return { ...NOTHING, kind: "unknown" };
  return {
    kind: "pr",
    pr: null,
    checks: checksBadge(status.checks),
    review: reviewBadge(status.reviewDecision),
    connect: null,
  };
}

function prWord(state: PrChipState): string {
  switch (state) {
    case "draft":
      return "Draft pull request";
    case "merged":
      return "Merged pull request";
    case "closed":
      return "Closed pull request";
    default:
      return "Pull request";
  }
}

/// `none` renders nothing: a repo with no CI is not a repo with pending CI, and
/// a permanent grey dot on every row of a CI-less repo is noise, not status.
function checksBadge(checks: CheckRollup): ForgeChip["checks"] {
  switch (checks.state) {
    case "failure":
      return {
        tone: "bad",
        title: `${checks.failing} of ${checks.total} check${checks.total === 1 ? "" : "s"} failing`,
      };
    case "pending":
      return { tone: "busy", title: "Checks running" };
    case "success":
      return { tone: "good", title: `${checks.total} check${checks.total === 1 ? "" : "s"} passed` };
    default:
      return null;
  }
}

/// Only the two verdicts render.
///
/// `reviewRequired` is the resting state of every open PR under branch
/// protection and `none` of every PR without it, so neither says anything the
/// row does not already show. `changesRequested` is also the half of this that
/// `needsAttention` counts, so the chip and the needs-you attribution Phase 7
/// builds cannot end up disagreeing about which verdicts are worth surfacing.
function reviewBadge(decision: ReviewDecision): ForgeChip["review"] {
  switch (decision) {
    case "changesRequested":
      return { tone: "bad", title: "Changes requested" };
    case "approved":
      return { tone: "good", title: "Approved" };
    default:
      return null;
  }
}
