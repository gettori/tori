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
//   * The editable search-results buffer, which wants the opposite of `adopt`.
//     A file with unsaved edits must take a write-back **in its buffer**: the
//     disk copy is not what the user is looking at, and writing it would either
//     be reverted by their next save or raise a conflict banner over an edit
//     they just asked for. So `patch` rewrites the lines in place and leaves
//     the buffer dirty, which is what it was.
//
// The accessor is registered by the mounted editor and cleared on unmount.
// There is one `CodeEditor` in the app, so this holds one; an unregister that
// arrives after a newer editor registered is ignored rather than clearing it.

/** One whole-line rewrite. `was` is the guard: the text the caller believes is
 *  on that line, so an edit aimed at a line that has since moved is refused
 *  rather than landing on whatever is there now. */
export type LineEdit = { line: number; was: string; now: string };

/** `stale` means some line no longer reads the way the caller saw it, and
 *  **nothing was written**: a half-applied file is the outcome with no honest
 *  report. `absent` means no buffer holds the path at all. */
export type PatchOutcome = "applied" | "stale" | "absent";

export type BufferAccess = {
  /** The editor's text for `path`, or null when no buffer holds it. */
  textOf: (path: string) => string | null;
  /** Whether that buffer differs from what is on disk. False for a path no
   *  buffer holds, which is the honest answer: there is nothing to lose. */
  isDirty: (path: string) => boolean;
  /** Take `text` as this buffer's content *and* its saved baseline, because the
   *  file on disk was just written to match. A no-op for an unopened path. */
  adopt: (path: string, text: string) => void;
  /** Rewrite whole lines in this buffer, leaving it as dirty as it was: the
   *  file on disk has *not* been written, and this edit is one more the user
   *  still has to save. All or nothing. */
  patch: (path: string, edits: readonly LineEdit[]) => PatchOutcome;
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

/** Rewrite lines inside an open buffer without touching its file. */
export function patchBuffer(path: string, edits: readonly LineEdit[]): PatchOutcome {
  return access ? access.patch(path, edits) : "absent";
}
