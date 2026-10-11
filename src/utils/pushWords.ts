// What Pull, Pull (Rebase) and Push will do to the branch in front of you, in
// the numbers they will do it with. Decided here without a DOM, so the menu,
// the pill and the confirms cannot word one state two ways.

import type { AheadBehind, PushTarget } from "./gitActions";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Pull's tooltip. `ffOnly` is the read-only pull, which never merges. */
export function pullWords(ab: AheadBehind | null, ffOnly = false): string {
  if (!ab?.has_upstream || !ab.upstream) return "This branch has no upstream to pull from";
  const up = ab.upstream;
  if (ab.behind === 0) return `Up to date with ${up}`;
  if (ab.ahead === 0) return `Fast-forward to ${up}, ${plural(ab.behind, "commit")}`;
  if (ffOnly) return `Fast-forward only: this branch has ${plural(ab.ahead, "commit")} ${up} lacks, so it will refuse`;
  return `Merge ${up} into this branch, ${plural(ab.behind, "commit")}, adds a merge commit`;
}

/** Pull (Rebase)'s tooltip. */
export function pullRebaseWords(ab: AheadBehind | null): string {
  if (!ab?.has_upstream || !ab.upstream) return "This branch has no upstream to pull from";
  const up = ab.upstream;
  if (ab.behind === 0) return `Up to date with ${up}`;
  if (ab.ahead === 0) return `Fast-forward to ${up}, ${plural(ab.behind, "commit")}`;
  return `Replay your ${plural(ab.ahead, "commit")} on top of ${up}, after its ${plural(ab.behind, "commit")}`;
}

/** Why a plain push is refused on a diverged branch. */
export const DIVERGED_REFUSAL = "Diverged: pull with rebase, or force push";

/** The push target when the branch and `origin/<branch>` have both moved, else
 *  null. A superseded upstream is its own state, and reset is its answer. */
export function divergedTarget(ab: AheadBehind | null, superseded: boolean): PushTarget | null {
  const target = ab?.push_target;
  return target && target.ahead > 0 && target.behind > 0 && !superseded ? target : null;
}

/** Push's tooltip. */
export function pushWords(ab: AheadBehind | null, branch: string, superseded: boolean): string {
  if (divergedTarget(ab, superseded)) return DIVERGED_REFUSAL;
  const target = ab?.push_target;
  if (!target) return ab?.sets_upstream ? `Publish ${branch} to origin, sets upstream` : `Publish ${branch} to origin`;
  if (target.ahead === 0) return `Nothing to push to origin/${branch}`;
  return `${plural(target.ahead, "commit")} to origin/${branch}`;
}

/** The Diverged pill's tooltip. Both causes, always: which one it was is a
 *  guess, and `rewritten` only counts as a hint when it was measured against
 *  the same ref the push goes to. */
export function divergedWords(target: PushTarget, branch: string, rewritten: boolean, upstream: string | null): string {
  const counts = `${plural(target.ahead, "commit")} here, ${plural(target.behind, "commit")} on origin/${branch}.`;
  const causes = "If somebody else pushed, Pull (Rebase). If you rewrote history here (rebase, amend), Force Push.";
  const hint = rewritten && upstream === `origin/${branch}` ? " This looks like a rewrite here." : "";
  return `${counts} ${causes}${hint}`;
}

/** The push guard's warning, or null when the push looks like ordinary work:
 *  two or more commits going up, more than half already on the base by patch. */
export function duplicateWarning(pushing: number, duplicated: number, base: string): string | null {
  if (pushing < 2 || duplicated * 2 <= pushing) return null;
  return `${duplicated} of ${plural(pushing, "commit")} are already on ${base} under other hashes, a pull replayed ${base} onto this branch.`;
}

/** Force Push's confirm. */
export function forcePushWords(target: PushTarget, branch: string): string {
  return `This replaces the ${plural(target.behind, "commit")} on origin/${branch} that this branch does not have, and pushes the ${plural(target.ahead, "commit")} here. If origin/${branch} has moved since, the push is rejected and nothing is lost.`;
}
