// Turns a hunk's raw unified-diff lines into rows ready to render: paired -/+
// lines carry word-level segments so a one-token edit highlights that token
// instead of the whole line, and the same rows lay out either inline or
// side-by-side.
//
// Unchanged regions are *not* handled here. The diff is taken at git's default
// context so that a hunk is the same unit `git add -p` would stage, which means
// the file's untouched stretches are absent from it rather than present and
// collapsible. `hunkGaps` (below) reports those stretches; the panel reads them
// back from the file when the user expands one.
//
// Pairing is deliberately conservative. A hunk with 3 removals and 5 additions
// has no correct one-to-one reading, and highlighting every token of every line
// (the naive result) is worse than no highlighting at all: it hides the real
// edit in noise. So lines pair only within an equal-length -/+ run, or by best
// similarity above a threshold; anything unpaired renders plain.

export type Seg = { text: string; changed: boolean };

export type DiffRow = { oldLine: number | null; newLine: number | null } & (
  | { kind: "context" | "meta"; text: string }
  // `pair` links a del to the add it was matched with (side-by-side alignment).
  | { kind: "del" | "add"; text: string; segs?: Seg[]; pair?: number }
);

// Words, runs of whitespace, and single punctuation chars. Identifier chars
// include `_`/`$` so `fooBar_baz` is one token rather than three.
const TOKEN_RE = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;

// A minified bundle or a data blob on one line would make the token diff the
// most expensive thing on screen for no readable gain, so past this it renders
// plain. Same reasoning for the run cap below: similarity pairing is O(n*m),
// which is fine for a hunk and not fine for a machine-generated 5k-line diff.
const MAX_WORD_DIFF_LEN = 2000;
const MAX_SIMILARITY_RUN = 40;
const SIMILARITY_THRESHOLD = 0.3;

function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

/** Common leading/trailing token counts, trimmed so the two never overlap. */
function affixes(a: string[], b: string[]): { pre: number; suf: number } {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

/** 0..1: how much of the longer line the two share at their ends. */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const longest = Math.max(ta.length, tb.length);
  if (longest === 0) return 1;
  const { pre, suf } = affixes(ta, tb);
  return (pre + suf) / longest;
}

/** Collapse a token list into segments, merging the run between `pre` and
 *  `suf` into one changed segment and dropping empty edges. */
function toSegs(marker: string, tokens: string[], pre: number, suf: number): Seg[] {
  const segs: Seg[] = [{ text: marker, changed: false }];
  const head = tokens.slice(0, pre).join("");
  const mid = tokens.slice(pre, tokens.length - suf).join("");
  const tail = tokens.slice(tokens.length - suf).join("");
  if (head) segs.push({ text: head, changed: false });
  if (mid) segs.push({ text: mid, changed: true });
  if (tail) segs.push({ text: tail, changed: false });
  return segs;
}

/** The changed run of a paired line, as offsets into its body (the marker, which
 *  is `segs[0]`, excluded), or null when nothing in it is marked. */
export function changedRange(segs: Seg[]): [number, number] | null {
  let at = 0;
  for (const s of segs.slice(1)) {
    if (s.changed) return [at, at + s.text.length];
    at += s.text.length;
  }
  return null;
}

/** Word-level segments for a matched -/+ pair. `del`/`add` are the raw diff
 *  lines including their leading marker, which is never highlighted. */
export function wordSegs(del: string, add: string): { del: Seg[]; add: Seg[] } | null {
  if (del.length > MAX_WORD_DIFF_LEN || add.length > MAX_WORD_DIFF_LEN) return null;
  const a = tokenize(del.slice(1));
  const b = tokenize(add.slice(1));
  const { pre, suf } = affixes(a, b);
  // Nothing shared at either end: the lines are unrelated enough that marking
  // the whole body changed says nothing the +/- marker didn't already say.
  if (pre === 0 && suf === 0) return null;
  return {
    del: toSegs(del.slice(0, 1), a, pre, suf),
    add: toSegs(add.slice(0, 1), b, pre, suf),
  };
}

/** Match a run of removals to a run of additions. Returns add-index per del
 *  index, or -1 where the del stays unpaired. */
export function pairRun(dels: string[], adds: string[]): number[] {
  const out = dels.map(() => -1);
  if (!dels.length || !adds.length) return out;

  // Equal-length runs read as a line-for-line rewrite: pair positionally, which
  // is both correct and free.
  if (dels.length === adds.length) return dels.map((_, i) => i);

  // Unbalanced: only confident matches pair, and only when the run is small
  // enough that the quadratic scan is cheap.
  if (dels.length > MAX_SIMILARITY_RUN || adds.length > MAX_SIMILARITY_RUN) return out;

  const taken = new Set<number>();
  dels.forEach((del, i) => {
    let best = -1;
    let bestScore = SIMILARITY_THRESHOLD;
    adds.forEach((add, j) => {
      if (taken.has(j)) return;
      const score = similarity(del.slice(1), add.slice(1));
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    });
    if (best >= 0) {
      taken.add(best);
      out[i] = best;
    }
  });
  return out;
}

