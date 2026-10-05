// What a save writes when the project has a formatter.
//
// The interesting part is not running the formatter, it is the race around it.
// Formatting is a subprocess: node starts, the file is parsed, output comes
// back, and a fast typist puts several characters into the buffer while that
// happens. Those characters are in no formatter output, so applying the result
// afterwards deletes work the user just did - silently, as part of a save they
// asked for.
//
// CodeMirror has no document version counter to compare, but `Text` is
// immutable: every change produces a new instance, so the *identity* of
// `state.doc` is the available handle on "is this still the document I sent?".
// The library's own `formatDocument` guards exactly this way
// (`lsp-client/dist/index.js:1132-1135`); an out-of-band CLI path has nothing
// equivalent unless it is written here.
//
// Injected rather than reaching for the view, because every decision below is
// about somebody's unsaved keystrokes and none of them should need CodeMirror
// standing up to test.

/** `format_document`'s reply. `text` is always safe to write: the formatter's
 *  output on success, the input unchanged in every other case. */
export type FormatResult = {
  text: string;
  /** Which formatter ran. Null means the project has none, which is the signal
   *  to fall back to the language server's own formatting. */
  formatter: string | null;
  /** What a detected formatter said when it refused. */
  error: string | null;
};

/** The buffer at one moment. `id` is `state.doc`, held only to be compared by
 *  identity - nothing here reads it. */
export type Snapshot = { text: string; id: unknown };

export type FormatDeps = {
  format: (path: string, text: string) => Promise<FormatResult>;
  /** That file's buffer as it is now, or null when it is no longer open at
   *  all. Called again after the formatter returns, which is the whole point.
   *
   *  Takes the path rather than answering about whatever is on screen: a save
   *  can outlive the tab being on screen, and answering with the buffer the
   *  user switched *to* would have that file's text written into this one. */
  current: (path: string) => Snapshot | null;
  report: (message: string) => void;
};

/** `formatter` rides along on both outcomes because the manual command's
 *  fallback turns on it: null means the project has none, so the language
 *  server's formatting is the right thing to try next. Without it the caller
 *  would have to ask a second time to find out. */
export type SaveText =
  /** Write this, and leave the buffer alone. */
  | { kind: "unchanged"; text: string; formatter: string | null }
  /** Put this into the buffer, then write it. */
  | { kind: "formatted"; text: string; formatter: string }
  /** The file was closed mid-format; there is nothing to save. Not the same as
   *  it merely leaving the screen: a background buffer still has text, and a
   *  save the user asked for still has to land. */
  | { kind: "gone" };

/**
 * Decide what a save should write, running the project's formatter first.
 *
 * Never throws and never returns half a file: every refusal ends in the text
 * the caller already had, because the failure that matters here is a save that
 * writes something the user did not type.
 *
 * A formatter's complaint is reported even when the result is discarded. It is
 * usually a syntax error at a line number, which is the one useful thing to
 * know about a save that did not format.
 */
export async function formatForSave(deps: FormatDeps, path: string, before: Snapshot): Promise<SaveText> {
  let result: FormatResult;
  try {
    result = await deps.format(path, before.text);
  } catch (e) {
    // The command itself failed (the backend is gone, the argument was
    // rejected). Not the formatter refusing, so there is nothing to quote.
    deps.report(`Could not format: ${String(e)}`);
    result = { text: before.text, formatter: null, error: null };
  }

  const now = deps.current(path);
  if (!now) return { kind: "gone" };
  if (result.error) deps.report(result.error);
  const formatter = result.formatter;

  // Typed into while the formatter ran. Its output describes a document that no
  // longer exists, so it is dropped and what is on screen is what gets saved -
  // including a same-length edit, which is why this compares identity and not
  // the text.
  if (now.id !== before.id) return { kind: "unchanged", text: now.text, formatter };

  if (!formatter || result.error) return { kind: "unchanged", text: before.text, formatter };
  if (result.text === before.text) return { kind: "unchanged", text: before.text, formatter };
  return { kind: "formatted", text: result.text, formatter };
}
