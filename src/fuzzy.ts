// Subsequence fuzzy score: null if `query` isn't a subsequence of `target`,
// otherwise higher is better (contiguous runs and basename matches score more).
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  const baseStart = t.lastIndexOf("/") + 1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === last + 1 ? 3 : 1; // contiguity bonus
      if (ti >= baseStart) score += 1; // basename bonus
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}
