// Where a query matched, so the panel can mark it.
//
// **These must agree with `matchesEntry` in `settingsSearch.ts`**, which is what
// decides whether a row is on screen and what the tab badge counted. A row shown
// with nothing marked in it reads as a filter bug, and a mark where the matcher
// found nothing is worse: it claims a reason that is not the real one.
//
// The agreement is structural now, not duplicated: `fuzzyMatch` returns the
// score and the matched ranges from one walk, so the label marks here come
// from the very walk `matchesEntry`'s `fuzzyScore` is built on.
// `searchHighlight.test.ts` still pins the two together, as the regression
// net for anyone splitting them apart again.

import { fuzzyMatch, segments, type Range } from "../../../utils/fuzzy";

export { segments };
export type { Range };

/**
 * Where a **label** matched: the subsequence positions, merged into runs.
 * Empty for a query that is not a subsequence at all - partial runs would
 * highlight a row the filter never selected.
 */
export function labelRanges(query: string, label: string): Range[] {
  const q = query.trim();
  if (!q) return [];
  return fuzzyMatch(q, label)?.ranges ?? [];
}

/**
 * Where a **hint** matched: the one substring occurrence.
 *
 * Substring rather than subsequence, for the reason the matcher draws the same
 * distinction: a hint is prose, and almost any query is a subsequence of a
 * hundred characters of it, so a loose rule would scatter marks across a
 * paragraph that never really answered the query.
 */
export function hintRanges(query: string, hint: string | undefined): Range[] {
  const q = query.trim().toLowerCase();
  if (!q || !hint) return [];
  const at = hint.toLowerCase().indexOf(q);
  return at === -1 ? [] : [{ start: at, end: at + q.length }];
}
