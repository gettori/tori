// Applying a server's `WorkspaceEdit`, whoever asked for it.
//
// A rename asks for one, a code action comes back carrying one, and a server
// can push one at us unasked through `workspace/applyEdit`. All three need the
// same ordering, and it is the ordering `@codemirror/lsp-client` cannot take:
//
//   1. flatten the edit into one list of files
//   2. **materialise every target file**, awaiting each
//   3. only then construct the `WorkspaceMapping`
//
// A mapping snapshots every open file's document in its constructor and
// `mapPosition` throws for anything absent, so a file materialised after the
// fact is one the mapping cannot answer for - inside a promise, which reads to
// the user as nothing happening at all.
//
// What differs between callers is not the mechanics but the **policy**: who may
// be asked a question, and what has to happen before the first byte is written.
// A rename can stop and ask, because a person just pressed a key; a
// server-initiated edit cannot, because the server is blocked on the answer.
// Those two live in `ApplyPolicy` and nowhere else.
//
// Everything else is injected, because every decision here is a judgement about
// someone's unsaved work and none of them should need a running editor to test.

import { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { uriToPath } from "./toriWorkspace";

/** An LSP position, and the edits an edit comes back as. */
export type LspPosition = { line: number; character: number };
export type LspTextEdit = { range: { start: LspPosition; end: LspPosition }; newText: string };

/** A `documentChanges` entry that edits a file's text. */
export type TextDocumentEdit = { textDocument?: { uri?: string }; edits?: LspTextEdit[] };

/** A `documentChanges` entry that creates, renames or deletes a file instead of
 *  editing one. Told apart from the above by `kind`, which only these carry. */
export type ResourceOperation = {
  kind: "create" | "rename" | "delete";
  /** create and delete. */
  uri?: string;
  /** rename. */
  oldUri?: string;
  newUri?: string;
};

export type DocumentChange = TextDocumentEdit | ResourceOperation;

/** A server's reply to anything that changes files. Servers may answer in
 *  either shape, and reading both costs three lines where the difference
 *  between them is an operation that silently does nothing. */
export type WorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: DocumentChange[];
};

/** One file's worth of an edit. */
export type EditTarget = { uri: string; edits: LspTextEdit[] };

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

function isResourceOperation(change: DocumentChange): change is ResourceOperation {
  return typeof (change as ResourceOperation).kind === "string";
}

/** The first resource operation in an edit, or null. */
export function resourceOperationIn(edit: WorkspaceEdit | null | undefined): ResourceOperation | null {
  for (const change of edit?.documentChanges ?? []) {
    if (isResourceOperation(change)) return change;
  }
  return null;
}

/**
 * Why a resource operation was refused, naming the file and the operation.
 *
 * Tori does not create, rename or delete files on a server's say-so yet. The
 * refusal is deliberately specific: "this did not work" would send someone
 * looking for a bug, where the honest answer is that the editor understood the
 * request perfectly and declined it.
 */
export function describeResourceOperation(op: ResourceOperation): string {
  const uri = op.kind === "rename" ? op.oldUri : op.uri;
  const path = uri ? uriToPath(uri) : null;
  const name = path ? nameOf(path) : (uri ?? "a file");
  const verb = op.kind === "create" ? "create" : op.kind === "delete" ? "delete" : "rename";
  return `This change asks Tori to ${verb} ${name}, which it cannot do yet, so nothing was changed.`;
}

/** Flatten either `WorkspaceEdit` shape into one list, dropping files with
 *  nothing to change so they are neither opened nor written. */
