// What a branch's sync facts mean, decided without a DOM.
//
// The backend answers with counts and paths; this turns them into the one thing
// worth drawing. Every surface that shows sync (the titlebar chip, a sidebar
// row, a Topic's roll-up) reads the same verdict from here, because two
// renderers is how a chip and a row end up disagreeing about the same branch.
//
// Silence is a state. `none` is the resting state of most branches, and it
// carries no label on purpose: a row that draws "in sync" on every clean branch
// spends the reader's attention on the news that there is no news.

import type { BranchSync } from "./gitActions";

// Escaped rather than literal so the source stays ASCII, as the Changes panel's
// own pills are.
const UP = "↑";
const DOWN = "↓";

/** The levels, most severe first. The order here is the order `syncState`
 *  resolves them in, so a branch that is both behind its base and diverged from
 *  its upstream reports the divergence. */
export type SyncLevel =
  | "conflicts"
  | "diverged"
  | "behind"
  | "baseBehind"
  | "ahead"
  | "unpushed"
  | "none";

/** How loud the level is drawn. Four steps rather than the levels themselves,
 *  so two levels that deserve the same weight cannot drift apart in CSS. */
export type SyncTone = "danger" | "warn" | "attention" | "muted";

export type SyncState = {
  level: SyncLevel;
  tone: SyncTone;
  /** The row's own words. Empty at `none`, which draws nothing at all. */
  label: string;
  /** The sentence behind the label, for a tooltip. Empty at `none`. */
  detail: string;
  /** The paths a merge of the base would fight over. Empty at every level but
   *  `conflicts`, so a tooltip can list them without asking which level it is. */
  conflicts: readonly string[];
};

const NOTHING: SyncState = { level: "none", tone: "muted", label: "", detail: "", conflicts: [] };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The one thing this branch's sync facts are worth saying.
 *
 * A detached HEAD reads `none`: it has no upstream and no base of its own, and
 * every count against a branch it is not on would be an answer to a question
 * nobody asked. Missing facts read `none` for the same reason - a row that has
 * not been answered for yet must look like a row with nothing to report, never
 * like a clean one that has been.
 */
export function syncState(sync: BranchSync | null | undefined): SyncState {
  if (!sync || sync.detached) return NOTHING;
  const { ahead, behind, has_upstream, rewritten } = sync.upstream;
  const base = sync.base;

  // A null `conflicts` is "not asked" (git below 2.38, or no shared history),
  // which falls through to `baseBehind` rather than reading as a clean merge.
  const fighting = base?.conflicts ?? [];
  if (base && fighting.length > 0) {
    return {
      level: "conflicts",
      tone: "danger",
      label: `${base.name}: ${plural(fighting.length, "conflict")}`,
      detail: `${base.name} has moved on, and ${plural(fighting.length, "file")} would conflict when you catch up.`,
      conflicts: fighting,
    };
  }

  if (ahead > 0 && behind > 0) {
    return {
      ...NOTHING,
      level: "diverged",
      tone: "warn",
      label: "diverged",
      detail: rewritten
        ? `${plural(ahead, "commit")} here, ${plural(behind, "commit")} upstream. The upstream still points at history you rewrote, so this needs a force push.`
        : `${plural(ahead, "commit")} here, ${plural(behind, "commit")} upstream. Pull before you push.`,
    };
  }

  if (behind > 0) {
    return {
      ...NOTHING,
      level: "behind",
      tone: "attention",
      label: `${DOWN}${behind}`,
      detail: `${plural(behind, "commit")} on the upstream that this branch does not have.`,
    };
  }

  if (base && base.behind > 0) {
    return {
      ...NOTHING,
      level: "baseBehind",
      tone: "muted",
      label: `${base.name} +${base.behind}`,
      detail: `${base.name} is ${plural(base.behind, "commit")} ahead of this branch.`,
    };
  }

  if (ahead > 0) {
    return {
      ...NOTHING,
      level: "ahead",
      tone: "muted",
      label: `${UP}${ahead}`,
      detail: `${plural(ahead, "commit")} to push.`,
    };
  }

  // Only without an upstream, and only on a branch: "never pushed" is a state
  // of a branch, and a detached HEAD is not one.
  if (!has_upstream) {
    return {
      ...NOTHING,
      level: "unpushed",
      tone: "muted",
      label: "unpushed",
      detail: "This branch has no upstream yet.",
    };
  }

  return NOTHING;
}
