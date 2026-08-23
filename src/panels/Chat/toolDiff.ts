// The diff an edit or a write made, in rows a body can draw.
//
// Two sources, one row type. Where the transport measured a patch it is used
// verbatim, because only it carries the file's own line numbers and the context
// around the change. Where it did not, the call's own arguments are diffed:
// complete, but unnumbered, since an `Edit`'s `old_string` names a fragment and
// never says where in the file it sits.

import { parseDiffHunks } from "../../utils/diffHunks";
import type { PatchHunk } from "../../utils/chatTypes";

/** One line of a diff. `oldLine` and `newLine` are null where the source could
 *  not say, which is every row of a computed diff. */
export type DiffRow = {
  kind: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

/** One hunk, and the range it covers, for a body that draws them in order. */
export type DiffHunk = { header: string; rows: DiffRow[] };

/** The file a diff belongs to, and how it should be drawn. */
export type ToolDiffBody = {
  hunks: DiffHunk[];
  /** True when the rows came from the call's arguments rather than a measured
   *  patch, which is what the card says out loud: the change is real, the line
   *  numbers are not available. */
  computed: boolean;
};

function marked(line: string): { kind: DiffRow["kind"]; text: string } {
  const head = line[0];
  if (head === "+") return { kind: "add", text: line.slice(1) };
  if (head === "-") return { kind: "del", text: line.slice(1) };
  // A context line carries a leading space, and an empty one carries nothing at
  // all: `structuredPatch` drops the marker on a blank line rather than sending
  // a lone space.
  return { kind: "ctx", text: head === " " ? line.slice(1) : line };
}

/** Marked lines, numbered from where the hunk says each side starts. */
function rowsFrom(oldStart: number, newStart: number, lines: string[]): DiffRow[] {
  let oldAt = oldStart;
  let newAt = newStart;
  return lines.map((line) => {
    const { kind, text } = marked(line);
    const row: DiffRow = {
      kind,
      oldLine: kind === "add" ? null : oldAt,
      newLine: kind === "del" ? null : newAt,
      text,
    };
    if (kind !== "add") oldAt += 1;
    if (kind !== "del") newAt += 1;
    return row;
  });
}

/** A measured patch, in rows. Each hunk's rows carry the file's real numbers. */
export function patchHunks(patch: PatchHunk[]): DiffHunk[] {
  return patch.map((hunk) => ({
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    rows: rowsFrom(hunk.oldStart, hunk.newStart, hunk.lines),
  }));
}

/** A unified diff as `git` writes it, in the same rows. The working-tree diff
 *  the card fetches for revert arrives this way. */
export function unifiedHunks(diffText: string): DiffHunk[] {
  return parseDiffHunks(diffText).map((hunk) => ({
    header: hunk.header,
    rows: rowsFrom(hunk.oldStart, hunk.startLine, hunk.lines),
  }));
}

/**
 * A line diff of two texts.
 *
 * A plain longest-common-subsequence over lines. Quadratic in the *changed*
 * region only, because the matching head and tail are trimmed first, and an
 * edit's arguments are a fragment rather than a file, so the region that
 * reaches the table is small. Over the guard the two sides are reported whole,
 * one removed and one added, which is what a diff of two unrelated texts is
 * anyway.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const rows: DiffRow[] = [];
  const ctx = (text: string) => rows.push({ kind: "ctx", oldLine: null, newLine: null, text });
  for (const line of a.slice(0, head)) ctx(line);

  if (midA.length * midB.length > LCS_GUARD) {
    for (const line of midA) rows.push({ kind: "del", oldLine: null, newLine: null, text: line });
    for (const line of midB) rows.push({ kind: "add", oldLine: null, newLine: null, text: line });
  } else {
    rows.push(...lcs(midA, midB));
  }

  for (const line of a.slice(a.length - tail)) ctx(line);
  return rows;
}

/** The largest table `lineDiff` will build, as cells. Beyond it the two sides
 *  are reported whole rather than aligned. */
const LCS_GUARD = 4_000_000;

function lcs(a: string[], b: string[]): DiffRow[] {
  // `len[i][j]` is the length of the longest common subsequence of the tails
  // `a[i..]` and `b[j..]`, so walking forward from 0,0 emits in file order.
  const len: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "ctx", oldLine: null, newLine: null, text: a[i] });
      i += 1;
      j += 1;
    } else if (len[i + 1][j] >= len[i][j + 1]) {
      rows.push({ kind: "del", oldLine: null, newLine: null, text: a[i] });
      i += 1;
    } else {
      rows.push({ kind: "add", oldLine: null, newLine: null, text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) rows.push({ kind: "del", oldLine: null, newLine: null, text: a[i] });
  for (; j < b.length; j += 1) rows.push({ kind: "add", oldLine: null, newLine: null, text: b[j] });
  return rows;
}

/**
 * The diff a card can draw for this call, or null when it has nothing to draw.
 *
 * The measured patch wins wherever there is one. The arguments are the fallback
 * that keeps working where a patch never arrives: an ACP agent, a creating
 * `Write` (whose patch is empty by definition, since there is nothing to diff
 * against), and a patch too large for the wire.
 */
export function toolDiffBody(patch: PatchHunk[], input: unknown): ToolDiffBody | null {
  if (patch.length) return { hunks: patchHunks(patch), computed: false };
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  const before = typeof rec.old_string === "string" ? rec.old_string : null;
  const after = typeof rec.new_string === "string" ? rec.new_string : null;
  if (before !== null && after !== null) {
    return { hunks: [{ header: "", rows: lineDiff(before, after) }], computed: true };
  }
  // A `Write` names no before-state at all, so its content is the whole diff.
  const content = typeof rec.content === "string" ? rec.content : null;
  if (content !== null) {
    return { hunks: [{ header: "", rows: lineDiff("", content) }], computed: true };
  }
  return null;
}

/** What a body counts as changed, for a row that has to say it in two numbers. */
export function diffCounts(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      if (row.kind === "add") added += 1;
      if (row.kind === "del") removed += 1;
    }
  }
  return { added, removed };
}
