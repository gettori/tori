// The three-way conflict model: what the two sides did to the same file, as
// regions that can be pointed at, navigated, and later resolved.
//
// `@codemirror/merge` compares **two** documents. A conflict is three, so the
// alignment between them is ours to build. What the library does give us is the
// right primitive: `Chunk.build` diffs two docs and returns *line-aligned*
// ranges, which is the granularity a person resolves a conflict at.
//
// The shape is two diffs against a common origin. Diff base against ours and
// base against theirs, and both results are in base coordinates, so they can be
// laid side by side; wherever the two sets of changed lines meet, both sides
// touched the same text and git had nothing to choose between them.
//
// **This is our model of the conflict, not a reading of the markers git wrote
// into the file.** The working copy's `<<<<<<<` blocks are git's rendering of
// the same three stages, and we never parse them: the stages are the source of
// truth, and Phase 12 writes the resolved file from them rather than editing
// around the markers.

import { Chunk, diff } from "@codemirror/merge";
import { Text } from "@codemirror/state";

/** Mirrors `ConflictStages` in src-tauri/src/conflict.rs. */
export type ConflictStages = {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  binary: boolean;
};

/** Mirrors `ConflictOp` in src-tauri/src/conflict.rs. */
export type ConflictOp = "merge" | "rebase" | "cherrypick" | "revert" | "none";

/** Mirrors `SideRef` in src-tauri/src/conflict.rs. */
export type SideRef = { sha: string; short: string; name: string | null };

/** Mirrors `ConflictSides` in src-tauri/src/conflict.rs. */
export type ConflictSides = { ours: SideRef | null; theirs: SideRef | null };

/** A half-open, 1-based line range: `from` is the first line, `to` is one past
 *  the last. `from === to` is a point between lines, which is what a pure
 *  insertion on one side looks like on the sides that did not make it. */
export type LineRange = { from: number; to: number };

export type ConflictRegion = {
  /**
   * Identity that survives the whole resolution.
   *
   * Derived from the base span because the base is the one side that cannot
   * change: it is a blob in the index, fixed for as long as the conflict
   * exists. An index would not do, since resolving one region must not renumber
   * the others, and a line number on ours or theirs moves the moment anything
   * is accepted.
   */
  id: string;
  /** The two sides offer different text here, so this is a conflict proper:
   *  git had two candidate versions of the same lines and no way to pick.
   *
   *  False covers both of the cases that need no decision: only one side
   *  changed, or both changed and **arrived at the same text**, which git
   *  merges cleanly and which a rule of "both sides touched it" would report as
   *  a conflict over two identical versions. */
  both: boolean;
  /** Which sides moved these lines away from the base. What makes a region with
   *  only one of them a change to *carry across* rather than a decision, and
   *  what tells the resolver which version to carry. */
  touched: { ours: boolean; theirs: boolean };
  base: LineRange;
  ours: LineRange;
  theirs: LineRange;
};

/** One of the two candidate versions, named by index stage rather than by who
 *  owns it: which of them is the reader's own work depends on the operation,
 *  and that reading lives in `sideLabels`. */
export type Side = "ours" | "theirs";

/** What the reader decided about one conflict region. `both` keeps ours then
 *  theirs, in that order: it is the order git wrote the two into the file, so
 *  the result reads the way the markers did. `combine-ours` and
 *  `combine-theirs` splice both sides' edits into the base (see `combine`),
 *  named for the side that goes first where two edits land on one spot. `hand`
 *  is a decision too: the reader is writing these lines, so the answer is in
 *  the document rather than derivable from the stages. */
export type Choice = Side | "both" | "combine-ours" | "combine-theirs" | "hand";

/** What to call each side, and which one is the reader's own work.
 *
 *  Not a fixed pair of words, because stage 2 is not always yours: see
 *  `sideLabels`. */
export type SideLabels = { ours: string; theirs: string; yours: "ours" | "theirs" };