function classify(line: string): "add" | "del" | "meta" | "context" {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  // "\ No newline at end of file" and the file headers git emits before a hunk.
  if (line.startsWith("\\") || line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "context";
}

/** Build rendered rows from a hunk's lines (header excluded), numbered from the
 *  hunk's two starts. Without `start` every row's numbers are null. */
export function buildRows(lines: string[], start?: { old: number; new: number }): DiffRow[] {
  const rows: DiffRow[] = [];
  let pairSeq = 0;
  let i = 0;
  let oldAt = start?.old ?? null;
  let newAt = start?.new ?? null;

  const numbers = (kind: DiffRow["kind"]) => {
    const oldLine = kind === "add" || kind === "meta" ? null : oldAt;
    const newLine = kind === "del" || kind === "meta" ? null : newAt;
    if (oldLine !== null) oldAt = oldLine + 1;
    if (newLine !== null) newAt = newLine + 1;
    return { oldLine, newLine };
  };

  while (i < lines.length) {
    const kind = classify(lines[i]);
    if (kind !== "del" && kind !== "add") {
      rows.push({ kind, text: lines[i], ...numbers(kind) });
      i++;
      continue;
    }

    // A change block is every consecutive removal followed by every
    // consecutive addition; that is the unit pairing is decided within.
    const dels: string[] = [];
    while (i < lines.length && classify(lines[i]) === "del") dels.push(lines[i++]);
    const adds: string[] = [];
    while (i < lines.length && classify(lines[i]) === "add") adds.push(lines[i++]);

    const matches = pairRun(dels, adds);
    const addPair = new Map<number, number>();
    const delRows: DiffRow[] = dels.map((text, di) => {
      const aj = matches[di];
      if (aj < 0) return { kind: "del", text, ...numbers("del") };
      const segs = wordSegs(text, adds[aj]);
      const id = pairSeq++;
      addPair.set(aj, id);
      return { kind: "del", text, segs: segs?.del, pair: id, ...numbers("del") };
    });
    const addRows: DiffRow[] = adds.map((text, aj) => {
      const id = addPair.get(aj);
      if (id === undefined) return { kind: "add", text, ...numbers("add") };
      const di = matches.indexOf(aj);
      const segs = wordSegs(dels[di], text);
      return { kind: "add", text, segs: segs?.add, pair: id, ...numbers("add") };
    });
    rows.push(...delRows, ...addRows);
  }

  return rows;
}

/** A row's index in the array `toSideBySide` was given, which is also its index
 *  in the hunk body (`buildRows` emits one row per line, in order). Line-level
 *  staging selects by that index, so the two columns have to carry it: the row
 *  objects alone cannot say where they came from. `null` where the cell is
 *  empty. */
export type SideRow = {
  left: DiffRow | null;
  right: DiffRow | null;
  leftIndex: number | null;
  rightIndex: number | null;
};

/** Lay rows into two columns: context spans both, a matched -/+ pair shares a
 *  row, and unpaired changes sit alone on their own side. */
export function toSideBySide(rows: DiffRow[]): SideRow[] {
  const out: SideRow[] = [];
  // A paired add is emitted alongside its del, so remember which to skip.
  const placed = new Set<number>();
  // Pair id -> index of the matching add. Built in one pass: scanning for each
  // del's partner instead would be quadratic, and a large diff is exactly where
  // side-by-side matters most.
  const addByPair = new Map<number, number>();
  rows.forEach((r, j) => {
    if (r.kind === "add" && r.pair !== undefined) addByPair.set(r.pair, j);
  });

  rows.forEach((row, idx) => {
    if (placed.has(idx)) return;
    if (row.kind === "context" || row.kind === "meta") {
      out.push({ left: row, right: row, leftIndex: idx, rightIndex: idx });
      return;
    }
    if (row.kind === "del" && row.pair !== undefined) {
      const aj = addByPair.get(row.pair);
      if (aj !== undefined && aj > idx) {
        placed.add(aj);
        out.push({ left: row, right: rows[aj], leftIndex: idx, rightIndex: aj });
        return;
      }
    }
    out.push(
      row.kind === "del"
        ? { left: row, right: null, leftIndex: idx, rightIndex: null }
        : { left: null, right: row, leftIndex: null, rightIndex: idx },
    );
  });

  return out;
}

/** An unchanged stretch of the file that the diff does not show, between two
 *  hunks (or before the first). Line numbers are 1-based, on the diff's "new"
 *  side, and inclusive. */
export type Gap = { afterHunk: number; start: number; end: number };

/** The unchanged regions between a file's hunks.
 *
 *  At git's default context a hunk carries only three lines either side, so
 *  everything else about the file is simply absent from the diff. These are the
 *  ranges the panel offers to expand, read back from the file itself.
 *
 *  `afterHunk` is the index of the hunk the gap follows, or -1 for the stretch
 *  before the first hunk. The region after the last hunk is deliberately not
 *  reported: the diff does not say how long the file is, and guessing would
 *  mean showing a count that could be wrong.
 */
export function hunkGaps(hunks: { startLine: number; endLine: number }[]): Gap[] {
  const out: Gap[] = [];
  hunks.forEach((h, i) => {
    if (i === 0) {
      if (h.startLine > 1) out.push({ afterHunk: -1, start: 1, end: h.startLine - 1 });
      return;
    }
    const prevEnd = hunks[i - 1].endLine;
    // A pure deletion has no new-side lines, so a hunk can start at or before
    // where the previous one ended; only a real forward span is a gap.
    if (h.startLine > prevEnd + 1) out.push({ afterHunk: i - 1, start: prevEnd + 1, end: h.startLine - 1 });
  });
  return out;
}
