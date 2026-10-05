// The editor command behind Tori's cross-file rename: the name prompt, the
// wiring to the running client, and reporting the result.
//
// Split from `lspRename.ts` so that module stays free of Tauri and CodeMirror
// panels and can be tested as what it is, a sequence of decisions about
// somebody's unsaved work. Everything here is the plumbing those decisions run
// on.

import { invoke } from "@tauri-apps/api/core";
import { getDialog, showDialog, type EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import { writeFilesSuppressingEcho } from "./batchWrite";
import { adoptBufferText, dirtyBuffers } from "./liveBuffers";
import { notifyLspFileChanged } from "./lspClient";
import { renameAcross, type Mapping, type MaterialisedFile, type RenameOutcome, type WorkspaceEdit } from "./lspRename";

/** What the rename needs from the app around it. */
export type RenameIo = {
  /** The project root, for the backstop. Null disables multi-file renames the
   *  same way a non-repository folder does. */
  projectRoot: () => string | null;
  confirm: (opts: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  /** Show the outcome. Called for every ending, including "nothing to do". */
  report: (outcome: RenameOutcome, projectRoot: string | null) => void;
};

// The workspace the client was built with. Typed structurally rather than
// imported as `ToriWorkspace`, because what this needs from it is exactly these
// three methods and nothing more.
type RenameWorkspace = {
  requestFile: (uri: string) => Promise<MaterialisedFile | null>;
  retainMapping: () => () => void;
};

/**
 * Rename the symbol at the caret, across files.
 *
 * Returns whether it took the keystroke, so it can sit in a keymap ahead of the
 * library's own F2 binding: that one runs `doRename`, which silently skips
 * every file the user has not already opened.
 */
export function toriRenameSymbol(view: EditorView, io: RenameIo): boolean {
  const word = view.state.wordAt(view.state.selection.main.head);
  const plugin = LSPPlugin.get(view);
  if (!word || !plugin) return false;
  // Only refuse once the server has actually said it cannot rename. Null
  // capabilities means the initialize exchange has not finished, and refusing
  // then would make the first F2 after opening a project do nothing.
  const caps = plugin.client.serverCapabilities;
  if (caps && !caps.renameProvider) return false;
  const current = view.state.sliceDoc(word.from, word.to);

  // A second press while the panel is open re-selects it rather than stacking a
  // second one, matching the library's behaviour.
  const open = getDialog(view, "cm-tori-rename-panel");
  if (open) {
    const input = open.dom.querySelector("[name=name]") as HTMLInputElement | null;
    input?.select();
    return true;
  }

  const { close, result } = showDialog(view, {
    label: "New name",
    input: { name: "name", value: current },
    focus: true,
    submitLabel: "Rename",
    class: "cm-tori-rename-panel",
  });
  void result.then((form) => {
    view.dispatch({ effects: close });
    if (!form) return;
    const next = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    // An unchanged name is a cancel that happened to go through the button.
    if (!next || next === current) return;
    void run(view, plugin, word.from, next, io);
  });
  return true;
}

async function run(view: EditorView, plugin: LSPPlugin, pos: number, newName: string, io: RenameIo): Promise<void> {
  const client = plugin.client;
  const workspace = client.workspace as unknown as Partial<RenameWorkspace>;
  // Every client Tori builds is given a `ToriWorkspace`, so this holds. If that
  // ever stops being true, the rename says so instead of dying as a TypeError
  // inside a promise, where it would look like nothing happened at all.
  if (typeof workspace?.requestFile !== "function" || typeof workspace.retainMapping !== "function") {
    io.report(
      {
        kind: "aborted",
        reason: "This editor's language client has no Tori workspace, so a cross-file rename cannot run.",
      },
      null,
    );
    return;
  }
  const ws = workspace as RenameWorkspace;
  const root = io.projectRoot();
  // The server has to be looking at the same document the caret is in.
  client.sync();

  const outcome = await renameAcross(
    {
      requestRename: () =>
        client.request<unknown, WorkspaceEdit | null>("textDocument/rename", {
          newName,
          position: plugin.toPosition(pos),
          textDocument: { uri: plugin.uri },
        }),
      requestFile: (uri) => ws.requestFile(uri),
      retainMapping: () => ws.retainMapping(),
      makeMapping: () => client.workspaceMapping() as unknown as Mapping,
      dirtyBuffers,
      adoptBufferText,
      writeFiles: writeFilesSuppressingEcho,
      notifyWritten: (paths) => {
        for (const p of paths) notifyLspFileChanged(p);
      },
      // No project root means no repository to snapshot, which is the same
      // refusal a plain folder gets.
      backstopAvailable: () =>
        root ? invoke<boolean>("backstop_available", { repoPath: root }) : Promise.resolve(false),
      takeBackstop: async (label) => {
        const rec = await invoke<{ ts: number }>("backstop_take", { repoPath: root, label });
        return rec.ts;
      },
      confirm: io.confirm,
      dispatch: (target, changes) => target.dispatch({ changes, userEvent: "rename" }),
    },
    newName,
  );

  io.report(outcome, root);
  if (outcome.kind === "aborted") view.focus();
}