/**
 * Which stage is the reader's own work, and what each side should be called.
 *
 * Under a merge, stage 2 is HEAD (where you are) and stage 3 is the branch
 * arriving. **Under a rebase the sides invert**: git checks out the upstream
 * and replays your commits onto it, so stage 2 is the upstream and stage 3 is
 * the commit of yours being applied. A view that always calls stage 2 "yours"
 * is therefore wrong for every rebase conflict, and wrong in the worst way:
 * it reads correctly and points at the other person's work.
 *
 * A cherry-pick or revert replays a commit onto HEAD without moving HEAD, so
 * they keep the merge orientation. So does `none`, which is where a conflicted
 * `git stash apply` lands.
 */
/** What the operation is called in a header. `none` is where a conflicted
 *  `git stash apply` or `git checkout -m` lands: git records no state for
 *  either, but the tree is just as unmerged. */
export const OP_WORD: Record<ConflictOp, string> = {
  merge: "Merge",
  rebase: "Rebase",
  cherrypick: "Cherry-pick",
  revert: "Revert",
  none: "Unresolved",
};

export function sideLabels(op: ConflictOp): SideLabels {
  if (op === "rebase") {
    return { ours: "Upstream", theirs: "Yours (being replayed)", yours: "theirs" };
  }
  if (op === "cherrypick" || op === "revert") {
    return { ours: "Yours (HEAD)", theirs: "Being applied", yours: "ours" };
  }
  return { ours: "Yours (HEAD)", theirs: "Incoming", yours: "ours" };
}

const doc = (text: string) => Text.of(text.split("\n"));

/**
 * The line a position falls on, as a half-open range end.
 *
 * `Chunk` positions may point past the end of the document, and a document
 * whose last line has no newline ends mid-line, so neither clamping nor a bare
 * `lineAt` is enough on its own.
 */
function lineAt(d: Text, pos: number): number {
  const line = d.lineAt(Math.min(Math.max(pos, 0), d.length));
  // Past the start of its line means the range covers that line, so the
  // exclusive end is the next one. At the start means it stops before it.
  return pos > line.from ? line.number + 1 : line.number;
}

/**
 * Where a base position lands on one side, given that side's chunks.
 *
 * Outside every chunk the two documents agree, so the position moves by the
 * net length of the chunks before it. Inside one, there is no single answer,
 * so the range end decides: a start collapses to the chunk's start, an end to
 * its end, which is what makes a region cover the whole of every chunk it
 * touches on every side.
 */
/** The text a line range covers, for comparing what two sides say. */
function lines(d: Text, range: LineRange): string {
  const from = Math.min(Math.max(range.from, 1), d.lines);
  const to = Math.min(Math.max(range.to, 1), d.lines + 1);
  if (to <= from) return "";
  return d.sliceString(d.line(from).from, d.line(to - 1).to);
}

function mapPos(chunks: readonly Chunk[], pos: number, end: boolean): number {
  let delta = 0;
  for (const c of chunks) {
    if (c.fromA > pos) break;
    // The second test is the insertion case: a chunk that covers no base lines
    // sits *at* a position rather than around it, so `toA > pos` never fires.
    if (c.toA > pos || (c.fromA === pos && c.toA === pos)) return end ? c.toB : c.fromB;
    delta += c.toB - c.fromB - (c.toA - c.fromA);
  }
  return pos + delta;
}

/**
 * The regions in which ours and theirs diverge from base.
 *
 * A missing stage is passed as an empty string: a side that deleted the file
 * really does contribute no lines, and the caller still holds the stages, so it
 * can say "deleted" rather than showing an empty pane. That keeps one code path
 * instead of a special case per absent side.
 *
 * Two changed spans join into one region when they overlap **or touch**, which
 * is git's own rule: with no unchanged line between two changes there is
 * nothing to anchor them apart, and git writes them inside a single pair of
 * markers. It is also what makes two insertions at the same point one region
 * rather than two zero-width ones nobody can tell apart.
 */
