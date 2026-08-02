// Groups a raw unified-diff string (as returned by `git_diff_text`) into
// per-hunk blocks, so the review/session diff panels can hang a "comment on
// this hunk" affordance off each `@@` header instead of rendering one flat
// list of CSS-classed lines.
export type DiffHunk = {
  header: string;
  // 1-based new-file line range this hunk covers (the "+" side of the
  // header), matching the coordinates the editor/gutter already use.
  startLine: number;
  endLine: number;
  // 1-based old-file line the hunk starts at (the "-" side). The two sides are
  // separate numberings and stop agreeing as soon as anything above the hunk
  // changed, so a comment on a removed line has to be anchored in this one.
  oldStart: number;
  // The hunk's own lines, header excluded.
  lines: string[];
};

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  // Drop the empty element a trailing newline leaves behind, so a hunk's body
  // matches Rust's `str::lines()` exactly. The backend re-derives each hunk's
  // fingerprint with that parser before staging it, so an extra phantom line
  // here would make every *last* hunk fail to stage, and only the last one.
  const lines = diffText.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      const oldStart = parseInt(m[1], 10);
      const start = parseInt(m[2], 10);
      const count = m[3] !== undefined ? parseInt(m[3], 10) : 1;
      current = {
        header: line,
        startLine: start,
        endLine: count > 0 ? start + count - 1 : start,
        oldStart,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return hunks;
}
