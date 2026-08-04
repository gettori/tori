import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
// Source text, to check the eager-path rule below the way `commands.test.ts`
// checks its own import rule.
import docSource from "./searchResultsDoc.ts?raw";
import storeSource from "./searchResultsStore.ts?raw";
import {
  LINE_COUNT_REFUSAL,
  REGION_REFUSAL,
  appliedRefusal,
  buildSearchDoc,
  collectEdits,
  describeApply,
  prefixLen,
  refusalFor,
  renderLines,
  settle,
  textAt,
  type ResultMatch,
  type SearchDoc,
} from "./searchResultsDoc";

// The line map is the whole feature: every row in this buffer claims to be one
// line of one file, and an edit is written back at that claim's word. So what
// is pinned here is the claim surviving the things that could quietly break it
// - an edit that changes a line's length, a line count that moves, a write that
// half succeeds - rather than the wording of the document it renders.

const ROOT = "/space/proj";
const MATCHES: ResultMatch[] = [
  { path: "src/a.ts", line: 12, text: "const needle = 1" },
  { path: "src/a.ts", line: 400, text: "  needle()" },
  { path: "src/b.ts", line: 7, text: "needle" },
];

const doc = () => buildSearchDoc(ROOT, "needle", MATCHES);
const lines = (d: SearchDoc) => renderLines(d);

/** The buffer's lines with one match row retyped. */
function typed(d: SearchDoc, i: number, text: string): string[] {
  const out = lines(d);
  out[i] = out[i].slice(0, prefixLen(d)) + text;
  return out;
}

describe("building the document", () => {
  it("puts each match under its file, in the order the search reported", () => {
    expect(lines(doc())).toEqual([
      '3 matches in 2 files for "needle"',
      "Edit a result's text, then apply to write it back. Lines cannot be added or removed.",
      "",
      "src/a.ts",
      " 12: const needle = 1",
      "400:   needle()",
      "",
      "src/b.ts",
      "  7: needle",
    ]);
  });

  it("sizes the line-number column once for the whole document", () => {
    // One width, not one per file: a column of numbers that steps in and out
    // between groups is harder to read than a wider one, and the prefix has to
    // be a single length for the guard to be stated in one sentence.
    const d = doc();
    expect(prefixLen(d)).toBe(5);
    expect(lines(d)[4].slice(0, 5)).toBe(" 12: ");
    expect(lines(d)[8].slice(0, 5)).toBe("  7: ");
  });
});

describe("reading edits back out", () => {
  it("finds nothing when nothing was typed", () => {
    expect(collectEdits(doc(), lines(doc()))).toEqual([]);
  });

  it("survives an edit that changes the line's length", () => {
    // The row's text is read by its offset from the start of the line, so a
    // longer or shorter replacement moves every character after it. If the map
    // were positional this is where it would break.
    const d = doc();
    const edited = typed(d, 5, "  pin(1, 2, 3)");
    expect(textAt(d, edited, 5)).toBe("  pin(1, 2, 3)");
    expect(collectEdits(d, edited)).toEqual([
      { path: "src/a.ts", edits: [{ line: 400, was: "  needle()", now: "  pin(1, 2, 3)" }] },
    ]);
  });

  it("groups one file's edits together and keeps the files in row order", () => {
    let edited = typed(doc(), 4, "const pin = 1");
    edited = [...edited];
    edited[8] = edited[8].slice(0, 5) + "pin";
    edited[5] = edited[5].slice(0, 5) + "  pin()";
    expect(collectEdits(doc(), edited)).toEqual([
      {
        path: "src/a.ts",
        edits: [
          { line: 12, was: "const needle = 1", now: "const pin = 1" },
          { line: 400, was: "  needle()", now: "  pin()" },
        ],
      },
      { path: "src/b.ts", edits: [{ line: 7, was: "needle", now: "pin" }] },
    ]);
  });
});

describe("what the buffer refuses", () => {
  /** Offset of a column on a 0-based buffer line. */
  const at = (d: SearchDoc, i: number, col = 0) =>
    lines(d)
      .slice(0, i)
      .reduce((n, l) => n + l.length + 1, 0) + col;

  /** Why this change would be refused, put through the same pair a transaction
   *  filter is handed: the state before it, and the changes themselves. */
  function refusal(d: SearchDoc, spec: { from: number; to?: number; insert?: string }) {
    const before = EditorState.create({ doc: lines(d).join("\n") });
    return refusalFor(d, before, before.update({ changes: spec }).changes);
  }

  it("refuses an insertion that would add a line", () => {
    const d = doc();
    expect(refusal(d, { from: at(d, 4, 8), insert: "\nmore" })).toBe(LINE_COUNT_REFUSAL);
  });

  it("refuses a deletion that would swallow a line break", () => {
    // The backspace-at-the-start-of-a-line case, which is how a results buffer
    // actually loses a row: one keystroke, and every row below it now names a
    // line one further down than the one it is showing.
    const d = doc();
    expect(refusal(d, { from: at(d, 5) - 1, to: at(d, 5) })).toBe(LINE_COUNT_REFUSAL);
  });

  it("refuses a change to the line number a row is addressed by", () => {
    const d = doc();
    expect(refusal(d, { from: at(d, 4, 1), to: at(d, 4, 3), insert: "99" })).toBe(REGION_REFUSAL);
  });

  it("refuses a change to a file header or to the headline", () => {
    const d = doc();
    expect(refusal(d, { from: at(d, 3), insert: "x" })).toBe(REGION_REFUSAL);
    expect(refusal(d, { from: at(d, 0), insert: "x" })).toBe(REGION_REFUSAL);
  });

  it("allows an edit that starts exactly where a row's text does", () => {
    const d = doc();
    expect(refusal(d, { from: at(d, 4, 5), insert: "let " })).toBeNull();
  });

  it("refuses an edit to a file that has already been written back", () => {
    const d = settle(doc(), lines(doc()), { written: ["src/a.ts"], inBuffer: [], refused: [] });
    expect(refusal(d, { from: at(d, 4, 6), insert: "x" })).toBe(appliedRefusal("src/a.ts"));
  });
});

