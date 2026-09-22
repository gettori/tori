// The whitespace a save tidies, as changes rather than as tidied text: the
// caret can sit in the run of spaces being dropped, and `diffChanges` would
// hand one replacement the whole span from there to the end of the file.
import type { Text } from "@codemirror/state";
import type { EditorDefaults } from "../Settings/settingsStore";

export type WhitespaceEdit = { from: number; to: number; insert?: string };

export function whitespaceEdits(
  doc: Text,
  prefs: Pick<EditorDefaults, "trimTrailingWhitespace" | "insertFinalNewline">,
  eol: string,
): WhitespaceEdit[] {
  const edits: WhitespaceEdit[] = [];
  // A line the trim is about to empty counts as blank, or the two rules would
  // disagree about where the file ends.
  const blank = (text: string) => (prefs.trimTrailingWhitespace ? /^[ \t]*$/.test(text) : text === "");
  let end = doc.lines;
  if (prefs.insertFinalNewline) while (end > 0 && blank(doc.line(end).text)) end -= 1;
  // Nothing to anchor a final break to (an empty file, or nothing but blank
  // lines), so that half is left alone.
  const tail = prefs.insertFinalNewline && end > 0 && doc.length !== doc.line(end).to + 1;
  if (prefs.trimTrailingWhitespace) {
    // Only as far as the break being written: past it the tail edit below
    // removes those lines outright, and two changes over one range cannot be
    // dispatched together.
    for (let n = 1; n <= (tail ? end : doc.lines); n += 1) {
      const line = doc.line(n);
      const kept = line.text.replace(/[ \t]+$/, "").length;
      if (kept !== line.text.length) edits.push({ from: line.from + kept, to: line.to });
    }
  }
  if (tail) {
    // `eol` rather than "\n": an inserted string is split by this buffer's own
    // separator, so a CRLF file would keep the "\n" as a character to draw.
    edits.push({ from: doc.line(end).to, to: doc.length, insert: eol });
  }
  return edits;
}
