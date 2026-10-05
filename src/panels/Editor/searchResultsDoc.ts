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

/** One match, as `grep_project` reports it, tagged with the member root it was
 *  found under: a root-relative path, a 1-based line, and that line's text. */
export type ResultMatch = {
  root: string;
  path: string;
  line: number;
  text: string;
  submatches?: [number, number][];
};

/** One member the document covers: the absolute root its rows write into, and
 *  the name a header row shows. */
export type DocRoot = { root: string; label: string };

/** One file the document has something to say about. A bare relative path is
 *  not an identity here: two members of a Topic routinely hold the same
 *  `src/index.ts`, and one of them is not the other. */
export type DocFile = { root: string; file: string };

/** One buffer line. `note` is chrome (the headline, the blank separators),
 *  `member` and `file` are group headers, `context` is a line around a hit, and
 *  `match` is the only editable kind. */
export type Row =
  | { kind: "note"; text: string }
  | { kind: "member"; label: string }
  | { kind: "file"; root: string; file: string }
  | { kind: "context"; root: string; file: string; line: number; text: string }
  | {
      kind: "match";
      root: string;
      file: string;
      line: number;
      original: string;
      spans?: [number, number][];
    };

/** Lines around each hit: how many, and each file's text split into lines
 *  (null for one that could not be read). */
export type DocContext = { lines: number; textOf: (root: string, file: string) => readonly string[] | null };

/** What became of a file at the last apply. `applied` covers both landings: on
 *  disk, and in an open buffer that still has to be saved. Either way this
 *  buffer has said what it had to say about that file. */
export type Mark = { state: "applied" | "refused"; note: string };

export type SearchDoc = {
  /** Every member the rows resolve against, in the order they appear. One
   *  buffer spans a Topic, so this is a list rather than the single root it
   *  was: a row writes into *its own* member, not into the document's. */
  roots: DocRoot[];
  query: string;
  rows: Row[];
  /** Width of the line-number column, so the read-only prefix is one length for
   *  the whole document and the numbers line up under each other. */
  width: number;
  /** Keyed by `markKey`, i.e. on the member as well as the path. */
  marks: Record<string, Mark>;
};

/** Edits to one file, in the shape `apply_line_edits` takes plus the root it
 *  goes to. `was` is the guard: a line that no longer reads that way refuses
 *  its whole file. */
export type FileEdits = {
  root: string;
  path: string;
  edits: { line: number; was: string; now: string }[];
};

export type ApplyOutcome = {
  /** Files written to disk. */
  written: DocFile[];
  /** Files whose edit went into an open buffer instead, which is still unsaved. */
  inBuffer: DocFile[];
  refused: (DocFile & { reason: string })[];
};

/** The separator a file key is joined on, named rather than inlined because a
 *  raw NUL in a source file is invisible: one that reached a template literal
 *  in `SearchPanel` type-checked and passed every test. */
const NUL = "\u0000";

/** How a file is addressed everywhere in this module. Joined on a character no
 *  root and no relative path can hold, so two members' `src/index.ts` can never
 *  spell the same key. */
function markKey(root: string, file: string): string {
  return `${root}${NUL}${file}`;
}

export const LINE_COUNT_REFUSAL = "A result line cannot be added or removed here - edit its text in place.";
export const REGION_REFUSAL = "Only a result's own text is editable here.";
export function appliedRefusal(file: string): string {
  return `${file} has already been written back.`;
}

/** Characters before a match row's editable text: the line number, right
 *  aligned, then `: `. */
export function prefixLen(doc: SearchDoc): number {
  return doc.width + 2;
}

/**
 * Build the document for one result set.
 *
 * Members and files both keep the order the panel showed them in, which is the
 * order the fan-out reported. `roots` supplies the header labels and nothing
 * else: a member with no hits is not part of this document.
 */
