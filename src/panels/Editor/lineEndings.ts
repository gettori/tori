// Which line ending a file uses, and what that file becomes in a buffer.
//
// CodeMirror stores a document as an array of lines with no separator in it, so
// the ending is not data, it is a *setting*: `EditorState.lineSeparator` decides
// what `state.sliceDoc()` joins them back with. Get that setting wrong and the
// file is silently rewritten the first time it is saved. Get it right and forget
// to ask for it (`doc.toString()` hard-codes "\n") and every comparison against
// the disk text disagrees, which is the bug #43 is named after.
//
// Editor-side, but CodeMirror-free on purpose: this is string arithmetic, and
// keeping it out of the pane is what lets the node test project cover it.

/** The two endings a file is read back with. A lone "\r" (pre-OS X Mac) is still
 *  split on, so such a file opens with the right lines, but it is normalized to
 *  "\n" rather than given a third case: nothing has written one this century,
 *  and a branch with no files behind it is a branch nothing keeps correct. */
export type Eol = "\r\n" | "\n";

/** Every break form a file can arrive with. Deliberately the same expression
 *  CodeMirror splits a document with when no separator is configured, so the
 *  line count never depends on which of the two did the splitting. */
const ANY_BREAK = /\r\n?|\n/;

/**
 * The ending this text mostly uses, or "\n" when it has no breaks at all.
 *
 * Counted rather than sampled from the first break: a mixed file is real (a
 * patch applied by a tool that did not care, a hand-edited fixture), and one
 * stray ending at the top should not decide how the other nine hundred are
 * written back. One pass, and no array of every break in the file.
 */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let plain = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10 /* \n */) {
        crlf++;
        i++;
      } else plain++;
    } else if (c === 10) plain++;
  }
  return crlf > plain ? "\r\n" : "\n";
}

/** A file as the editor holds it: `lines` builds the document, `eol` configures
 *  the separator, `text` is what the buffer reads back as. Named rather than
 *  inferred at each signature, because it is the one shape the pane passes
 *  around for a file. */
export type DiskText = { eol: Eol; lines: string[]; text: string };

/**
 * What a file just read from disk becomes in a buffer.
 *
 * `lines` builds the document, `eol` configures the separator, and `text` is
 * what the buffer will read back as, which is the value every dirty check and
 * external-change comparison has to be made against. All three are derived here
 * together so they cannot drift: a caller holding the disk string and the
 * buffer's ending separately would have to re-derive the third, and the whole
 * of #43 was two answers to that question disagreeing.
 *
 * A file whose endings are mixed is normalized to its dominant one, which is
 * what makes `text` an honest baseline. That does rewrite the odd stray ending
 * on the next save, and it is the intended trade: the alternative is a buffer
 * that can never be reported clean.
 */
export function fromDisk(disk: string): DiskText {
  const eol = detectEol(disk);
  const lines = disk.split(ANY_BREAK);
  return { eol, lines, text: lines.join(eol) };
}
