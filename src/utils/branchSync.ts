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

/** One glyph a surface draws for one fact. `count` is null where the fact has
 *  no number: uncommitted work, a branch that has never been pushed. */
export type SyncMark = {
  kind: "conflict" | "push" | "pull" | "dirty";
  count: number | null;
  tone: SyncTone;
  /** This mark's own clause of the sentence a tooltip assembles. */
  title: string;
};

/**
 * Every fact worth a glyph, in drawing order, for a surface with no room for
 * words.
 *
 * Not a verdict. `syncState` picks the one thing worth *saying*, which is what
 * a chip with a sentence in it needs; this returns them all, because a branch
 * that is ninety-nine behind *and* about to conflict is two things, and a row
 * that showed only the louder would be hiding the number you act on.
 *
 * Colour is spent on the two states that need a decision and nowhere else. Most
 * branches in a sidebar are behind something, so an amber "behind" is a column
 * of amber, and a colour every row wears is a colour that has stopped saying
 * anything.
 */
export function syncMarks(sync: BranchSync | null | undefined): SyncMark[] {
  if (!sync || sync.detached) return [];
  const { ahead, behind, has_upstream, rewritten, superseded } = sync.upstream;
  const fighting = sync.base?.conflicts ?? [];
  const unpublished = !has_upstream ? (sync.base?.ahead ?? 0) : 0;
  const marks: SyncMark[] = [];

  // First, so the one red glyph in a column keeps the same place in the run and
  // never sits against the forge's own marks at the other end.
  if (sync.base && fighting.length > 0) {
    marks.push({
      kind: "conflict",
      count: fighting.length,
      tone: "danger",
      title: `${sync.base.name} has moved on, and ${plural(fighting.length, "file")} would conflict when you catch up`,
    });
  }

  // Both lit is diverged, which needs no word for it: the pair is the word.
  // Superseded is not: the commits here are the upstream's own old ones, and an
  // up arrow would invite the push that throws away somebody's update.
  const diverged = ahead > 0 && behind > 0 && !superseded;
  const tone: SyncTone = diverged ? "warn" : "muted";
  if (ahead > 0 && !superseded) {
    marks.push({ kind: "push", count: ahead, tone, title: `${plural(ahead, "commit")} to push` });
  } else if (unpublished > 0) {
    // Before the first push there is no remote branch to count against. The
    // commits unique to this branch relative to its base are what that first
    // push will publish.
    marks.push({
      kind: "push",
      count: unpublished,
      tone: "muted",
      title: `${plural(unpublished, "commit")} to publish`,
    });
  } else if (!has_upstream) {
    // The same fact without a number to put on it: nothing is pushed, so
    // everything is pending. One glyph fewer to learn than a state of its own.
    marks.push({ kind: "push", count: null, tone: "muted", title: "This branch has no upstream yet" });
  }
  if (behind > 0) {
    marks.push({ kind: "pull", count: behind, tone, title: `${plural(behind, "commit")} to pull` });
  }
  if (diverged && rewritten) {
    marks[marks.length - 1].title += ". The upstream still points at history you rewrote, so this needs a force push";
  }
  if (superseded) {
    marks[marks.length - 1].title += `. The upstream was force-pushed over the ${plural(ahead, "commit")} here, so pulling resets to it`;
  }
  if (sync.dirty) {
    marks.push({ kind: "dirty", count: null, tone: "muted", title: "Uncommitted changes" });
  }
  return marks;
}

/** The sentence a mark run's single tooltip carries. One hover target per row,
 *  because four glyphs with four native tooltips is four times the same census
 *  entry for text nobody reads four times. */
export const markTitle = (marks: readonly SyncMark[]): string => marks.map((m) => m.title).join("\n");

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

/** One member, as a roll-up reads it: what to call it, and the facts its own
 *  row is drawn from. */
export type MemberSync = { label: string; sync: BranchSync | null | undefined };

/** A Topic's answer: the loudest member's verdict, its glyphs, and which member
 *  it was. `label` is empty when no member had anything to say. */
export type Rollup = { state: SyncState; marks: SyncMark[]; label: string };

/**
 * What a Topic says on behalf of its members: the loudest thing any one of them
 * has to report, named by the members it belongs to.
 *
 * Dirty is absent, and cannot be here: it never reaches a `SyncState` at all.
 * That is the design, not an omission. Uncommitted work is a marker on the
 * member it belongs to, and a Topic that lit up every time somebody started
 * typing would be a light nobody reads.
 */
export function rollupSync(states: readonly MemberSync[]): Rollup {
  let loudest: { member: MemberSync; state: SyncState } | null = null;
  let others = 0;
  for (const member of states) {
    const state = syncState(member.sync);
    if (state.level === "none") continue;
    if (!loudest || SEVERITY[state.level] < SEVERITY[loudest.state.level]) {
      loudest = { member, state };
      others = 0;
    } else if (state.level === loudest.state.level) {
      others += 1;
    }
  }
  if (!loudest) return { state: NOTHING, marks: [], label: "" };

  // One member's words, and only that member named. The counts and the paths in
  // a detail belong to the branch they were measured on, so naming its
  // neighbours in front of them would read their numbers onto the wrong repo.
  const more = others > 0 ? ` And ${others} other${others === 1 ? "" : "s"} like it.` : "";
  return {
    state: { ...loudest.state, detail: `${loudest.member.label}: ${loudest.state.detail}${more}` },
    marks: syncMarks(loudest.member.sync),
    label: loudest.member.label,
  };
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
  const { ahead, behind, has_upstream, rewritten, superseded } = sync.upstream;
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

  if (superseded) {
    return {
      ...NOTHING,
      level: "behind",
      tone: "attention",
      label: `${DOWN}${behind}`,
      detail: `The upstream was force-pushed over the ${plural(ahead, "commit")} here. Pulling resets to its ${plural(behind, "commit")}.`,
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
    const unpublished = base?.ahead ?? 0;
    return {
      ...NOTHING,
      level: "unpushed",
      tone: "muted",
      label: unpublished > 0 ? `${UP}${unpublished}` : "unpushed",
      detail:
        unpublished > 0
          ? `${plural(unpublished, "commit")} to publish. The remote branch will be created on first push.`
          : "This branch has no upstream yet.",
    };
  }

  return NOTHING;
}
