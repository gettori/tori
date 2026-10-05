// What the Pull requests panel is showing, decided without a DOM.
//
// The panel is scoped to **one** pull request: the one for the branch this pane
// has checked out. So most of the work is not drawing a pull request, it is
// saying which of the ten ways there is none to draw, and every one of them
// wants a different next action. A panel that renders the same blank for a
// detached HEAD, a GitLab remote and a rejected credential leaves the user with
// no idea which they are in, which is the failure `PrList`'s four paused
// sentences were written against.
//
// ## One classifier, not a second one
//
// The kinds below derive from `forgeChip`, which already answers `hidden |
// inert | unknown | noPr | readyForPr | pr` for the sidebar. Chip and panel
// cannot disagree about a branch because only one of them decides. What this
// adds is the room a panel has and a 16px chip does not: `inert` is one glyph's
// worth of "nothing to say here" and three different facts (no branch, no
// origin, an origin the API will never serve), each with its own answer.
//
// ## Why a direct read exists at all
//
// `unknown` is "servable, but no tick has reached it yet", and a unit past the
// poll's per-tick cap can sit there forever. A panel that waited would spin
// against a pull request the API would answer for immediately, so the caller
// asks `forge_pr_for_branch` directly on mount and hands the answer in here.
// The poll is still preferred where it has one: it is the source every chip on
// screen is already reading.

import type { ForgeChip, ForgeDoor } from "./forgeChip";
import type { PauseReason } from "./forgePoll";
import type { BranchSync } from "./gitActions";
import type { PullRequest, UnitStatus } from "./forgeTypes";

/// What the direct `forge_pr_for_branch` read has said so far.
///
/// `idle` and `loading` are separate from `done` with a null pull request for
/// the usual reason: "nobody has asked" must not render as "there is none".
export type DirectRead =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; pr: PullRequest | null }
  | { kind: "error"; message: string };

/// The two lines a state with no pull request to show puts on screen.
///
/// Here rather than in the panel's JSX so a table test can hold every kind to
/// its own words without rendering anything, the same reason `forgeChip` builds
/// its tooltips instead of leaving them to the row.
type Say = { headline: string; detail: string };

export type PullsPanelState =
  | ({ kind: "loading"; branch: string | null } & Say)
  | ({ kind: "paused"; why: PauseReason; door: ForgeDoor | null } & Say)
  | ({ kind: "noBranch" } & Say)
  | ({ kind: "noRemote" } & Say)
  | ({ kind: "inert"; origin: string } & Say)
  | ({ kind: "onBase"; branch: string } & Say)
  | ({ kind: "noPrUnpushed"; branch: string; unpushed: number } & Say)
  | ({ kind: "noPrPushed"; branch: string; base: string | null; offBase: number } & Say)
  | ({ kind: "error"; message: string } & Say)
  | { kind: "loaded"; number: number; pr: PullRequest; viewing: boolean };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/// The sentence for each reason polling is stopped, and what to do about it.
///
/// Four, not one, because each has a different next action: turn it back on,
/// sign in, sign in again, or pick which account this repo uses.
const PAUSED: Record<PauseReason, Say> = {
  disabled: {
    headline: "GitHub is switched off",
    detail: "Tori cannot read pull requests or post review comments. Settings, Integrations, GitHub turns it back on.",
  },
  signedOut: {
    headline: "GitHub is not connected",
    detail: "Tori cannot read pull requests or post review comments. Opening one still works, in your browser.",
  },
  suspect: {
    headline: "GitHub rejected the stored credential",
    detail: "Nothing here can be read until you sign in again in Settings, Integrations, GitHub.",
  },
  pickAccount: {
    headline: "This repo has no account picked",
    detail: "More than one account reaches this host. Pick the one this repo uses from its branch chip in the sidebar.",
  },
};