export function conflictRegions(base: string, ours: string, theirs: string): ConflictRegion[] {
  const baseDoc = doc(base);
  const oursDoc = doc(ours);
  const theirsDoc = doc(theirs);
  const oursChunks = Chunk.build(baseDoc, oursDoc);
  const theirsChunks = Chunk.build(baseDoc, theirsDoc);

  type Tagged = { c: Chunk; mine: boolean };
  const all: Tagged[] = [
    ...oursChunks.map((c) => ({ c, mine: true })),
    ...theirsChunks.map((c) => ({ c, mine: false })),
  ].sort((a, b) => a.c.fromA - b.c.fromA || a.c.toA - b.c.toA);

  const regions: ConflictRegion[] = [];
  let i = 0;
  while (i < all.length) {
    let fromA = all[i].c.fromA;
    let toA = all[i].c.toA;
    let hasOurs = all[i].mine;
    let hasTheirs = !all[i].mine;
    i++;
    // `<=` rather than `<`: touching counts as one region, see the doc above.
    while (i < all.length && all[i].c.fromA <= toA) {
      toA = Math.max(toA, all[i].c.toA);
      if (all[i].mine) hasOurs = true;
      else hasTheirs = true;
      i++;
    }
    const span = (d: Text, chunks: readonly Chunk[]): LineRange => ({
      from: lineAt(d, mapPos(chunks, fromA, false)),
      to: lineAt(d, mapPos(chunks, toA, true)),
    });
    const baseSpan = { from: lineAt(baseDoc, fromA), to: lineAt(baseDoc, toA) };
    const oursSpan = span(oursDoc, oursChunks);
    const theirsSpan = span(theirsDoc, theirsChunks);
    regions.push({
      id: `b${baseSpan.from}-${baseSpan.to}`,
      // Not "both sides touched it": two people can make the same edit, and git
      // merges that without complaint. Asking for a decision between two
      // identical versions is a question with no wrong answer and no right one.
      both: hasOurs && hasTheirs && lines(oursDoc, oursSpan) !== lines(theirsDoc, theirsSpan),
      touched: { ours: hasOurs, theirs: hasTheirs },
      base: baseSpan,
      ours: oursSpan,
      theirs: theirsSpan,
    });
  }
  return regions;
}

/** Just the regions that need a decision. The rest merge on their own. */
export function conflictsOnly(regions: ConflictRegion[]): ConflictRegion[] {
  return regions.filter((r) => r.both);
}

/**
 * The conflict after `currentId`, or the first when nothing is current.
 *
 * Deliberately does not wrap. Navigation that loops gives the reader no way to
 * tell "there is another one" from "you have been all the way round", and the
 * point of walking a conflicted file is knowing when you have seen all of it.
 */
export function nextConflict(regions: ConflictRegion[], currentId: string | null): ConflictRegion | null {
  const list = conflictsOnly(regions);
  const at = currentId ? list.findIndex((r) => r.id === currentId) : -1;
  return list[at + 1] ?? null;
}

/** The conflict before `currentId`, or null at (or before) the first. */
export function prevConflict(regions: ConflictRegion[], currentId: string | null): ConflictRegion | null {
  const list = conflictsOnly(regions);
  const at = currentId ? list.findIndex((r) => r.id === currentId) : -1;
  return at > 0 ? list[at - 1] : null;
}

/** Whether a region has its answer: a choice, or both sides set aside. Ignoring
 *  is bookkeeping rather than an edit, so a region settled that way keeps
 *  whatever text the Result already holds for it. */
export function decided(id: string, choices: Record<string, Choice>, ignored: Record<string, Side[]> = {}): boolean {
  const aside = ignored[id] ?? [];
  return !!choices[id] || (aside.includes("ours") && aside.includes("theirs"));
}

/** The conflicts still waiting on a decision. */
export function unresolved(
  regions: ConflictRegion[],
  choices: Record<string, Choice>,
  ignored: Record<string, Side[]> = {},
): ConflictRegion[] {
  return conflictsOnly(regions).filter((r) => !decided(r.id, choices, ignored));
}

/**
 * The sides that deleted the file, which is a conflict about the file's
 * existence rather than about its lines.
 *
 * A stage is absent exactly when that side has no version of the file: the
 * delete half of a delete/modify conflict, or both halves of a `DD`. There is
 * nothing to resolve line by line there, and treating the absent side as an
 * empty document would offer "accept theirs" as a way to produce an empty file
 * where git means the file to be gone.
 */
