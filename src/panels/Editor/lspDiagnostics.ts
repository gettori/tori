// What each server says about a file, shown as one lint set. The library's
// `serverDiagnostics()` renders a publish as the whole of a file's diagnostics,
// so with two servers on a file each publish would wipe out the other's.

import { forEachDiagnostic, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { ChangeSet, MapMode, type ChangeDesc, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import { LSPPlugin, serverDiagnostics, type LSPClient } from "@codemirror/lsp-client";
import { diffChanges } from "./docDiff";
import type { RawDiagnostic } from "./lspDiagnosticContext";
import { uriToPath, type ToriWorkspace } from "./toriWorkspace";
import type { LspPosition } from "./workspaceEdit";

// Tagged on each diagnostic so the lint state itself is the per-server store:
// lint maps every diagnostic through edits, so a peer's list read back from it
// is already where it belongs on the current text.
const OWNER = Symbol("lsp server");
type Owned = Diagnostic & { [OWNER]?: string };

function toSeverity(severity: unknown): Diagnostic["severity"] {
  const s = severity ?? 1;
  return s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : "hint";
}

// Clamped rather than trusted: a server may point one past the last line or the
// end of a line, and the library's conversion throws on either.
function offsetIn(doc: Text, pos: LspPosition | undefined): number | null {
  if (typeof pos?.line !== "number" || typeof pos.character !== "number") return null;
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(Math.max(pos.line, 0) + 1);
  return line.from + Math.min(Math.max(pos.character, 0), line.length);
}

/** `raw` as published against `doc`, carried through `changes` onto the text on
 *  screen. One whose own text was edited or deleted since is dropped. */
export function toEditorDiagnostics(
  raw: RawDiagnostic[],
  doc: Text,
  changes: ChangeDesc,
  serverId: string,
): Diagnostic[] {
  const out: Owned[] = [];
  for (const d of raw) {
    const start = offsetIn(doc, d.range?.start);
    const end = offsetIn(doc, d.range?.end);
    if (start === null || end === null) continue;
    const [a, b] = start <= end ? [start, end] : [end, start];
    const from = a === b ? changes.mapPos(a, -1, MapMode.TrackDel) : changes.mapPos(a, 1, MapMode.TrackAfter);
    const to = a === b ? from : changes.mapPos(b, -1, MapMode.TrackBefore);
    if (from === null || to === null) continue;
    out.push({
      from,
      to: Math.max(from, to),
      severity: toSeverity(d.severity),
      message: typeof d.message === "string" ? d.message : String(d.message ?? ""),
      source: typeof d.source === "string" ? d.source : serverId,
      [OWNER]: serverId,
    });
  }
  return out;
}

/** Replace what `serverId` says about this document, keeping what `peers` said.
 *  Anything from a server outside `peers` was said by one that has stopped. */
export function publishFrom(
  state: EditorState,
  serverId: string,
  list: Diagnostic[],
  peers: readonly string[],
): TransactionSpec {
  const kept: Owned[] = [];
  forEachDiagnostic(state, (d: Owned, from, to) => {
    const owner = d[OWNER];
    if (owner && owner !== serverId && peers.includes(owner)) kept.push({ ...d, from, to });
  });
  return setDiagnostics(state, [...kept, ...list]);
}

/** From `held`, the doc a server was last sent, to `now`, given the view side's
 *  own record of the changes from `synced` to `now`. */
export function changesToNow(held: Text, synced: Text, unsynced: ChangeDesc, now: Text): ChangeDesc {
  if (held === synced) return unsynced;
  return held.eq(now) ? ChangeSet.empty(now.length).desc : diffChanges(held, now).desc;
}

type PublishParams = { uri?: unknown; version?: unknown; diagnostics?: unknown } | null;

/** `serverDiagnostics()` with Tori's handler in place of the library's.
 *  `peers` names every server whose diagnostics stay beside this one's. */
export function serverDiagnosticsFor(serverId: string, peers: (path: string) => readonly string[]) {
  const { clientCapabilities, editorExtension } = serverDiagnostics();
  return {
    clientCapabilities,
    editorExtension,
    notificationHandlers: {
      "textDocument/publishDiagnostics": (client: LSPClient, params: PublishParams): boolean => {
        const uri = typeof params?.uri === "string" ? params.uri : null;
        const path = uri && uriToPath(uri);
        const workspace = client.workspace as ToriWorkspace;
        const file = uri ? workspace.getFile(uri) : null;
        const view = file?.getView();
        const plugin = view && LSPPlugin.get(view);
        const since = uri && workspace.since(uri, typeof params?.version === "number" ? params.version : null);
        if (!path || !file || !view || !plugin || !since) return true;
        const raw = Array.isArray(params?.diagnostics) ? (params.diagnostics as RawDiagnostic[]) : [];
        const toNow = since.changes.composeDesc(
          changesToNow(file.doc, plugin.syncedDoc, plugin.unsyncedChanges.desc, view.state.doc),
        );
        view.dispatch(
          publishFrom(view.state, serverId, toEditorDiagnostics(raw, since.doc, toNow, serverId), peers(path)),
        );
        return true;
      },
    },
  };
}
