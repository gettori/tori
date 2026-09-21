// Formatting through a language server, for a project with no formatter config.
//
// A secondary is asked before the primary: one running for this project (a
// linter that formats) is the more specific answer, and a config opts out with
// `except_features = ["format"]`.

import { getIndentUnit, indentUnit } from "@codemirror/language";
import { formatDocument } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { serverById } from "../../utils/lspServers";
import { lspTargetsFor, secondaryEditDeps, type LspTarget } from "./lspClient";
import { pathToUri } from "./toriWorkspace";
import { applyWorkspaceEdit, type LspTextEdit } from "./workspaceEdit";

const isSecondary = (t: LspTarget) => serverById(t.serverId)?.role === "secondary";

/** The server that formats `path`, or null when none on it can. */
export async function formattingTarget(path: string): Promise<LspTarget | null> {
  const targets = lspTargetsFor(path, "format");
  for (const target of [...targets.filter(isSecondary), ...targets.filter((t) => !isSecondary(t))]) {
    await target.ready;
    if (target.supports("documentFormattingProvider")) return target;
  }
  return null;
}

/** Format `path`, on screen in `view`, through the first server that can.
 *  `stillShown` is asked after each wait, since a tab switch hands the view to
 *  another file. */
export async function formatWithServer(view: EditorView, path: string, stillShown: () => boolean): Promise<void> {
  const target = await formattingTarget(path);
  if (!target || !stillShown()) return;
  if (!isSecondary(target)) {
    formatDocument(view);
    return;
  }
  target.sync();
  const uri = pathToUri(path);
  const edits = await target.request<LspTextEdit[] | null>("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: getIndentUnit(view.state), insertSpaces: !view.state.facet(indentUnit).includes("\t") },
  });
  const deps = secondaryEditDeps(path, target.serverId, "format");
  if (!edits?.length || !deps || !stillShown()) return;
  await applyWorkspaceEdit({ changes: { [uri]: edits } }, deps, {
    onDirty: () => Promise.resolve("Not formatted: the file left the screen with unsaved changes."),
  });
}
