// Tori's own cross-file rename.
//
// The library ships one, and it cannot work here. `doRename`
// (`lsp-client/dist/index.js:1209`) walks the server's edits and does
// `let file = workspace.getFile(uri); if (!lspChanges.length || !file) continue`
// - synchronously. Every file the user has not already opened is skipped
// without a word, which is every file a rename exists to reach. There is no
// `Workspace` override that fixes it: the check is sync and materialising a
// file is not.
//
// The ordering that *does* work is not rename's alone - a code action needs the
// same one - so it lives in `workspaceEdit.ts`. What stays here is the half
// that is only true of a rename: it may stop and ask about unsaved work,
// because a person just pressed a key, and a multi-file one takes a snapshot
// first because there is no other way back.

import {
  applyWorkspaceEdit,
  list,
  type ApplyDeps,
  type EditTarget,
  type WorkspaceEdit,
} from "./workspaceEdit";

// Re-exported, not re-declared: these were this module's before the applier
// existed and callers still reach for them here. Exactly what has an importer,
// so the move does not quietly widen the surface - the rest is `workspaceEdit`'s
// to publish.
export { editsByUri } from "./workspaceEdit";
export type { LspPosition, WorkspaceEdit, MaterialisedFile, Mapping } from "./workspaceEdit";

/** One file's worth of a rename. The applier calls this an `EditTarget`, since
 *  a rename is no longer the only thing that produces them. */
export type RenameTarget = EditTarget;

export type RenameDeps = ApplyDeps & {
  /** `textDocument/rename`. */
  requestRename: (newName: string) => Promise<WorkspaceEdit | null>;
  /** Whether this folder can be backed up at all. */
  backstopAvailable: () => Promise<boolean>;
  /** Snapshot the working tree, returning the timestamp a restore is keyed by. */
  takeBackstop: (label: string) => Promise<number>;
  /** Ask the user, for the one decision that is theirs to make. */
  confirm: (opts: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
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

  // Written by the hook below rather than returned, because only the applied
  // outcome carries it and the applier has no reason to know it exists.
  let backstopTs: number | null = null;

  const outcome = await applyWorkspaceEdit(edit, deps, {
    // A multi-file rewrite the user cannot undo is not one Tori will do
    // quietly. Checked before the confirm, so they are never asked to approve
    // something that was going to be refused anyway.
    precheck: async (fileCount) => {
      if (fileCount <= 1 || (await deps.backstopAvailable())) return null;
      return `This folder is not a git repository, so Tori cannot take a snapshot it could undo a ${fileCount}-file rename from. Renaming inside a single file still works.`;
    },
    onDirty: async (dirty, fileCount) => {
      const ok = await deps.confirm({
        title: "Save unsaved changes first?",
        message: `${list(dirty)} ${dirty.length === 1 ? "has" : "have"} unsaved changes, and renaming across ${fileCount} files has to write ${dirty.length === 1 ? "it" : "them"} to disk. Your edits are kept, but they will be saved.`,
        confirmLabel: "Save and rename",
      });
      return ok ? null : "Renamed nothing, so your unsaved changes are untouched.";
    },
    beforeWrite: async (fileCount) => {
      if (fileCount <= 1) return null;
      try {
        backstopTs = await deps.takeBackstop(`Rename to "${newName}" in ${fileCount} files`);
        return null;
      } catch (e) {
        return `Tori could not take a snapshot to undo this from, so nothing was renamed: ${String(e)}`;
      }
    },
  });

  if (outcome.kind !== "applied") return outcome;
  return { ...outcome, backstopTs };
}