describe("settling an apply", () => {
  const edited = () => {
    let out = typed(doc(), 4, "const pin = 1");
    out = [...out];
    out[8] = out[8].slice(0, 5) + "pin";
    return out;
  };

  it("re-anchors what landed, so applying twice writes it once", () => {
    const d = doc();
    const after = settle(d, edited(), { written: ["src/a.ts"], inBuffer: [], refused: [] });
    expect(collectEdits(after, edited()).map((f) => f.path)).toEqual(["src/b.ts"]);
  });

  it("marks the applied file read-only and the refused one with its reason", () => {
    const d = doc();
    const after = settle(d, edited(), {
      written: ["src/a.ts"],
      inBuffer: [],
      refused: [{ file: "src/b.ts", reason: "changed since the search" }],
    });
    const shown = renderLines(after, edited());
    expect(shown[3]).toBe("src/a.ts  written back");
    expect(shown[7]).toBe("src/b.ts  refused: changed since the search");
    // The rows themselves are untouched: the edit is still on screen, in both
    // files. What changed is which of them is still asking to be written.
    expect(shown[4]).toBe(" 12: const pin = 1");
    expect(shown[8]).toBe("  7: pin");
  });

  it("keeps a refused file's original text as what its retry is compared against", () => {
    // The file refused *because* its line moved on disk. Adopting the edit as
    // the new original would make the next attempt compare the buffer against
    // itself and write at an offset nobody has agreed on.
    const after = settle(doc(), edited(), {
      written: [],
      inBuffer: [],
      refused: [{ file: "src/b.ts", reason: "changed since the search" }],
    });
    expect(collectEdits(after, edited())).toEqual([
      { path: "src/a.ts", edits: [{ line: 12, was: "const needle = 1", now: "const pin = 1" }] },
      { path: "src/b.ts", edits: [{ line: 7, was: "needle", now: "pin" }] },
    ]);
  });

  it("treats an edit taken by an open buffer as landed, and says it is unsaved", () => {
    const after = settle(doc(), edited(), { written: [], inBuffer: ["src/a.ts"], refused: [] });
    expect(renderLines(after, edited())[3]).toBe(
      "src/a.ts  applied in the open buffer, not saved yet",
    );
    expect(collectEdits(after, edited()).map((f) => f.path)).toEqual(["src/b.ts"]);
  });
});

describe("staying off the eager path", () => {
  it("names CodeMirror only as a type, in both modules the Search panel reaches", () => {
    // The panel is imported statically by the Editor, so anything it can reach
    // lands in the main chunk. `Editor.tsx` keeps CodeMirror behind a lazy edge
    // worth ~1.3 MB, and one forgotten `import {` here would undo it silently:
    // nothing else in the suite would fail.
    for (const [name, source] of [
      ["searchResultsDoc", docSource],
      ["searchResultsStore", storeSource],
    ] as const) {
      // Anchored at the start of a line: these modules' comments talk about
      // importing, and a floating `import` would match the prose and then run
      // on to the next real `from`.
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)];
      expect(imports.length, `${name}: no imports found, so this proves nothing`).toBeGreaterThan(0);
      const values = imports.filter(([, isType, from]) => from.startsWith("@codemirror/") && !isType);
      expect(values.map((m) => m[2]), `${name} must import CodeMirror as types only`).toEqual([]);
    }
  });
});

describe("saying what happened", () => {
  it("names every file it refused, and counts the rest", () => {
    expect(
      describeApply({
        written: ["a.ts", "b.ts"],
        inBuffer: ["c.ts"],
        refused: [{ file: "d.ts", reason: "changed since the search" }],
      }),
    ).toBe(
      "Wrote 2 files. 1 file took the edit in an open buffer, still unsaved. Refused d.ts: changed since the search.",
    );
  });

  it("has something to say when nothing happened at all", () => {
    expect(describeApply({ written: [], inBuffer: [], refused: [] })).toBe("Nothing to write.");
  });
});
