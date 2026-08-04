// One-way window onto the editor's open buffers, for code that must not import
// the editor component.
//
// `CodeEditor` owns the `Map<string, Buffer>` and the single `EditorView`, and
// it is a Solid component: nothing outside its closure can reach either. Three
// things need to, and the first two are about the same awkward object - a
// **background buffer**, which is open, viewless, and can be dirty, so its text
// exists on no disk and in no backstop:
//
//   * the language workspace, which must read a file's real text rather than
//     its stale on-disk copy;
//   * a cross-file rename, which must not save one of those out from under the
//     user without saying so, and must leave the buffer agreeing with the file
//     it just rewrote;
//   * Save-as, in `Editor.tsx`. The pane owns the tabs and the prompt but not a
//     line of text, so it reads the buffer through here, writes it to the new
//     path, and then tells that buffer its file has been rewritten to match -
//     the same two calls a rename makes, for the same reason.
//
// The accessor is registered by the mounted editor and cleared on unmount.
// There is one `CodeEditor` in the app, so this holds one; an unregister that
// arrives after a newer editor registered is ignored rather than clearing it.

export type BufferAccess = {
  /** The editor's text for `path`, or null when no buffer holds it. */
  textOf: (path: string) => string | null;
  /** Whether that buffer differs from what is on disk. False for a path no
   *  buffer holds, which is the honest answer: there is nothing to lose. */
  isDirty: (path: string) => boolean;
  /** Take `text` as this buffer's content *and* its saved baseline, because the
   *  file on disk was just written to match. A no-op for an unopened path. */
  adopt: (path: string, text: string) => void;
};

let access: BufferAccess | null = null;

/** Publish the editor's buffer accessor. Returns the unregister. */
export function setBufferAccess(a: BufferAccess): () => void {
  access = a;
  return () => {
    if (access === a) access = null;
  };
}

/** The editor's text for `path`, or null when no buffer holds it (which
 *  includes "no editor is mounted", the state every non-editor test is in). */
export function liveBufferText(path: string): string | null {
  return access ? access.textOf(path) : null;
}

/** Which of `paths` are open with unsaved edits. */
export function dirtyBuffers(paths: string[]): string[] {
  return access ? paths.filter((p) => access!.isDirty(p)) : [];
}

/** Point an open buffer at text that was just written to its file. */
export function adoptBufferText(path: string, text: string): void {
  access?.adopt(path, text);
}
