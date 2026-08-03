// Sway's own cross-file rename.
//
// The library ships one, and it cannot work here. `doRename`
// (`lsp-client/dist/index.js:1209`) walks the server's edits and does
// `let file = workspace.getFile(uri); if (!lspChanges.length || !file) continue`
// - synchronously. Every file the user has not already opened is skipped
// without a word, which is every file a rename exists to reach. There is no
// `Workspace` override that fixes it: the check is sync and materialising a
// file is not.
//
// So the order here is the whole point, and it is the order the library cannot
// take:
//
//   1. ask the server for the edit
//   2. **materialise every target file**, awaiting each
//   3. only then construct the `WorkspaceMapping`
//
// A mapping snapshots every open file's document in its constructor and
// `mapPosition` throws for anything absent, so a file materialised after the
// fact is one the mapping cannot answer for. (`SwayWorkspace.joinActiveMappings`
// seeds late arrivals into live mappings, because the library's own
// find-references needs it, but that reaches into another package's internals
// and fails soft. This ordering is what has to hold on its own.)
//
// Everything below the decisions is injected, because every one of them is a
// judgement about someone's unsaved work and none of them should need a running
// editor to test.

import { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { uriToPath } from "./swayWorkspace";

/** An LSP position, and the edits a rename comes back as. */
export type LspPosition = { line: number; character: number };
export type LspTextEdit = { range: { start: LspPosition; end: LspPosition }; newText: string };

/** `textDocument/rename`'s reply. Servers may answer in either shape; this
 *  client advertises no `documentChanges` support so a conformant one uses
 *  `changes`, but reading both costs three lines and the difference between
 *  them is a rename that silently does nothing. */
export type WorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: { textDocument?: { uri?: string }; edits?: LspTextEdit[] }[];
};

/** One file's worth of a rename. */
export type RenameTarget = { uri: string; edits: LspTextEdit[] };

/** Flatten either `WorkspaceEdit` shape into one list, dropping files with
 *  nothing to change so they are neither opened nor written. */
export function editsByUri(edit: WorkspaceEdit | null | undefined): RenameTarget[] {
  const byUri = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: LspTextEdit[]) => {
    const into = byUri.get(uri);
    if (into) into.push(...edits);
    else byUri.set(uri, [...edits]);
  };
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    if (edits?.length) add(uri, edits);
  }
  // A server that sends both would otherwise have its edits applied twice.
  if (!edit?.changes) {
    for (const doc of edit?.documentChanges ?? []) {
      const uri = doc?.textDocument?.uri;
      if (uri && doc.edits?.length) add(uri, doc.edits);
    }
  }
  return [...byUri].map(([uri, edits]) => ({ uri, edits }));
}

/** The workspace file a target resolved to, as this module needs it. */
export type MaterialisedFile = {
  uri: string;
  doc: Text;
  getView: () => EditorView | null;
};

export type Mapping = {
  mapPosition: (uri: string, pos: LspPosition, assoc?: number) => number;
  destroy: () => void;
};

