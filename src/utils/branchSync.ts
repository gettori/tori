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

import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { BranchSync } from "./gitActions";

// Escaped rather than literal so the source stays ASCII, as the Changes panel's
// own pills are.
const UP = "\u2191";
const DOWN = "\u2193";

// The store: every sidebar row's answer, keyed the way the rows are.
//
// Per `(folderPath, branch)` rather than per folder, because a plain repo lists
// several of its branches as rows on one path and each answers for itself. The
// key is the backend's own, so a batch reply lands without a second mapping to
// get wrong.
//
// Recomputed on movement, never on a timer. What moves a branch is a fetch, a
// commit or a checkout, and all three already arrive as events.

/** A row worth asking about: `plain-dir` and `incomplete` units are not git, so
 *  they never reach the backend. */
export type SyncUnit = { folderPath: string; branch: string | null; kind: string };

const ASKABLE = new Set(["worktree", "plain"]);

const keyOf = (folderPath: string, branch: string | null | undefined) => `${folderPath}\u0000${branch ?? ""}`;

const [answers, setAnswers] = createStore<Record<string, BranchSync>>({});

/** The units currently drawn, so a reply that outlived its row is dropped and
 *  a container refresh knows which branches it covers. */
let drawn = new Map<string, { path: string; branch: string }>();

/** One row's standing, or null while nothing has answered for it. Null and
 *  "in sync" are the same to `syncState`, which is what keeps an unanswered row
 *  from reading as a clean one. A missing folder is one of those nulls: a Topic
 *  member whose worktree is gone has no branch to stand anywhere. */
export function syncFor(
  folderPath: string | null | undefined,
  branch: string | null | undefined,
): BranchSync | null {
  return folderPath ? (answers[keyOf(folderPath, branch)] ?? null) : null;
}

/**
 * Reconcile the store against the units the tree now holds: drop what left,
 * ask about what arrived, leave the rest alone.
 *
 * Additions only, because `loadConfig` runs on every config change and a full
 * recompute would put a `git` process per row behind a rename. What the
 * existing rows are waiting for is movement, and movement arrives separately.
 */
export function syncUnits(units: readonly SyncUnit[]): Promise<void> {
  const next = new Map<string, { path: string; branch: string }>();
  for (const unit of units) {
    if (!ASKABLE.has(unit.kind)) continue;
    next.set(keyOf(unit.folderPath, unit.branch), { path: unit.folderPath, branch: unit.branch ?? "" });
  }
  const added = [...next].filter(([key]) => !drawn.has(key)).map(([, unit]) => unit);
  const gone = [...drawn.keys()].filter((key) => !next.has(key));
  drawn = next;
  if (gone.length) setAnswers(produce((state) => gone.forEach((key) => delete state[key])));
  return ask(added);
}

/** Re-ask for every row on one folder. The backend fans a container's fetch out
 *  once per folder in it, so one event covers every branch this path lists. */
export function resyncRoot(root: string | null | undefined): Promise<void> {
  if (!root) return Promise.resolve();
  return ask([...drawn.values()].filter((unit) => unit.path === root));
}

/** Take an answer somebody else already paid for. `refreshMeta` asks
 *  `git_branch_sync` for the selected root on every event that moves HEAD, and
 *  that answer is this row's: asking again would be a second process for a
 *  number already in hand. */
export function adoptSync(root: string, branch: string | null, sync: BranchSync | null): void {
  const key = keyOf(root, branch);
  if (!drawn.has(key)) return;
  setAnswers(produce((state) => {
    if (sync) state[key] = sync;
    else delete state[key];
  }));
}

async function ask(units: { path: string; branch: string }[]): Promise<void> {
  if (!units.length) return;
  const reply = await invoke<Record<string, BranchSync>>("git_branch_sync_many", { units }).catch(() => null);
  if (!reply) {
    // Nothing came back, so these rows were never really claimed. Left in
    // `drawn` they would stay silent for good, because `syncUnits` only ever
    // asks about additions.
    for (const unit of units) drawn.delete(keyOf(unit.path, unit.branch));
    return;
  }
  setAnswers(produce((state) => {
    for (const unit of units) {
      const key = keyOf(unit.path, unit.branch);
      // The row left while the batch ran, or the backend left it out: a path
      // that stopped being a repo must lose its old answer, not keep it.
      if (!drawn.has(key)) continue;
      if (reply[key]) state[key] = reply[key];
      else delete state[key];
    }
  }));
}

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

/** The levels whose label is words rather than an arrow, and so wants a line of
 *  its own on a sidebar row.
 *
 *  `ahead` and `behind` draw as counts beside the branch name, where they cost
 *  no height. `unpushed` is deliberately out: it is the resting state of every
 *  branch somebody just cut, so a line for it would be a line on most rows the
 *  day they are made. */
const OWN_LINE = new Set<SyncLevel>(["conflicts", "diverged", "baseBehind"]);

export const needsOwnLine = (state: SyncState): boolean => OWN_LINE.has(state.level);

/** How loud each level is, lowest first. `syncState` resolves in this order
 *  too, so a Topic and the rows under it cannot disagree about which of two
 *  members is louder. A `Record` over the union rather than a list, so a level
 *  added to `SyncLevel` and forgotten here will not compile. */
const SEVERITY: Record<SyncLevel, number> = {
  conflicts: 0,
  diverged: 1,
  behind: 2,
  baseBehind: 3,
  ahead: 4,
  unpushed: 5,
  none: 6,
};

/** One member, as a roll-up reads it: what to call it, and what its own row
 *  would say. */
export type MemberSync = { label: string; state: SyncState };

/**
 * What a Topic says on behalf of its members: the loudest thing any one of them
 * has to report, named by the members it belongs to.
 *
 * Dirty is absent, and cannot be here: it never reaches a `SyncState` at all.
 * That is the design, not an omission. Uncommitted work is a marker on the
 * member it belongs to, and a Topic that lit up every time somebody started
 * typing would be a light nobody reads.
 */
export function rollupSync(states: readonly MemberSync[]): SyncState {
  let loudest: MemberSync | null = null;
  let others = 0;
  for (const member of states) {
    if (member.state.level === "none") continue;
    if (!loudest || SEVERITY[member.state.level] < SEVERITY[loudest.state.level]) {
      loudest = member;
      others = 0;
    } else if (member.state.level === loudest.state.level) {
      others += 1;
    }
  }
  if (!loudest) return NOTHING;

  // One member's words, and only that member named. The counts and the paths in
  // a detail belong to the branch they were measured on, so naming its
  // neighbours in front of them would read their numbers onto the wrong repo.
  const more = others > 0 ? ` And ${others} other${others === 1 ? "" : "s"} like it.` : "";
  return { ...loudest.state, detail: `${loudest.label}: ${loudest.state.detail}${more}` };
}

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
