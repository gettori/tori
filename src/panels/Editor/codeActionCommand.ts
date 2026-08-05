// The editor command behind code actions: what the caret is asking about, and
// the wiring that lets a picked action reach the files it names.
//
// Split from `lspCodeActions.ts` for the reason `lspRenameCommand.ts` is split
// from `lspRename.ts`: that module is protocol and judgement, testable without
// Tauri or a mounted editor, and this one is the plumbing those judgements run
// on.
//
// The policy below is deliberately the same shape as `renameAcross`'s, and for
// the same reason: a code action the user picked can rewrite files nobody is
// looking at, and CodeMirror's undo cannot reach a file it never had open. The
// sentences differ because they are read by a person who pressed ⌘⌥A, not F2.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import { writeFilesSuppressingEcho } from "./batchWrite";
import { adoptBufferText, dirtyBuffers } from "./liveBuffers";
import { executeServerCommand, lspTargetFor, notifyLspFileChanged } from "./lspClient";
import type { LspRange } from "./lspDiagnosticContext";
import { runCodeAction, type CodeAction, type RunCodeActionDeps, type RunOutcome } from "./lspCodeActions";
import {
  applyWorkspaceEdit,
  list,
  type ApplyDeps,
  type Mapping,
  type MaterialisedFile,
  type WorkspaceEdit,
} from "./workspaceEdit";

/** What running an action needs from the app around it. */
export type CodeActionIo = {
  /** The project root, for the backstop. Null disables multi-file actions the
   *  same way a non-repository folder does. */
  projectRoot: () => string | null;
  confirm: (opts: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  notify: (message: string, kind: "error" | "info") => void;
};

// What this needs from the client's workspace, typed structurally: exactly
// these two methods, the same pair the rename asks for.
type EditWorkspace = {
  requestFile: (uri: string) => Promise<MaterialisedFile | null>;
  retainMapping: () => () => void;
};

/** The LSP range the caret or the selection is asking about. Null when the
 *  view has no language client, which is most buffers. */
export function caretRange(view: EditorView): LspRange | null {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const { from, to } = view.state.selection.main;
  return { start: plugin.toPosition(from), end: plugin.toPosition(to) };
}

/** The whole document, as a source action is asked about it. Built from the
 *  same plugin as `caretRange` so both speak the client's coordinates, and
 *  falling back to nothing for a buffer with no client. */
export function wholeFileRange(view: EditorView): LspRange {
  const doc = view.state.doc;
  const plugin = LSPPlugin.get(view);
  const end = doc.length;
  return plugin
    ? { start: plugin.toPosition(0), end: plugin.toPosition(end) }
    : { start: { line: 0, character: 0 }, end: { line: doc.lines - 1, character: doc.line(doc.lines).length } };
}

/**
 * The apply-and-run half, built from the client the view is attached to.
 *
 * Null when there is no client, or when its workspace is not Sway's. Every
 * client Sway builds is given a `SwayWorkspace`, so the second case is a
 * should-not-happen that says so rather than dying as a TypeError inside a
 * promise, where it would look like nothing happened at all.
 */
export function codeActionRunner(view: EditorView, path: string, io: CodeActionIo): RunCodeActionDeps | null {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const client = plugin.client;
  const workspace = client.workspace as unknown as Partial<EditWorkspace>;
  if (typeof workspace?.requestFile !== "function" || typeof workspace.retainMapping !== "function") return null;
  const ws = workspace as EditWorkspace;
  const root = io.projectRoot();

  const deps: ApplyDeps = {
    requestFile: (uri) => ws.requestFile(uri),
    retainMapping: () => ws.retainMapping(),
    makeMapping: () => client.workspaceMapping() as unknown as Mapping,
    dirtyBuffers,
    adoptBufferText,
    writeFiles: writeFilesSuppressingEcho,
    notifyWritten: (paths) => {
      for (const p of paths) notifyLspFileChanged(p);
    },
    dispatch: (target, changes) => target.dispatch({ changes, userEvent: "lsp.codeAction" }),
  };

  return {
    applyEdit: async (edit: WorkspaceEdit, title: string) => {
      const outcome = await applyWorkspaceEdit(edit, deps, {
        // Checked before the confirm, so nobody is asked to approve something
        // that was going to be refused anyway.
        precheck: async (fileCount) => {
          if (fileCount <= 1) return null;
          const ok = root ? await invoke<boolean>("backstop_available", { repoPath: root }) : false;
          if (ok) return null;
          return `This folder is not a git repository, so Sway cannot take a snapshot it could undo a ${fileCount}-file change from. A fix inside a single file still works.`;
        },
        onDirty: async (dirty, fileCount) => {
          const ok = await io.confirm({
            title: "Save unsaved changes first?",
            message: `${list(dirty)} ${dirty.length === 1 ? "has" : "have"} unsaved changes, and "${title}" changes ${fileCount} files, so ${dirty.length === 1 ? "it" : "they"} have to be written to disk. Your edits are kept, but they will be saved.`,
            confirmLabel: "Save and apply",
          });
          return ok ? null : "Nothing was changed, so your unsaved changes are untouched.";
        },
        beforeWrite: async (fileCount) => {
          if (fileCount <= 1) return null;
          try {
            await invoke<{ ts: number }>("backstop_take", { repoPath: root, label: title });
            return null;
          } catch (e) {
            return `Sway could not take a snapshot to undo this from, so nothing was changed: ${String(e)}`;
          }
        },
      });

      if (outcome.kind === "aborted") return outcome.reason;
      // A multi-file change has to say two things, because both are surprising:
      // files nobody was looking at just changed, and undo does not cover all
      // of them. The file on screen took its change as an editor edit, so a
      // working-tree restore would not touch it - it has its own undo instead.
      if (outcome.kind === "applied") {
        const total = outcome.written.length + outcome.dispatched.length;
        if (total > 1) {
          const saved = outcome.written.length;
          io.notify(
            `"${title}" changed ${total} files. ${
              saved === 0
                ? "Every one is an unsaved editor change, so undo is in each file's own history."
                : outcome.dispatched.length === 0
                  ? `Undo restores all ${saved}.`
                  : `Undo restores the ${saved} saved to disk; the file you are looking at keeps the change in its own undo history.`
            }`,
            "info",
          );
        }
      }
      return null;
    },

    // Null from `executeServerCommand` means the server advertised no
    // `executeCommandProvider`, which for a command-only action is a refusal to
    // report rather than a silent success.
    runCommand: async (command) => {
      const target = lspTargetFor(path);
      if (!target) throw new Error("no language server for this file");
      const res = await executeServerCommand(target, command.command, command.arguments);
      if (res === null && !target.supports("executeCommandProvider")) {
        throw new Error("this server runs no commands");
      }
    },
  };
}

/**
 * Run `action` and say what happened, once.
 *
 * Every ending is a sentence somebody has to read, including the ones that are
 * not failures: an action that turned out to have nothing to do looks exactly
 * like a menu that ignored the click.
 */
export async function applyCodeAction(
  view: EditorView,
  path: string,
  action: CodeAction,
  io: CodeActionIo,
): Promise<RunOutcome> {
  const runner = codeActionRunner(view, path, io);
  if (!runner) {
    const reason = "This editor's language client has no Sway workspace, so a code action cannot run.";
    io.notify(reason, "error");
    return { kind: "refused", reason };
  }
  const outcome = await runCodeAction(path, action, runner);
  if (outcome.kind === "refused") io.notify(outcome.reason, "error");
  if (outcome.kind === "nothing") io.notify(`"${action.title}" had nothing to change.`, "info");
  return outcome;
}