export type RenameDeps = {
  /** `textDocument/rename`. */
  requestRename: (newName: string) => Promise<WorkspaceEdit | null>;
  /** `SwayWorkspace.requestFile`, which reads an open buffer before disk. */
  requestFile: (uri: string) => Promise<MaterialisedFile | null>;
  /** `SwayWorkspace.retainMapping`, so nothing is evicted mid-operation. */
  retainMapping: () => () => void;
  /** `client.workspaceMapping()`. Called only after every file is in. */
  makeMapping: () => Mapping;
  /** Which of these open buffers have unsaved edits. */
  dirtyBuffers: (paths: string[]) => string[];
  /** Point an open buffer at text just written to its file. */
  adoptBufferText: (path: string, text: string) => void;
  /** The batched, all-or-nothing write. */
  writeFiles: (files: { path: string; contents: string }[]) => Promise<string[]>;
  /** Tell the language workspace these files changed. Called for exactly the
   *  paths this rename wrote. */
  notifyWritten: (paths: string[]) => void;
  /** Whether this folder can be backed up at all. */
  backstopAvailable: () => Promise<boolean>;
  /** Snapshot the working tree, returning the timestamp a restore is keyed by. */
  takeBackstop: (label: string) => Promise<number>;
  /** Ask the user, for the one decision that is theirs to make. */
  confirm: (opts: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  dispatch: (view: EditorView, changes: { from: number; to: number; insert: string }[]) => void;
};

export type RenameOutcome =
  | { kind: "empty" }
  | { kind: "aborted"; reason: string }
  | { kind: "applied"; written: string[]; dispatched: string[]; backstopTs: number | null };

/**
 * What to tell the user, or null when the rename speaks for itself.
 *
 * A single-file rename is visible on screen and needs no notice. A multi-file
 * one has to say two things, because both are surprising: files nobody was
 * looking at just changed, and the undo does **not** cover all of them. The
 * file on screen took the rename as an editor change, so a working-tree restore
 * would not touch it - it has its own undo instead.
 */
export function describeRename(outcome: RenameOutcome): { message: string; kind: "error" | "info" } | null {
  if (outcome.kind === "empty") return { message: "Nothing to rename here.", kind: "info" };
  if (outcome.kind === "aborted") return { message: outcome.reason, kind: "error" };
  const total = outcome.written.length + outcome.dispatched.length;
  if (total <= 1) return null;
  const saved = outcome.written.length;
  // `saved === 0` needs two files open in two views at once, which one
  // `EditorView` cannot produce - but split editors are a planned change, and
  // "Undo restores the 0 saved to disk" would be nonsense the day they land.
  const undoable =
    saved === 0
      ? "Every one is an unsaved editor change, so undo is in each file's own history."
      : outcome.dispatched.length === 0
        ? `Undo restores all ${saved}.`
        : `Undo restores the ${saved} saved to disk; the file you are looking at keeps the change in its own undo history.`;
  return { message: `Renamed across ${total} files. ${undoable}`, kind: "info" };
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function list(paths: string[]): string {
  const names = paths.map(nameOf);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/**
 * Rename the symbol at the caret to `newName`, across every file the server
 * says it reaches.
 *
 * Returns rather than throws: every refusal here is a sentence someone has to
 * read, and an exception would arrive as "something went wrong".
 */
export async function renameAcross(deps: RenameDeps, newName: string): Promise<RenameOutcome> {
  let edit: WorkspaceEdit | null;
  try {
    edit = await deps.requestRename(newName);
  } catch (e) {
    return { kind: "aborted", reason: `The rename request failed: ${String(e)}` };
  }
  const targets = editsByUri(edit);
  if (!targets.length) return { kind: "empty" };

  // Step 2, before any mapping exists. A file that will not open aborts the
  // whole rename: a rename that reaches four of five files is worse than one
  // that reached none, because nothing says which four.
  const files: { target: RenameTarget; file: MaterialisedFile; path: string }[] = [];
  for (const target of targets) {
    const path = uriToPath(target.uri);
    if (!path) {
      return { kind: "aborted", reason: `The server named a file Sway cannot address (${target.uri}), so nothing was renamed.` };
    }
    const file = await deps.requestFile(target.uri);
    if (!file) {
      return { kind: "aborted", reason: `Sway could not read ${nameOf(path)}, so nothing was renamed.` };
    }
    files.push({ target, file, path });
  }

  const multiFile = files.length > 1;

  // A multi-file rewrite the user cannot undo is not one Sway will do quietly.
  // Checked before the confirm below, so they are never asked to approve
  // something that was going to be refused anyway.
  if (multiFile && !(await deps.backstopAvailable())) {
    return {
      kind: "aborted",
      reason: `This folder is not a git repository, so Sway cannot take a snapshot it could undo a ${files.length}-file rename from. Renaming inside a single file still works.`,
    };
  }

  // A background tab is viewless, so a rename can only reach it by writing its
  // file. Its text is the buffer's, unsaved edits included, so nothing is
  // *lost* - but those edits get saved, and that is the user's call, not ours.
  // The file on screen is excluded: it is dispatched into, so its edits stay
  // exactly as unsaved as they were.
  const shown = new Set(files.filter((f) => f.file.getView()).map((f) => f.path));
  const dirty = deps.dirtyBuffers(files.map((f) => f.path).filter((p) => !shown.has(p)));
  if (dirty.length) {
    const ok = await deps.confirm({
      title: "Save unsaved changes first?",
      message: `${list(dirty)} ${dirty.length === 1 ? "has" : "have"} unsaved changes, and renaming across ${files.length} files has to write ${dirty.length === 1 ? "it" : "them"} to disk. Your edits are kept, but they will be saved.`,
      confirmLabel: "Save and rename",
    });
    if (!ok) return { kind: "aborted", reason: "Renamed nothing, so your unsaved changes are untouched." };
  }

  // Step 3. Held for the whole operation: without it a rename touching more
  // files than the workspace's bound evicts and closes its own earlier targets
  // partway through, and the later edits land against files the server no
  // longer has open.
  const release = deps.retainMapping();
  try {
    let backstopTs: number | null = null;
    if (multiFile) {
      try {
        backstopTs = await deps.takeBackstop(
          `Rename to "${newName}" in ${files.length} files`,
        );
      } catch (e) {
        return { kind: "aborted", reason: `Sway could not take a snapshot to undo this from, so nothing was renamed: ${String(e)}` };
      }
    }

    const mapping = deps.makeMapping();
    try {
      const writes: { path: string; contents: string }[] = [];
      const dispatches: { view: EditorView; path: string; changes: { from: number; to: number; insert: string }[] }[] = [];
      for (const { target, file, path } of files) {
        let changes;
        try {
          // `file.uri`, never `target.uri`: the mapping is keyed by the URI the
          // workspace holds, and a server does not have to spell a path the way
          // Sway does.
          changes = target.edits.map((e) => ({
            from: mapping.mapPosition(file.uri, e.range.start),
            to: mapping.mapPosition(file.uri, e.range.end),
            insert: e.newText,
          }));
        } catch (e) {
          return { kind: "aborted", reason: `Sway could not place the rename inside ${nameOf(path)}, so nothing was renamed: ${String(e)}` };
        }
        const view = file.getView();
        if (view) dispatches.push({ view, path, changes });
        else writes.push({ path, contents: ChangeSet.of(changes, file.doc.length).apply(file.doc).toString() });
      }

      // Writes before dispatches, deliberately. A refused write has to leave
      // everything as it was, and an editor dispatch is not something this can
      // take back.
      let written: string[] = [];
      if (writes.length) {
        try {
          written = await deps.writeFiles(writes);
        } catch (e) {
          return { kind: "aborted", reason: `${String(e)} Nothing was renamed.` };
        }
      }
      for (const d of dispatches) deps.dispatch(d.view, d.changes);
      // Any of those files that is also an open background tab now agrees with
      // its file, so it neither reads as dirty nor raises a reload banner.
      // Before the notify below, which reads a buffer before it reads disk.
      for (const w of writes) deps.adoptBufferText(w.path, w.contents);
      // The language server still holds the pre-rename text of every file just
      // written. The fs watcher would eventually say so, but it is debounced
      // and it skips whole directories (`node_modules`, `dist`, `target`), so a
      // target in one of those would never be corrected at all. This rename
      // knows exactly which files it wrote, so it says so itself.
      if (written.length) deps.notifyWritten(written);

      return { kind: "applied", written, dispatched: dispatches.map((d) => d.path), backstopTs };
    } finally {
      mapping.destroy();
    }
  } finally {
    release();
  }
}
