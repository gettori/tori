// The kind-tagged union over the terminal and editor tab models (plan phase 4).
// A derived view, not a third store: the panel stores stay the truth and ids
// pass through verbatim (`sh:`/`chat:` terminal ids, file paths and `sway://`
// synthetics), so nothing listening on those ids can tell the union exists.
import { open, type OpenTerm, type TabKind as TerminalTabKind } from "../panels/Terminal/terminalTabStore";
import { tabsByWs, type FileTab } from "../panels/Editor/editorTabStore";

export type UnifiedTabKind = TerminalTabKind | "file";

export type TerminalUnifiedTab = {
  kind: TerminalTabKind;
  id: string;
  workspace: string;
  term: OpenTerm;
};

export type FileUnifiedTab = {
  kind: "file";
  id: string;
  workspace: string;
  file: FileTab;
};

export type UnifiedTab = TerminalUnifiedTab | FileUnifiedTab;

// Same underlying tab object -> same wrapper, always: OverflowTabBar keys rows
// by item identity, so a fresh wrapper per read would tear down and rebuild
// every tab's DOM on any store change. The wrapper snapshots kind/id/workspace
// at first sight, so the panel stores must keep replacing tab objects on
// change (they do); an in-place mutation would desync wrapper and tab.
const termWrap = new WeakMap<OpenTerm, TerminalUnifiedTab>();
const fileWrap = new WeakMap<FileTab, FileUnifiedTab>();

export function unifyTerm(t: OpenTerm): TerminalUnifiedTab {
  let w = termWrap.get(t);
  if (!w) {
    w = { kind: t.kind, id: t.id, workspace: t.workspace, term: t };
    termWrap.set(t, w);
  }
  return w;
}

export function unifyFile(f: FileTab, workspace: string): FileUnifiedTab {
  let w = fileWrap.get(f);
  if (!w) {
    w = { kind: "file", id: f.path, workspace, file: f };
    fileWrap.set(f, w);
  }
  return w;
}

// A plain derived function rather than a module-level createMemo: a memo made
// outside any root is never disposed, and callers read this inside their own
// tracking scopes anyway.
export function unifiedTabs(): UnifiedTab[] {
  return [
    ...open().map(unifyTerm),
    ...Object.entries(tabsByWs()).flatMap(([workspace, files]) => files.map((f) => unifyFile(f, workspace))),
  ];
}

export const idOf = (t: UnifiedTab) => t.id;
