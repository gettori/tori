// The one subsequence matcher, shared by every surface that filters as the
// user types: the palette, the file picker, the settings search, the model
// list. One walk answers both questions a surface has - *whether* this target
// matches, and *where* - so a mark can never land on a character that did not
// earn the match.

/** A half-open `[start, end)` slice of the target that matched. */
export type Range = { start: number; end: number };

export type FuzzyMatch = {
  /** Higher is better. Contiguous runs score more, so "mod" prefers "model"
   *  over "m...o...d" scattered through a path. */
  score: number;
  /** Matched positions merged into runs, so "soft" in "Soft wrap" is one mark
   *  rather than four. In target order, non-overlapping. */
  ranges: Range[];
};

/**
 * Case-insensitive subsequence match, greedy: the first available character
 * wins. Null when `query` is not a subsequence of `target`; an empty query
 * matches everything with nothing marked, which is what lets a filter box
 * treat "no query" and "query" through one code path.
 *
 * Greedy is a deliberate pin, not an optimization. A cleverer walk could find
 * prettier runs for the same query ("sonnet" could take the *second* "n"), but
 * every consumer would then need the same cleverness or their marks would
 * disagree with their filters.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  const ranges: Range[] = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === last + 1 ? 3 : 1; // contiguity bonus
      const run = ranges[ranges.length - 1];
      if (run && run.end === ti) run.end = ti + 1;
      else ranges.push({ start: ti, end: ti + 1 });
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? { score, ranges } : null;
}

/**
 * Subsequence fuzzy score for paths: `fuzzyMatch`'s score plus a bonus per
 * matched character in the basename, so "app" prefers `App.tsx` over a match
 * scattered through directories. Null if `query` isn't a subsequence.
 *
 * Derived from the same walk rather than being a second one - the bonus is
 * computable from the ranges, and two walks would be two chances to disagree.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const match = fuzzyMatch(query, target);
  if (!match) return null;
  const baseStart = target.toLowerCase().lastIndexOf("/") + 1;
  let bonus = 0;
  for (const r of match.ranges) {
    bonus += Math.max(0, r.end - Math.max(r.start, baseStart));
  }
  return match.score + bonus;
}

/** `text` split into alternating plain and marked pieces, in order, for a
 *  renderer that cannot take ranges. Always covers the whole string. */
export function segments(text: string, ranges: Range[]): { text: string; marked: boolean }[] {
  if (ranges.length === 0) return [{ text, marked: false }];
  const out: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) out.push({ text: text.slice(at, r.start), marked: false });
    out.push({ text: text.slice(r.start, r.end), marked: true });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false });
  return out;
}
