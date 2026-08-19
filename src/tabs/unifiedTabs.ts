// The kind-tagged union over the terminal and editor tab models (plan phase 4).
// A derived view, not a third store: the panel stores stay the truth and ids
// pass through verbatim (`sh:`/`chat:` terminal ids, file paths and `sway://`
// synthetics), so nothing listening on those ids can tell the union exists.
import { createMemo, onCleanup } from "solid-js";
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

function deriveUnifiedTabs(): UnifiedTab[] {
  return [
    ...open().map(unifyTerm),
    ...Object.entries(tabsByWs()).flatMap(([workspace, files]) => files.map((f) => unifyFile(f, workspace))),
  ];
}

// Not a module-level createMemo: a memo made outside any root is never
// disposed. The shell installs one under its own root instead (below), so it
// dies with the app, and panel-only mounts that never install still work.
let memoized: (() => UnifiedTab[]) | null = null;

/** Called once from the shell's setup, inside its reactive root. Every
 *  `unifiedTabs()` read then shares one memo for the root's lifetime instead
 *  of rebuilding the union per call site per change. */
export function installUnifiedTabsMemo() {
  const m = createMemo(deriveUnifiedTabs);
  memoized = m;
  onCleanup(() => {
    if (memoized === m) memoized = null;
  });
}

export function unifiedTabs(): UnifiedTab[] {
  return memoized ? memoized() : deriveUnifiedTabs();
}

export const idOf = (t: UnifiedTab) => t.id;
