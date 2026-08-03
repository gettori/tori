// One-way window onto the editor's open buffers, for code that must not import
// the editor component.
//
// `CodeEditor` owns the `Map<string, Buffer>` and the single `EditorView`, and
// it is a Solid component: nothing outside its closure can reach either. The
// language workspace needs exactly one thing from it - what text an open file
// actually holds right now - because a background tab is viewless, can be
// unsaved, and its text exists on no disk. Reading such a file from the
// filesystem answers with a copy the user cannot see.
//
// The reader is registered by the mounted editor and cleared on unmount. There
// is one `CodeEditor` in the app, so this holds one reader; an unregister that
// arrives after a newer editor registered is ignored rather than clearing it.

type Reader = (path: string) => string | null;

let reader: Reader | null = null;

/** Publish the editor's buffer reader. Returns the unregister. */
export function setLiveBufferReader(fn: Reader): () => void {
  reader = fn;
  return () => {
    if (reader === fn) reader = null;
  };
}

/** The editor's text for `path`, or null when no buffer holds it (which
 *  includes "no editor is mounted", the state every non-editor test is in). */
export function liveBufferText(path: string): string | null {
  return reader ? reader(path) : null;
}