export function editsByUri(edit: WorkspaceEdit | null | undefined): EditTarget[] {
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
    for (const change of edit?.documentChanges ?? []) {
      if (isResourceOperation(change)) continue;
      const uri = change?.textDocument?.uri;
      if (uri && change.edits?.length) add(uri, change.edits);
    }
  }
  return [...byUri].map(([uri, edits]) => ({ uri, edits }));
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function list(paths: string[]): string {
  const names = paths.map(nameOf);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export type ApplyDeps = {
  /** `ToriWorkspace.requestFile`, which reads an open buffer before disk. */
  requestFile: (uri: string) => Promise<MaterialisedFile | null>;
  /** `ToriWorkspace.retainMapping`, so nothing is evicted mid-operation. */
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
   *  paths this edit wrote. */
  notifyWritten: (paths: string[]) => void;
  dispatch: (view: EditorView, changes: { from: number; to: number; insert: string }[]) => void;
};

/**
 * The judgement calls, which differ by who asked for the edit.
 *
 * Each hook returns an **abort reason**, or null to carry on. Returning a
 * sentence rather than throwing is the same choice the outcome type makes:
 * every refusal here is something a person has to read, and an exception would
 * arrive as "something went wrong".
 */
export type ApplyPolicy = {
  /** Runs once every target is materialised and before anyone is asked
   *  anything, so a caller never approves something already doomed. */
  precheck?: (fileCount: number) => Promise<string | null>;
  /** Background buffers holding unsaved edits that this edit has to write to
   *  disk. A rename asks; a server-initiated edit refuses without asking. */
  onDirty: (dirty: string[], fileCount: number) => Promise<string | null>;
  /** Runs inside the retain, before the first write. Where a caller takes a
   *  snapshot it could undo from. */
  beforeWrite?: (fileCount: number) => Promise<string | null>;
};

export type ApplyOutcome =
  | { kind: "empty" }
  | { kind: "aborted"; reason: string }
  | { kind: "applied"; written: string[]; dispatched: string[] };

/**
 * Apply `edit` across every file it names, opening whatever is not on screen.
 *
 * Refuses rather than half-applying, everywhere: an edit that reached four of
 * five files is worse than one that reached none, because nothing says which
 * four.
 */
export async function applyWorkspaceEdit(
  edit: WorkspaceEdit | null | undefined,
  deps: ApplyDeps,
  policy: ApplyPolicy,
): Promise<ApplyOutcome> {
  // Before anything is materialised. A resource operation is the whole edit's
  // business: applying only its text half would leave the edits that assume a
  // created or deleted file sitting against a tree where it never happened.
  const op = resourceOperationIn(edit);
  if (op) return { kind: "aborted", reason: describeResourceOperation(op) };

  const targets = editsByUri(edit);
  if (!targets.length) return { kind: "empty" };

  // Step 2, before any mapping exists. A file that will not open aborts the
  // whole edit.
  const files: { target: EditTarget; file: MaterialisedFile; path: string }[] = [];
  for (const target of targets) {
    const path = uriToPath(target.uri);
    if (!path) {
      return { kind: "aborted", reason: `The server named a file Tori cannot address (${target.uri}), so nothing was changed.` };
    }
    const file = await deps.requestFile(target.uri);
    if (!file) {
      return { kind: "aborted", reason: `Tori could not read ${nameOf(path)}, so nothing was changed.` };
    }
    files.push({ target, file, path });
  }

  const refused = await policy.precheck?.(files.length);
  if (refused) return { kind: "aborted", reason: refused };

  // A background tab is viewless, so an edit can only reach it by writing its
  // file. Its text is the buffer's, unsaved edits included, so nothing is
  // *lost* - but those edits get saved, and that is not this module's call.
  // The file on screen is excluded: it is dispatched into, so its edits stay
  // exactly as unsaved as they were.
  const shown = new Set(files.filter((f) => f.file.getView()).map((f) => f.path));
  const dirty = deps.dirtyBuffers(files.map((f) => f.path).filter((p) => !shown.has(p)));
  if (dirty.length) {
    const stop = await policy.onDirty(dirty, files.length);
    if (stop) return { kind: "aborted", reason: stop };
  }

  // Step 3. Held for the whole operation: without it an edit touching more
  // files than the workspace's bound evicts and closes its own earlier targets
  // partway through, and the later edits land against files the server no
  // longer has open.
  const release = deps.retainMapping();
  try {
    const blocked = await policy.beforeWrite?.(files.length);
    if (blocked) return { kind: "aborted", reason: blocked };

    const mapping = deps.makeMapping();
    try {
      const writes: { path: string; contents: string }[] = [];
      const dispatches: { view: EditorView; path: string; changes: { from: number; to: number; insert: string }[] }[] = [];
      for (const { target, file, path } of files) {
        let changes;
        try {
          // `file.uri`, never `target.uri`: the mapping is keyed by the URI the
          // workspace holds, and a server does not have to spell a path the way
          // Tori does.
          changes = target.edits.map((e) => ({
            from: mapping.mapPosition(file.uri, e.range.start),
            to: mapping.mapPosition(file.uri, e.range.end),
            insert: e.newText,
          }));
        } catch (e) {
          return { kind: "aborted", reason: `Tori could not place the change inside ${nameOf(path)}, so nothing was changed: ${String(e)}` };
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
          return { kind: "aborted", reason: `${String(e)} Nothing was changed.` };
        }
      }
      for (const d of dispatches) deps.dispatch(d.view, d.changes);
      // Any of those files that is also an open background tab now agrees with
      // its file, so it neither reads as dirty nor raises a reload banner.
      // Before the notify below, which reads a buffer before it reads disk.
      for (const w of writes) deps.adoptBufferText(w.path, w.contents);
      // The language server still holds the pre-edit text of every file just
      // written. The fs watcher would eventually say so, but it is debounced
      // and it skips whole directories (`node_modules`, `dist`, `target`), so a
      // target in one of those would never be corrected at all. This knows
      // exactly which files it wrote, so it says so itself.
      if (written.length) deps.notifyWritten(written);

      return { kind: "applied", written, dispatched: dispatches.map((d) => d.path) };
    } finally {
      mapping.destroy();
    }
  } finally {
    release();
  }
}