export function deletedSides(stages: ConflictStages): Side[] {
  const out: Side[] = [];
  if (stages.ours === null) out.push("ours");
  if (stages.theirs === null) out.push("theirs");
  return out;
}

// Keyed by the stages object, which a read hands around whole, so each side is
// split once however many regions and choices ask for its lines.
const splitStages = new WeakMap<ConflictStages, Record<"base" | Side, string[]>>();

/** The lines one stage holds over a range of its own. */
export function regionLines(stages: ConflictStages, which: "base" | Side, range: LineRange): string[] {
  let split = splitStages.get(stages);
  if (!split) {
    const lines = (text: string | null) => (text ?? "").split("\n");
    split = { base: lines(stages.base), ours: lines(stages.ours), theirs: lines(stages.theirs) };
    splitStages.set(stages, split);
  }
  return split[which].slice(range.from - 1, range.to - 1);
}

/**
 * Both sides' edits to one region spliced into its base, or null when two of
 * them rewrite the same base characters.
 *
 * VS Code's smart combination. git conflicts a line at a time, so edits to two
 * halves of one line are a conflict it refused; diffed a character at a time
 * against the base, they need not overlap at all. Every line carries its
 * newline through the diff, which keeps two whole-line insertions two lines.
 */
export function combine(stages: ConflictStages, region: ConflictRegion, first: Side): string[] | null {
  const text = (lines: string[]) => lines.map((l) => `${l}\n`).join("");
  const base = text(regionLines(stages, "base", region.base));
  const edits = (["ours", "theirs"] as const).flatMap((side) => {
    const after = text(regionLines(stages, side, region[side]));
    return diff(base, after).map((c) => ({ side, from: c.fromA, to: c.toA, insert: after.slice(c.fromB, c.toB) }));
  });
  // Insertions ahead of rewrites at the same point, so `first` only ever orders
  // two insertions there, the one case where order changes the text.
  const rank = (e: (typeof edits)[number]) => (e.to > e.from ? 2 : 0) + (e.side === first ? 0 : 1);
  edits.sort((a, b) => a.from - b.from || rank(a) - rank(b));
  let out = "";
  let at = 0;
  for (const e of edits) {
    if (e.from < at) return null;
    out += base.slice(at, e.from) + e.insert;
    at = e.to;
  }
  out += base.slice(at);
  if (!out) return [];
  return (out.endsWith("\n") ? out.slice(0, -1) : out).split("\n");
}

/** How one region offers keeping both sides: a combination where the edits
 *  splice, a second order only where order changes the text, and git's plain
 *  pair where they collide. */
export function bothChoices(stages: ConflictStages, region: ConflictRegion): Choice[] {
  const oursFirst = combine(stages, region, "ours");
  if (!oursFirst) return ["both"];
  const theirsFirst = combine(stages, region, "theirs");
  if (!theirsFirst || theirsFirst.join("\n") === oursFirst.join("\n")) return ["combine-ours"];
  return ["combine-ours", "combine-theirs"];
}

/** The lines a choice puts where a region was, or null for `hand`, whose lines
 *  are the reader's and live in the document. */
export function choiceLines(stages: ConflictStages, region: ConflictRegion, choice: Choice): string[] | null {
  const take = (side: Side) => regionLines(stages, side, region[side]);
  if (choice === "hand") return null;
  if (choice === "ours" || choice === "theirs") return take(choice);
  if (choice === "both") return [...take("ours"), ...take("theirs")];
  const first = choice === "combine-ours" ? "ours" : "theirs";
  const second = first === "ours" ? "theirs" : "ours";
  // Offered only where it splices, so the pair in the same order is a fallback
  // for a stale choice, not a path anyone is shown.
  return combine(stages, region, first) ?? [...take(first), ...take(second)];
}

/**
 * What accepting one side from its own pane makes of a region's choice.
 *
 * It adds rather than replaces, the way VS Code's in-pane accepts do: with the
 * other side already in, the answer is both, combined where `both` offers it
 * and with the side that was there first ahead.
 */
