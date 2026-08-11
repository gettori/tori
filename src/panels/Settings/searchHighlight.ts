// Where a query matched, so the panel can mark it.
//
// **These must agree with `matchesEntry` in `settingsSearch.ts`**, which is what
// decides whether a row is on screen and what the tab badge counted. A row shown
// with nothing marked in it reads as a filter bug, and a mark where the matcher
// found nothing is worse: it claims a reason that is not the real one.
// `searchHighlight.test.ts` pins the two together rather than trusting the
// duplication, because the rules are stated twice here by necessity - the
// matcher answers *whether*, this answers *where*, and one cannot be derived
// from the other without changing `fuzzyScore`'s return type.

/** A half-open `[start, end)` slice of the string that matched. */
export type Range = { start: number; end: number };

/** Merge adjacent indices into runs, so "soft" in "Soft wrap" is one mark
 *  rather than four. */
function runs(indices: number[]): Range[] {
  const out: Range[] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else out.push({ start: i, end: i + 1 });
  }
  return out;
}

/**
 * Where a **label** matched: the subsequence positions, merged into runs.
 *
 * Walks the target the same greedy way `fuzzyScore` does - first available
 * character wins - so the marks land on exactly the characters that earned the
 * score. A different walk could find a prettier set of runs for the same query,
 * but it would be marking a match the matcher did not make.
 */
export function labelRanges(query: string, label: string): Range[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const t = label.toLowerCase();
  const hit: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      hit.push(ti);
      qi++;
    }
  }
  // Not a subsequence: no match at all, so nothing is marked. Partial runs would
  // highlight a row the filter never selected.
  return qi === q.length ? runs(hit) : [];
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
