// The editable search-results buffer, as a document.
//
// One buffer holds every match in the project, and editing a result line writes
// that line back to the file it came from. The whole feature rests on one map:
// **buffer line -> (file, source line)**. Everything here exists to keep that
// map true.
//
// Two rules keep it true, and they are the reason this is a model rather than a
// rendered string:
//
//   * **The line count never changes.** A result row is addressed by its index,
//     so splitting or deleting one would shift every row below it onto the wrong
//     source line, silently, and the buffer would go on looking correct. It is
//     refused at the buffer (`guardEdits`) and refused again at the write
//     (`apply_line_edits`), because a map nobody can see is not a thing to trust
//     to one guard.
//   * **Only a result's own text is editable.** The `path:line` prefix is what
//     the map is *made of*; letting it be typed over would let the buffer claim
//     an edit belongs to a line it was never read from.
//
// After an apply, a file that landed is locked and re-anchored: its rows now
// describe what is on disk, so a second apply has nothing to say about it. A
// file that refused stays editable and keeps the text the search saw, which is
// what it will be compared against next time.

// CodeMirror appears here as **types only**, deliberately. The Search panel is
// on the eager path and reaches this module through `searchResultsStore`, so a
// value import would pull the library into the main chunk and undo the lazy
// edge `Editor.tsx` keeps around it. The one extension this needs lives beside
// the view instead, in `SearchResultsBuffer.tsx`.
import type { ChangeSet, EditorState, Text } from "@codemirror/state";

/** One match, as `grep_project` reports it: a root-relative path, a 1-based
 *  line, and that line's text. */
export type ResultMatch = { path: string; line: number; text: string };

/** One buffer line. `note` is chrome (the headline, the blank separators),
 *  `file` is a group header, `match` is the only editable kind. */
export type Row =
  | { kind: "note"; text: string }
  | { kind: "file"; file: string }
  | { kind: "match"; file: string; line: number; original: string };

/** What became of a file at the last apply. `applied` covers both landings: on
 *  disk, and in an open buffer that still has to be saved. Either way this
 *  buffer has said what it had to say about that file. */
export type Mark = { state: "applied" | "refused"; note: string };

export type SearchDoc = {
  /** Absolute workspace root. The rows' paths are relative to it. */
  root: string;
  query: string;
  rows: Row[];
  /** Width of the line-number column, so the read-only prefix is one length for
   *  the whole document and the numbers line up under each other. */
  width: number;
  marks: Record<string, Mark>;
};

/** Edits to one file, in the shape `apply_line_edits` takes. `was` is the guard:
 *  a line that no longer reads that way refuses its whole file. */
export type FileEdits = { path: string; edits: { line: number; was: string; now: string }[] };

export type ApplyOutcome = {
  /** Files written to disk. */
  written: string[];
  /** Files whose edit went into an open buffer instead, which is still unsaved. */
  inBuffer: string[];
  refused: { file: string; reason: string }[];
};

export const LINE_COUNT_REFUSAL =
  "A result line cannot be added or removed here - edit its text in place.";
export const REGION_REFUSAL = "Only a result's own text is editable here.";
export function appliedRefusal(file: string): string {
  return `${file} has already been written back.`;
}

/** Characters before a match row's editable text: the line number, right
 *  aligned, then `: `. */
export function prefixLen(doc: SearchDoc): number {
  return doc.width + 2;
}

/** Build the document for one result set. Files keep the order the backend
 *  reported them in, which is the order the panel shows. */
export function buildSearchDoc(root: string, query: string, matches: ResultMatch[]): SearchDoc {
  const order: string[] = [];
  const byFile = new Map<string, ResultMatch[]>();
  for (const m of matches) {
    if (!byFile.has(m.path)) {
      order.push(m.path);
      byFile.set(m.path, []);
    }
    byFile.get(m.path)!.push(m);
  }
  const width = matches.reduce((w, m) => Math.max(w, String(m.line).length), 1);

  const rows: Row[] = [
    { kind: "note", text: headline(query, matches.length, order.length) },
    {
      kind: "note",
      text: "Edit a result's text, then apply to write it back. Lines cannot be added or removed.",
    },
  ];
  for (const file of order) {
    rows.push({ kind: "note", text: "" });
    rows.push({ kind: "file", file });
    for (const m of byFile.get(file)!) {
      rows.push({ kind: "match", file, line: m.line, original: m.text });
    }
  }
  return { root, query, rows, width, marks: {} };
}