export function withSide(current: Choice | undefined, side: Side, both: Choice[]): Choice {
  const other: Side = side === "ours" ? "theirs" : "ours";
  if (current && keeps(current, side)) return current;
  if (!current || !keeps(current, other)) return side;
  const ordered: Choice = other === "ours" ? "combine-ours" : "combine-theirs";
  return both.includes(ordered) ? ordered : both[0];
}

/** What a region's choice becomes with one side taken back out: the other side
 *  where both were in, or null, which is undecided again. */
export function withoutSide(current: Choice, side: Side): Choice | null {
  if (current === side) return null;
  if (!keeps(current, side)) return current;
  return side === "ours" ? "theirs" : "ours";
}

/** Whether a choice keeps that side's version in the result. */
export function keeps(choice: Choice, side: Side): boolean {
  return choice === side || choice === "both" || choice === "combine-ours" || choice === "combine-theirs";
}

/** Where one undecided conflict sits in a built document, as character offsets.
 *  `to` reaches past the line's terminating newline, so replacing the range
 *  with a side's lines leaves the file's line structure intact and replacing it
 *  with nothing removes the line rather than leaving a blank one. */
export type ResultSlot = { id: string; from: number; to: number };

/** A built document, the conflicts still open in it, and where each region that
 *  needed no decision landed. */
export type ResultDoc = { text: string; slots: ResultSlot[]; carried: ResultSlot[] };

/**
 * The file the chosen resolutions add up to, with an empty line held open
 * wherever a conflict has not been decided yet.
 *
 * Built out of the three stages rather than by editing the marker-riddled file
 * on disk, which is the point of modelling the conflict from the index: the
 * result contains what the reader chose and nothing git wrote to describe the
 * choice.
 *
 * The walk is in base coordinates, which is the only frame all three sides
 * share. Between regions the three documents agree, so those lines are copied
 * from the base; inside one, the region's own span on the chosen side says
 * which lines replace them.
 *
 * This runs **once**, to seed the Result pane. After that the document is the
 * answer: a reader who takes a side and then edits it has written something no
 * walk over the stages can reproduce, which is why nothing rebuilds from here.
 */
export function buildResult(
  stages: ConflictStages,
  regions: ConflictRegion[],
  choices: Record<string, Choice>,
): ResultDoc {
  const base = (stages.base ?? "").split("\n");

  const out: string[] = [];
  const marks: { id: string; from: number; to: number }[] = [];
  const carried: typeof marks = [];
  let cursor = 1;
  for (const r of regions) {
    out.push(...base.slice(cursor - 1, r.base.from - 1));
    // An undisputed region is not a decision, so it does not have one: whichever
    // side moved is the version to carry. Both having moved to the same text is
    // the `both === false` case where either answer is the same answer.
    const choice: Choice | undefined = r.both ? choices[r.id] : r.touched.ours ? "ours" : "theirs";
    if (!choice) {
      marks.push({ id: r.id, from: out.length, to: out.length + 1 });
      out.push("");
    } else {
      // `hand` contributes nothing, for the same reason it cannot be rebuilt:
      // those lines are the reader's own and live in the document.
      const from = out.length;
      out.push(...(choiceLines(stages, r, choice) ?? []));
      if (!r.both) carried.push({ id: r.id, from, to: out.length });
    }
    cursor = r.base.to;
  }
  out.push(...base.slice(cursor - 1));

  const text = out.join("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of out) {
    offsets.push(at);
    at += line.length + 1;
  }
  offsets.push(at);
  // The last line has no newline to reach past, so its slot stops at the end.
  const clamp = (i: number) => Math.min(text.length, offsets[i]);
  const span = (m: ResultSlot) => ({ id: m.id, from: clamp(m.from), to: clamp(m.to) });
  return { text, slots: marks.map(span), carried: carried.map(span) };
}

/** The Result pane's starting document: every conflict still open. */
export function seedResult(stages: ConflictStages, regions: ConflictRegion[]): ResultDoc {
  return buildResult(stages, regions, {});
}