export function buildSearchDoc(
  roots: readonly DocRoot[],
  query: string,
  matches: ResultMatch[],
  context?: DocContext,
): SearchDoc {
  const order: DocFile[] = [];
  const byFile = new Map<string, ResultMatch[]>();
  for (const m of matches) {
    const key = markKey(m.root, m.path);
    if (!byFile.has(key)) {
      order.push({ root: m.root, file: m.path });
      byFile.set(key, []);
    }
    byFile.get(key)!.push(m);
  }
  let widest = matches.reduce((w, m) => Math.max(w, m.line), 1);
  const labelOf = (root: string) => roots.find((r) => r.root === root)?.label || root;
  const covered = [...new Set(order.map((o) => o.root))];

  const rows: Row[] = [
    { kind: "note", text: headline(query, matches.length, order.length) },
    {
      kind: "note",
      text: "Edit a result's text, then apply to write it back. Lines cannot be added or removed.",
    },
  ];
  let member: string | null = null;
  for (const { root, file } of order) {
    rows.push({ kind: "note", text: "" });
    // Only where a reader could otherwise not tell which repo a row writes
    // into. Over a single member the header names what every row already is.
    if (covered.length > 1 && root !== member) rows.push({ kind: "member", label: labelOf(root) });
    member = root;
    rows.push({ kind: "file", root, file });
    const hits = byFile.get(markKey(root, file))!;
    const text = context && context.lines > 0 ? context.textOf(root, file) : null;
    if (!text) {
      for (const m of hits) rows.push(matchRow(m));
      continue;
    }
    const byLine = new Map(hits.map((m) => [m.line, m]));
    const shown = new Set<number>();
    for (const m of hits) {
      for (let l = Math.max(1, m.line - context!.lines); l <= Math.min(text.length, m.line + context!.lines); l++) {
        shown.add(l);
      }
      shown.add(m.line);
    }
    for (const l of [...shown].sort((a, b) => a - b)) {
      const m = byLine.get(l);
      rows.push(m ? matchRow(m) : { kind: "context", root, file, line: l, text: text[l - 1] ?? "" });
      widest = Math.max(widest, l);
    }
  }
  return {
    roots: covered.map((root) => ({ root, label: labelOf(root) })),
    query,
    rows,
    width: String(widest).length,
    marks: {},
  };
}

function matchRow(m: ResultMatch): Row {
  return { kind: "match", root: m.root, file: m.path, line: m.line, original: m.text, spans: m.submatches };
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
    // Bracketed so a member cannot be misread as the file header under it: both
    // are bare left-aligned text, and the two mean different things.
    if (row.kind === "member") return `[${row.label}]`;
    if (row.kind === "file") {
      const mark = doc.marks[markKey(row.root, row.file)];
      return mark ? `${row.file}  ${mark.note}` : row.file;
    }
    // Two spaces where a hit has `: `, VS Code's way of telling them apart.
    if (row.kind === "context") return `${String(row.line).padStart(pad)}  ${row.text}`;
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
  const order: DocFile[] = [];
  const byFile = new Map<string, FileEdits["edits"]>();
  doc.rows.forEach((row, i) => {
    if (row.kind !== "match") return;
    const key = markKey(row.root, row.file);
    if (doc.marks[key]?.state === "applied") return;
    const now = textAt(doc, lines, i);
    if (now === null || now === row.original) return;
    if (!byFile.has(key)) {
      order.push({ root: row.root, file: row.file });
      byFile.set(key, []);
    }
    byFile.get(key)!.push({ line: row.line, was: row.original, now });
  });
  return order.map(({ root, file }) => ({ root, path: file, edits: byFile.get(markKey(root, file))! }));
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
    if (doc.marks[markKey(row.root, row.file)]?.state === "applied") {
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
  const key = (f: DocFile) => markKey(f.root, f.file);
  for (const f of out.written) marks[key(f)] = { state: "applied", note: "written back" };
  for (const f of out.inBuffer) {
    marks[key(f)] = { state: "applied", note: "applied in the open buffer, not saved yet" };
  }
  for (const r of out.refused) marks[key(r)] = { state: "refused", note: `refused: ${r.reason}` };

  const landed = new Set([...out.written, ...out.inBuffer].map(key));
  const rows = doc.rows.map((row, i) => {
    if (row.kind !== "match" || !landed.has(markKey(row.root, row.file))) return row;
    const now = textAt(doc, lines, i);
    return now === null ? row : { ...row, original: now };
  });
  return { ...doc, rows, marks };
}

/** One line saying where an apply's edits went. */
export function describeApply(doc: SearchDoc, out: ApplyOutcome): string {
  const parts: string[] = [];
  if (out.written.length) parts.push(`Wrote ${plural(out.written.length, "file")}.`);
  if (out.inBuffer.length) {
    parts.push(`${plural(out.inBuffer.length, "file")} took the edit in an open buffer, still unsaved.`);
  }
  for (const r of out.refused) parts.push(`Refused ${nameFile(doc, r)}: ${r.reason}.`);
  return parts.join(" ") || "Nothing to write.";
}

/** How a file is named in a message. Qualified by its member only in a document
 *  that spans several, where the path alone names two files. */
function nameFile(doc: SearchDoc, f: DocFile): string {
  if (doc.roots.length < 2) return f.file;
  const label = doc.roots.find((r) => r.root === f.root)?.label;
  return label ? `${f.file} in ${label}` : f.file;
}
