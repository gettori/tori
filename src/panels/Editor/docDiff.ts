// The change that turns one document into another, when all that is known is
// the before and the after.
//
// Two callers, both for the same reason and neither of which can use a
// whole-document replacement:
//
//   * the language workspace, when a file changed outside any editor.
//     `WorkspaceMapping` maps positions *through* these changes, and a full
//     replace collapses every position in the file to zero, so a rename
//     spanning a file an agent touched mid-operation would aim every edit at
//     offset 0.
//   * format-on-save, which hands the formatter's output back to a live view.
//     A full replace maps the caret to the end of the change, so saving would
//     move the cursor off whatever line it was on, on every save.
//
// Trimming the matching prefix and suffix leaves everything outside the region
// that actually moved mapping to itself, which is what both of those want.

import { ChangeSet, Text } from "@codemirror/state";

const LOW_SURROGATE = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const HIGH_SURROGATE = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** A CodeMirror document from a plain string, splitting on any line ending a
 *  file can arrive with. Lives beside `diffChanges` because every caller of one
 *  needs the other: they have text and want the change that reaches it.
 *
 *  Not `docOf`: `CodeEditor` already has one of those, and it answers a
 *  different question (a path's text, not a string's document). */
export function toDoc(text: string): Text {
  return Text.of(text.split(/\r\n?|\n/));
}

/** The minimal single-range change from `from` to `to`. */
export function diffChanges(from: Text, to: Text): ChangeSet {
  const a = from.toString();
  const b = to.toString();
  const shortest = Math.min(a.length, b.length);
  let start = 0;
  while (start < shortest && a.charCodeAt(start) === b.charCodeAt(start)) start += 1;
  // Never cut a surrogate pair in half: the halves are separate code units but
  // one character, and splitting one produces a document CodeMirror cannot hold.
  if (start > 0 && LOW_SURROGATE(a.charCodeAt(start)) && HIGH_SURROGATE(a.charCodeAt(start - 1))) {
    start -= 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA -= 1;
    endB -= 1;
  }
  if (endA < a.length && HIGH_SURROGATE(a.charCodeAt(endA - 1)) && LOW_SURROGATE(a.charCodeAt(endA))) {
    endA += 1;
    endB += 1;
  }
  return ChangeSet.of({ from: start, to: endA, insert: b.slice(start, endB) }, a.length);
}