export function pullsPanelState(input: {
  /** The sidebar's own answer for this branch, so the two cannot disagree. */
  chip: ForgeChip;
  /** The poll's record for this branch, which carries the `PullRequest` the
   *  chip only describes. */
  status: UnitStatus | null;
  paused: PauseReason | null;
  /** What this repo needs before anything the forge says can be trusted, from
   *  `forgeDoor`. Carried through so the paused state can offer it. */
  door: ForgeDoor | null;
  origin: string | null | undefined;
  branch: string | null;
  /** `git_default_base_branch`. Null where the repo has no remote-tracking base
   *  at all, which is not the same as standing on it. */
  base: string | null;
  sync: BranchSync | null;
  direct: DirectRead;
  /** The pull request the list tab picked, shown instead of the branch's own. */
  viewing: { number: number; pr: PullRequest | null } | null;
}): PullsPanelState {
  const { chip, branch, base, sync } = input;

  // Ahead of everything, including the override: the poller is stopped, so the
  // newest thing any store holds is whatever was true before it stopped, and a
  // pull request rendered from it would age silently behind controls that
  // cannot act on it.
  if (input.paused !== null) {
    return { kind: "paused", why: input.paused, door: input.door, ...PAUSED[input.paused] };
  }

  if (chip.kind === "inert") {
    if (!branch) {
      return {
        kind: "noBranch",
        headline: "Nothing is checked out here",
        detail:
          "A pull request proposes one branch into another. This pane is on a detached commit, so there is no branch to propose.",
      };
    }
    const origin = input.origin ?? null;
    if (origin === null) {
      return {
        kind: "noRemote",
        headline: "This repo has no origin",
        detail:
          "A pull request is opened against a remote, and this repo has none. Everything else about it keeps working.",
      };
    }
    return {
      kind: "inert",
      origin,
      headline: "No review host for this remote",
      detail: "Tori reviews pull requests on GitHub. Everything else about this repo keeps working.",
    };
  }

  // The override outranks the branch's own pull request: somebody picked this
  // one in the list tab, and the verdict rows beside them have to be about what
  // they picked. Cleared by Back, or by the branch changing.
  const viewed = input.viewing;
  if (viewed) {
    const pr = viewed.pr;
    if (pr) return { kind: "loaded", number: viewed.number, pr, viewing: true };
    // Picked, but nothing has handed over the row. There is no read by number,
    // so waiting is all this can honestly do.
    return {
      kind: "loading",
      branch,
      headline: `Opening pull request ${viewed.number}`,
      detail: "",
    };
  }

  // The poll first where it has an answer, because it is the source every chip
  // on screen is already reading and a second opinion here is how a panel and
  // the row above it end up disagreeing.
  const polled = chip.kind === "pr" ? (input.status?.pullRequest ?? null) : null;
  if (polled) return { kind: "loaded", number: polled.number, pr: polled, viewing: false };
  if (input.direct.kind === "done" && input.direct.pr) {
    const pr = input.direct.pr;
    return { kind: "loaded", number: pr.number, pr, viewing: false };
  }

  // The most common state in the app, and it has to read as a fact about where
  // you are rather than as an absence: standing on the base is not a branch
  // missing its pull request.
  if (branch !== null && branch === base) {
    return {
      kind: "onBase",
      branch,
      headline: `You are on ${branch}, the base branch.`,
      detail:
        "Reviews live on the branch that proposes the change. Start one, or check out a branch that already has a pull request.",
    };
  }

  const answeredNoPr =
    chip.kind === "noPr" || chip.kind === "readyForPr" || (input.direct.kind === "done" && input.direct.pr === null);

  if (answeredNoPr && branch !== null) {
    const upstream = sync?.upstream ?? null;
    const offBase = sync?.base?.ahead ?? 0;
    // Its own work that origin does not have. With an upstream that is the
    // count against it; without one, every commit off the base is unpushed,
    // because there is nothing on the remote for them to be on.
    const unpushed = upstream?.has_upstream ? upstream.ahead : offBase;
    if (!upstream?.has_upstream || upstream.ahead > 0) {
      return {
        kind: "noPrUnpushed",
        branch,
        unpushed,
        headline: "No pull request for this branch",
        // The count only where the sync store has answered. A row that said
        // "0 commits that are not on origin yet" while nothing had counted
        // them would be a claim, and one it takes back a moment later.
        detail: !sync
          ? `${branch} is not on origin yet.`
          : upstream?.gone
            ? `${branch} was deleted on origin.`
            : `${branch} has ${plural(unpushed, "commit")} that are not on origin yet.`,
      };
    }
    return {
      kind: "noPrPushed",
      branch,
      base,
      offBase,
      headline: "No pull request for this branch",
      detail: `origin has this branch and matches your local commits. ${plural(offBase, "commit")} ahead of ${base ?? "the base"}.`,
    };
  }

  // Only once nothing above could answer. A failed direct read behind a poll
  // that already said "no pull request" is not worth a whole error surface.
  if (input.direct.kind === "error") {
    return {
      kind: "error",
      message: input.direct.message,
      headline: "GitHub could not be asked about this branch",
      detail: input.direct.message,
    };
  }

  return {
    kind: "loading",
    branch,
    headline: "Checking GitHub for a pull request",
    detail: branch ?? "",
  };
}