function headline(query: string, matches: number, files: number): string {
  if (!matches) return `No matches for "${query}"`;
  return `${plural(matches, "match", "matches")} in ${plural(files, "file")} for "${query}"`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The document as it should read now.
 *
 * `current` is the buffer's own lines, when there are any: a match row renders
 * the text the user has typed rather than the text it was built with, so a
 * re-render after an apply repaints the headers without reverting an edit.
 */
export function renderLines(doc: SearchDoc, current?: readonly string[]): string[] {
  const pad = prefixLen(doc) - 2;
  return doc.rows.map((row, i) => {
    if (row.kind === "note") return row.text;
    if (row.kind === "file") {
      const mark = doc.marks[row.file];
      return mark ? `${row.file}  ${mark.note}` : row.file;
    }
    const text = current ? textAt(doc, current, i) : row.original;
    return `${String(row.line).padStart(pad)}: ${text ?? row.original}`;
  });
}

/** A match row's editable text, read out of the buffer's lines. Null for a row
 *  that is not a match, or a line the buffer does not have. */
export function textAt(doc: SearchDoc, lines: readonly string[], i: number): string | null {
  const row = doc.rows[i];
  if (row?.kind !== "match") return null;
  const line = lines[i];
  return line === undefined ? null : line.slice(prefixLen(doc));
}

/**
 * What the buffer is asking to write, grouped by file in row order.
 *
 * A row whose text is untouched contributes nothing, so applying twice in a row
 * writes nothing the second time. A file already applied contributes nothing
 * either: its rows were re-anchored, and it is locked besides.
 */
export function collectEdits(doc: SearchDoc, lines: readonly string[]): FileEdits[] {
  const order: string[] = [];
  const byFile = new Map<string, FileEdits["edits"]>();
  doc.rows.forEach((row, i) => {
    if (row.kind !== "match" || doc.marks[row.file]?.state === "applied") return;
    const now = textAt(doc, lines, i);
    if (now === null || now === row.original) return;
    if (!byFile.has(row.file)) {
      order.push(row.file);
      byFile.set(row.file, []);
    }
    byFile.get(row.file)!.push({ line: row.line, was: row.original, now });
  });
  return order.map((path) => ({ path, edits: byFile.get(path)! }));
}

/**
 * Why this change cannot be made, or null when it can.
 *
 * Every reason is a way of breaking the line map: a change that spans a line
 * break moves rows, an insertion carrying one adds them, and a change reaching
 * into a prefix or a header rewrites the map's own text.
 */
export function refusalFor(doc: SearchDoc, before: EditorState, changes: ChangeSet): string | null {
  let why: string | null = null;
  changes.iterChanges((fromA: number, toA: number, _fromB: number, _toB: number, inserted: Text) => {
    if (why) return;
    const line = before.doc.lineAt(fromA);
    if (inserted.lines > 1 || toA > line.to) {
      why = LINE_COUNT_REFUSAL;
      return;
    }
    const row = doc.rows[line.number - 1];
    if (row?.kind !== "match") {
      why = REGION_REFUSAL;
      return;
    }
    if (doc.marks[row.file]?.state === "applied") {
      why = appliedRefusal(row.file);
      return;
    }
    if (fromA < line.from + prefixLen(doc)) why = REGION_REFUSAL;
  });
  return why;
}

/**
 * Fold an apply's outcome back into the document.
 *
 * An applied file is re-anchored to what was just written and locked, so it
 * cannot be written twice and a second apply has nothing left to say about it.
 * A refused file keeps the text the search saw: that is what its next attempt
 * will be compared against, and replacing it with the edit would make the guard
 * agree with itself instead of with the file.
 */
export function settle(doc: SearchDoc, lines: readonly string[], out: ApplyOutcome): SearchDoc {
  const marks: Record<string, Mark> = { ...doc.marks };
  for (const file of out.written) marks[file] = { state: "applied", note: "written back" };
  for (const file of out.inBuffer) {
    marks[file] = { state: "applied", note: "applied in the open buffer, not saved yet" };
  }
  for (const r of out.refused) marks[r.file] = { state: "refused", note: `refused: ${r.reason}` };

  const landed = new Set([...out.written, ...out.inBuffer]);
  const rows = doc.rows.map((row, i) => {
    if (row.kind !== "match" || !landed.has(row.file)) return row;
    const now = textAt(doc, lines, i);
    return now === null ? row : { ...row, original: now };
  });
  return { ...doc, rows, marks };
}

/** One line saying where an apply's edits went. */
export function describeApply(out: ApplyOutcome): string {
  const parts: string[] = [];
  if (out.written.length) parts.push(`Wrote ${plural(out.written.length, "file")}.`);
  if (out.inBuffer.length) {
    parts.push(`${plural(out.inBuffer.length, "file")} took the edit in an open buffer, still unsaved.`);
  }
  for (const r of out.refused) parts.push(`Refused ${r.file}: ${r.reason}.`);
  return parts.join(" ") || "Nothing to write.";
}
