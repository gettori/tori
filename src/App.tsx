import { createSignal, createEffect, createMemo, on, onMount, onCleanup, lazy, Suspense, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import LeftSidebar, { type Selection } from "./panels/LeftSidebar/LeftSidebar";
import Terminal from "./panels/Terminal/Terminal";
import Editor from "./panels/Editor/Editor";
import { stageHost } from "./tabs/stageHost";
import { traceMark, tracePaint } from "./utils/perfTrace";
import { registerRecipeHost } from "./utils/perfRecipe";
import Toolbar from "./components/Toolbar/Toolbar";
import WindowControls from "./components/WindowControls/WindowControls";
import Resizer from "./components/Resizer/Resizer";
import AskpassDialog from "./components/Dialogs/AskpassDialog";
import ToastRegion from "./components/Toasts/Toasts";
import Settings from "./panels/Settings/Settings";
import UpdatePill from "./components/UpdatePill/UpdatePill";
import Button from "./components/Button/Button";
import Icon from "./components/Icon/Icon";
import { Settings as SettingsIcon } from "lucide-solid";
import {
  on as onEvent,
  onWith as onEventWith,
  STOP_CHAT,
  type StopChat,
  emit,
  emitWith,
  TOAST,
  type ToastEvent,
  OPEN_OMNIBOX,
  type OpenOmnibox,
  TOGGLE_SHORTCUTS,
  ZOOM_IN,
  ZOOM_OUT,
  ZOOM_RESET,
  RELOAD_APP,
  TOGGLE_SIDEBAR,
  TOGGLE_TERMINAL,
  TOGGLE_EDITOR,
  TOGGLE_FILETREE,
  SPLIT_PANE,
  type SplitPane,
  CLOSE_PANE,
  MOVE_TAB_TO_PANE,
  type MoveTabToPane,
  REFIT_PANES,
  FOCUS_SEARCH,
  FOCUS_PROJECT_SEARCH,
  RUN_LAST_TASK,
  SET_RIGHT_MODE,
  PREFS_TOGGLE,
  type PrefsToggle,
  OPEN_SETTINGS,
  type OpenSettings,
  type LiveTab,
} from "./utils/events";
import { dispatchWindowHotkey } from "./utils/hotkeys";
import {
  MAX_PANES,
  closePane,
  findPane,
  leaves,
  neighborPane,
  resizePane,
  resolvePinPane,
  reuseNode,
  resolveTogglePane,
  setPaneHidden,
  splitPane,
  visibleLeaves,
  type PaneLeaf,
  type PaneNode,
} from "./layout/paneLayout";
import {
  ensureEnvelope,
  envelopeFor,
  focusedPaneId,
  layoutRoot,
  persistEnvelopes,
  resetPaneLayoutModel,
  seedOnePane,
  setFocusedPane,
  tabFocusStamp,
  updateLayout,
} from "./layout/layoutStore";
import PaneTree, { type PaneRoles } from "./layout/PaneTree";
import {
  forgetPane,
  homePane,
  mergePaneInto,
  moveTabToPane,
  paneOfTab,
  setPaneActive,
  pinCurrentPlacements,
  pinRulesFor,
  resetTabPlacement,
  type TabRef,
} from "./layout/tabPlacement";
import { installPaneTabsMemo, paneActiveId, paneTabs, reorderPane } from "./tabs/paneTabs";
import { maybeKindEntry } from "./tabs/registry";
import { installUnifiedTabsMemo, unifiedTabs } from "./tabs/unifiedTabs";
import { chatToStop, liveChats, stoppableChats } from "./utils/chatSessions";
import { rerunLast } from "./utils/runTask";
import Omnibox from "./components/Omnibox/Omnibox";
import ShortcutSheet from "./components/ShortcutSheet/ShortcutSheet";
import { setPinSides } from "./layout/pinRules";
import {
  chromeScale,
  initSettings,
  settings,
  toggleEditorDefault,
  zoomIn,
  zoomOut,
  resetZoom,
} from "./panels/Settings/settingsStore";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./App.css";

// Dev-only styleguide, code-split so it never ships in the production bundle.
const Styleguide = lazy(() => import("./dev/Styleguide"));

const LS_LAYOUT = "sway.layout.v1";
const LS_SELECTION = "sway.selection.v1";

type Layout = {
  sidebar: number;
  editor: number;
  showSidebar: boolean;
  showTerminal: boolean;
  showEditor: boolean;
  showFiletree: boolean;
};

// Pane floors, in design px at `--ui-scale` 1 and scaled with it like every
// other chrome dimension (a user at 20px UI needs proportionally more room to
// fit the same content). No pane has a maximum: a divider travels until the pane
// that absorbs the slack would drop below its floor, so on a wide display every
// pane can take almost the whole window.
const SIDEBAR_MIN = 180;
const EDITOR_MIN = 180;
// Chat has no width of its own (`.pane.terminal` is the flex filler, App.css), so
// this floor is enforced as the *ceiling* of the two dividers beside it. Without
// it, `min-width: 0` on that pane lets a drag crush the transcript to nothing.
const CHAT_MIN = 320;
// Chrome that sits between the panes, so a ceiling leaves room for it: one
// Resizer is 8px (Resizer.module.css .resizer) and .workspace pads 10px on the
// side away from the sidebar (App.css .workspace / .workspace.no-sidebar).
const GUTTER = 8;
const WORKSPACE_PAD = 10;

const DEFAULT_LAYOUT: Layout = {
  sidebar: 280,
  editor: 640,
  showSidebar: true,
  showTerminal: true,
  showEditor: true,
  showFiletree: true,
};

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LS_LAYOUT);
    if (raw) {
      const v = JSON.parse(raw);
      const showTerminal = v.showTerminal ?? true;
      const showEditor = v.showEditor ?? true;
      // Enforce the ">=1 of terminal/editor visible" invariant on load: a stored
      // both-hidden state (hand-edited, or a bug in a past build) would leave the
      // work-card empty with no way back, so reset both to visible.
      const bothHidden = !showTerminal && !showEditor;
      // Widths are taken as stored, without bounding them: the bounds depend on
      // the window and on which panes are visible, none of which is measured
      // yet. The clamp effect in App does it once the layout has a width, which
      // is also what keeps a layout saved on a wide display usable on a narrow
      // one.
      return {
        sidebar: v.sidebar ?? DEFAULT_LAYOUT.sidebar,
        editor: v.editor ?? DEFAULT_LAYOUT.editor,
        showSidebar: v.showSidebar ?? true,
        showTerminal: bothHidden ? true : showTerminal,
        showEditor: bothHidden ? true : showEditor,
        showFiletree: v.showFiletree ?? true,
      };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_LAYOUT };
}

function loadSelection(): Selection | null {
  try {
    const raw = localStorage.getItem(LS_SELECTION);
    if (raw) {
      const s = JSON.parse(raw) as Selection;
      // Backfill the folder anchor for selections persisted before Phase 3.
      if (s && !s.folderPath) s.folderPath = s.projectPath;
      // Backfill the space name for selections persisted under the old `groupName` key.
      if (s && !s.spaceName) s.spaceName = (s as unknown as { groupName?: string }).groupName ?? "";
      return s;
    }
  } catch {
    // ignore
  }
  return null;
}

function App() {
  // Dev-only QA surface, gated by an env flag + a #styleguide hash (NOT a route).
  // Rendered standalone so the app's settings/theme init never fights its
  // scale/theme controls.
  if (import.meta.env.DEV && window.location.hash === "#styleguide") {
    return (
      <Suspense>
        <Styleguide />
      </Suspense>
    );
  }

  const initial = loadLayout();
  const [sidebar, setSidebar] = createSignal(initial.sidebar);
  const [showSidebar, setShowSidebar] = createSignal(initial.showSidebar);
  const [showFiletree, setShowFiletree] = createSignal(initial.showFiletree);
  resetPaneLayoutModel();
  resetTabPlacement();
  // Inside App's own root, so both memos are disposed with it (the module-level
  // concern documented in unifiedTabs.ts); a repeated test mount installs fresh.
  installUnifiedTabsMemo();
  installPaneTabsMemo();
  /** Every open tab, pinned to the pane it is in right now, in every workspace
   *  that has a tree. */
  function freezePlacements() {
    const byWs = new Map<string, TabRef[]>();
    for (const t of unifiedTabs()) {
      const list = byWs.get(t.workspace) ?? [];
      list.push({ id: t.id, kind: t.kind });
      byWs.set(t.workspace, list);
    }
    for (const [ws, tabs] of byWs) {
      const root = layoutRoot(ws);
      if (root) pinCurrentPlacements(ws, root, tabs);
    }
  }

  // The pin rules are the user's, but the layout layer never imports settings
  // (it would be a cycle, and a pure resolver would stop being one). The shell
  // pushes them in instead, and re-pushes when the file changes under it.
  //
  // A *change* freezes what is open first: a tab nobody moved resolves through
  // the rule, so a new rule would otherwise carry the whole strip across the
  // window rather than routing what opens next.
  createEffect(
    on(
      () => ({ ...settings.panePins }),
      (next, prev) => {
        if (prev) freezePlacements();
        setPinSides(next);
      },
    ),
  );

  // ---- Pane layout (plan phase 5) ----------------------------------------
  // The work-split renders from the per-workspace pane envelope. A workspace
  // starts as one pane holding every kind (phase 12); the legacy
  // sway.layout.v1 fields still describe the sidebar and the chrome, and are
  // still written below so an older build reads a sane layout back.
  const wsKey = () => selected()?.folderPath ?? "";
  const seedEnvelope = () => seedOnePane();
  const env = () => envelopeFor(wsKey(), seedEnvelope);
  createEffect(() => ensureEnvelope(wsKey(), seedEnvelope));
  const paneLeaves = () => leaves(env().layout);
  // Where each kind opens, so the shell knows which pane is the editor (chrome
  // and role) and which the terminal, wherever a move has since put them.
  const filePane = () => homePane(wsKey(), "file", env().layout);
  const termPane = () => homePane(wsKey(), "shell", env().layout);
  const tabRefs = (): TabRef[] => unifiedTabs().filter((t) => t.workspace === wsKey());
  // The topbar toggles and the legacy layout key still speak of "the terminal"
  // and "the editor": they mean the pane each kind opens into, wherever a move
  // has since put it.
  const paneShown = (id: string | null) => {
    const leaf = id ? findPane(env().layout, id) : null;
    return !!leaf && !leaf.hidden;
  };
  const showTerminal = () => paneShown(termPane());
  const showEditor = () => paneShown(filePane());

  // ---- Pane bounds -------------------------------------------------------
  // A floor in JS, in the same scaled px its CSS counterparts use.
  const px = (base: number) => base * chromeScale();
  // The layout row's own width, the one measurement all the bounds derive from.
  // `.body` spans the window, so innerWidth is a correct opening value and the
  // observer only refines it (which keeps the clamp below honest on first paint,
  // before anything has been measured).
  let bodyEl: HTMLDivElement | undefined;
  const [bodyW, setBodyW] = createSignal(window.innerWidth);
  onMount(() => {
    if (!bodyEl) return;
    const ro = new ResizeObserver(([entry]) => setBodyW(entry.contentRect.width));
    ro.observe(bodyEl);
    onCleanup(() => ro.disconnect());
  });
  // Room the resizable panes actually share, once the gutters and padding on the
  // current layout are accounted for.
  const shared = () =>
    bodyW() -
    px(WORKSPACE_PAD) -
    px(showSidebar() ? GUTTER : WORKSPACE_PAD) -
    (showTerminal() && showEditor() ? px(GUTTER) : 0);
  // The pane that absorbs the slack is chat, or the editor when chat is hidden
  // (`.pane.editor.fill`).
  const fillerMin = () => px(showTerminal() ? CHAT_MIN : EDITOR_MIN);
  // Dragging one divider leaves the other pane where it is, so each ceiling is
  // everything left over after the pane opposite it and the filler's floor. Both
  // are read at pointerdown, when the layout is settled, so a drag runs against
  // a fixed ceiling rather than a measurement chasing it frame by frame.
  const sidebarMax = () =>
    Math.max(
      px(SIDEBAR_MIN),
      shared() - (showTerminal() && showEditor() ? editor() : 0) - fillerMin(),
    );
  const editorMax = () =>
    Math.max(px(EDITOR_MIN), shared() - (showSidebar() ? sidebar() : 0) - px(CHAT_MIN));

  // The editor pane's width, from its stored share of the split. Clamped at
  // render rather than in the model: the stored share is what the user chose,
  // so a narrower window (or a UI scale turned up) squeezes the pane for now
  // and widening it restores the choice.
  const editor = () => {
    const id = filePane();
    const r = id ? findPane(env().layout, id) : null;
    if (!r || paneLeaves().length < 2) return 0;
    return Math.min(Math.max((r.size / 100) * shared(), px(EDITOR_MIN)), editorMax());
  };
  // The tree's own dividers write straight to the model (PaneTree measures each
  // split itself); the legacy px width above is only still computed so an older
  // build reading sway.layout.v1 finds a sane one.
  function resizePaneTo(paneId: string, percent: number) {
    updateLayout(wsKey(), (t) => resizePane(t, paneId, percent), { persist: false });
  }

  // What the sidebar renders at. Same deal as the editor pane above: the stored
  // width is the user's choice and nothing but a drag rewrites it, so a narrower
  // window squeezes the sidebar for now and widening it hands the choice back.
  const sidebarW = () => Math.min(Math.max(sidebar(), px(SIDEBAR_MIN)), sidebarMax());

  const [selected, setSelected] = createSignal<Selection | null>(loadSelection());
  // The tree the shell renders. Two same-shape worktrees are two envelope
  // objects and PaneTree keys children by reference, so a switch between them
  // would dispose live subtrees; handing the drawn nodes back makes it a no-op.
  // Created here, not beside `env`: a memo runs on the spot, so `selected` must
  // already exist.
  const renderedLayout = createMemo<PaneNode>((prev) => reuseNode(prev, env().layout));
  // Width the topbar rail collapses to when the sidebar is hidden, so the
  // breadcrumb never slides under the traffic lights. Measured from the real
  // WindowControls cluster on mount (falls back to ~88px).
  let railEl: HTMLDivElement | undefined;
  const [railFallback, setRailFallback] = createSignal(88);
  // Live terminal tabs, surfaced from the terminal area so the sidebar's confirms
  // can count what is actually running in a folder.
  const [liveTabs, setLiveTabs] = createSignal<LiveTab[]>([]);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  // What the Settings panel's filter box opens with. A `Preferences: ...`
  // command for a setting nothing can toggle (a font stack, a dollar ceiling)
  // opens the panel *at* it rather than guessing at a value. Cleared on close,
  // so opening Settings by hand is the whole panel again.
  //
  // `equals: false` because the panel may already be open: running the same row
  // twice writes the same string, and a signal that swallowed it would leave the
  // filter wherever the user had since typed.
  const [settingsQuery, setSettingsQuery] = createSignal("", { equals: false });
  // The catalogue id the command pointed at, which the panel scrolls to, focuses
  // and flashes. `equals: false` for `settingsQuery`'s reason: running the same
  // row twice must re-reveal the row, not be swallowed as "no change".
  const [settingsEntry, setSettingsEntry] = createSignal<string | undefined>(undefined, {
    equals: false,
  });
  // The omnibox's opening prefix, and `null` for "not open". One signal where
  // there were two, because there is one overlay: an open flag per shortcut is
  // what let ⌘P and ⌘K be two boxes in the first place. A fresh object per open
  // so the `keyed` Show below remounts, which is what lets ⌘K over an already
  // open box put it in `>` mode instead of leaving it wherever it was.
  const [omnibox, setOmnibox] = createSignal<{ prefix: string } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  // First run: Settings opens on the Agents cards with a welcome note. The
  // backend decides (it scans every adapter's sessions dir and checks a
  // persisted flag), so there is nothing here to race against the sidebar's
  // own async load. Cleared as soon as the panel closes, so reopening Settings
  // by hand is the ordinary panel.
  const [welcome, setWelcome] = createSignal(false);

  createEffect(() => {
    const s = selected();
    try {
      if (s) localStorage.setItem(LS_SELECTION, JSON.stringify(s));
      else localStorage.removeItem(LS_SELECTION);
    } catch {
      // ignore
    }
  });

  // The workspace flip has been applied; the paint endpoint is the frame after
  // the one that draws it. The span itself was opened by the sidebar click, so
  // whatever ran before this (a checkout, say) is inside the measurement.
  createEffect(
    on(
      () => selected()?.folderPath ?? null,
      () => {
        traceMark("ws:flip");
        tracePaint();
      },
      { defer: true },
    ),
  );

  // The selection signal and the pane tree are what the scripted perf recipe
  // cannot reach on its own. Registered unconditionally and consulted only by a
  // run launched with SWAY_RECIPE, which is the only thing that loads the driver
  // at all. `leaves` is read from the model rather than counted in the DOM: the
  // mismatch pass has to prove the split it asked for survived, and a count of
  // rendered panes would answer with what the renderer did instead.
  onMount(() =>
    registerRecipeHost({
      select: (s) => setSelected(s as Selection),
      leaves: () => paneLeaves().length,
    }),
  );

  function persistLayout() {
    try {
      localStorage.setItem(
        LS_LAYOUT,
        JSON.stringify({
          sidebar: sidebar(),
          // One pane has no editor width to describe, and the bound above wants
          // that zero. What gets written keeps the last real one instead: an
          // older build reads this key as a pane's width, and would take the
          // zero for a pane squeezed shut (phase 12).
          editor: editor() || initial.editor,
          showSidebar: showSidebar(),
          showTerminal: showTerminal(),
          showEditor: showEditor(),
          showFiletree: showFiletree(),
        }),
      );
    } catch {
      // ignore
    }
  }

  // Moving focus off a pane before it is hidden keeps window/global hotkeys
  // firing without a click: a still-focused element inside a display:none pane
  // would otherwise strand focus (or keep an xterm textarea swallowing keys).
  function blurIfInside(selector: string) {
    const el = document.activeElement as HTMLElement | null;
    if (el && el.closest(selector)) el.blur();
  }

  function toggleSidebar() {
    if (showSidebar()) blurIfInside(".pane.sidebar");
    setShowSidebar((v) => !v);
    persistLayout();
  }
  // Cmd+Alt+J/E act on the pane holding the most recently focused tab of
  // their kind, falling back to the kind's pin pane when no such tab is open
  // (plan phase 5). Hiding the last visible pane is refused by the layout
  // layer: an empty work-card has no button left to undo itself with (the
  // topbar toggle is also disabled then).
  const TERMINAL_KINDS = ["shell", "agent", "command", "chat", "task"];
  function togglePaneFor(kinds: string[], pinKind: string) {
    const ws = wsKey();
    ensureEnvelope(ws, seedEnvelope);
    const root = env().layout;
    const matches = unifiedTabs()
      .filter((t) => t.workspace === ws && kinds.includes(t.kind))
      .map((t) => ({
        paneId: resolvePinPane(root, t.kind, pinRulesFor(ws, t.kind))?.id ?? "",
        stamp: tabFocusStamp(t.id),
      }));
    const target = resolveTogglePane(root, matches, pinKind);
    const pane = target ? findPane(root, target) : null;
    if (!pane) return;
    // With one pane there is nothing to hide (the layout layer refuses it, and
    // an empty work card has no button left to undo itself with), so the
    // toggle means the only other thing it could: show me that kind.
    if (!pane.hidden && visibleLeaves(root).length === 1) {
      showKindIn(ws, pane.id, kinds);
      return;
    }
    if (pane.hidden) {
      updateLayout(ws, (r) => setPaneHidden(r, pane.id, false));
    } else {
      const next = setPaneHidden(root, pane.id, true);
      if (!next) return;
      blurIfInside(`[data-pane-id="${pane.id}"]`);
      updateLayout(ws, () => next);
    }
    persistLayout();
  }
  /** Bring a kind's most recently focused tab to the front of a pane. The
   *  kind's own `activate` is what makes its store claim the tab, which is what
   *  the pane reads back as active. */
  function showKindIn(ws: string, paneId: string, kinds: string[]) {
    const here = paneTabs(ws, paneId).filter((t) => kinds.includes(t.kind));
    if (here.length === 0) return;
    const pick = here.reduce((a, b) => (tabFocusStamp(b.id) > tabFocusStamp(a.id) ? b : a));
    setPaneActive(ws, paneId, pick.id);
    maybeKindEntry(pick.kind)?.activate(pick);
  }

  function toggleTerminal() {
    togglePaneFor(TERMINAL_KINDS, "chat");
  }
  function toggleEditor() {
    togglePaneFor(["file"], "file");
  }
  // ---- Splits and tab moves (plan phase 8) --------------------------------
  const say = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "info" });
  const activePane = () => focusedPaneId(wsKey()) ?? visibleLeaves(env().layout)[0]?.id ?? null;

  // Ids the tree owns forever (a pane's id is what keeps its tabs and its DOM),
  // so a new one only has to be unused in this workspace's tree.
  function mintPaneId(): string {
    const taken = new Set(paneLeaves().map((l) => l.id));
    let n = 1;
    while (taken.has(`pane-${n}`)) n++;
    return `pane-${n}`;
  }

  /** Split a pane, optionally carrying one tab into the new one, which is what
   *  a drop on a pane's edge asks for (plan phase 10). */
  function splitPaneFor(p: SplitPane) {
    const ws = wsKey();
    ensureEnvelope(ws, seedEnvelope);
    const from = p.paneId ?? activePane();
    if (!from) return;
    const leaf: PaneLeaf = { type: "pane", id: mintPaneId(), size: 50, hidden: false };
    if (!updateLayout(ws, (r) => splitPane(r, from, p.dir, leaf, p.pos))) {
      say(
        paneLeaves().length >= MAX_PANES
          ? `${MAX_PANES} panes is as many as fit.`
          : "That pane is already nested as deep as it goes.",
      );
      return;
    }
    setFocusedPane(ws, leaf.id);
    persistLayout();
    // After the tree edit: the pane has to exist for the placement guard to
    // accept it. A refusal would leave the new pane empty, and the collapse
    // effect only takes panes that have held a tab, so it says so out loud.
    if (p.tabId) moveTab({ tabId: p.tabId, kind: p.kind, paneId: leaf.id });
  }

  /** Close a pane, its tabs going to the neighbor (right first, then left).
   *  Nothing is dropped: the merge runs while the pane still exists. */
  function closePaneWithTabs(paneId: string) {
    const ws = wsKey();
    const root = env().layout;
    const to = neighborPane(root, paneId);
    if (!to) {
      say("This is the last pane.");
      return;
    }
    mergePaneInto({ ws, from: paneId, to, root, tabsInWs: tabRefs() });
    updateLayout(ws, (r) => closePane(r, paneId));
    setFocusedPane(ws, to);
    persistLayout();
  }

  /** The pane a "move it over" step lands in: the next visible one, wrapping. */
  function stepPane(from: string, direction: "next" | "prev"): string | null {
    const vis = visibleLeaves(env().layout);
    if (vis.length < 2) return null;
    const i = vis.findIndex((l) => l.id === from);
    if (i < 0) return null;
    return vis[(i + (direction === "prev" ? vis.length - 1 : 1)) % vis.length].id;
  }

  function moveTab(p: MoveTabToPane) {
    const ws = wsKey();
    const root = env().layout;
    const tabs = tabRefs();
    const pane = activePane();
    const tab = p.tabId
      ? tabs.find((t) => t.id === p.tabId)
      : tabs.find((t) => pane && t.id === paneActiveId(ws, pane));
    if (!tab) {
      say("No tab to move.");
      return;
    }
    const from = paneOfTab(ws, tab, root);
    const target = p.paneId ?? (from ? stepPane(from, p.direction ?? "next") : null);
    if (!target) {
      say("There is only one pane. Split it first.");
      return;
    }
    // The placement guard's refusal is a sentence, not a silence (phase 8's
    // interim single-pane rule for files says so here).
    const refusal = moveTabToPane({ ws, tab, targetPaneId: target, root, tabsInWs: tabs });
    if (refusal) {
      say(refusal);
      return;
    }
    // A drop names the slot it landed on; the palette and the menu append.
    if (p.index != null) {
      const list = paneTabs(ws, target);
      const moved = list.find((t) => t.id === tab.id);
      if (moved) {
        const rest = list.filter((t) => t.id !== tab.id);
        rest.splice(Math.max(0, Math.min(p.index, rest.length)), 0, moved);
        reorderPane(ws, rest);
      }
    }
    updateLayout(ws, (r) => setPaneHidden(r, target, false));
    setFocusedPane(ws, target);
    // The move can reveal a hidden pane, and the legacy key carries visibility.
    persistLayout();
  }

  // A pane that has held a tab and is now empty collapses into its neighbor.
  // A pane that has never held one is a fresh split waiting for its first, and
  // the last pane standing stays whatever it holds: the pin rule resolves
  // spatially at call time, so whatever is left is where the next tab lands.
  // Keyed by workspace too: pane ids repeat across workspaces, and a fresh
  // split named after one that held tabs elsewhere would collapse on sight.
  const held = new Set<string>();
  createEffect(() => {
    const ws = wsKey();
    const root = env().layout;
    const solo = leaves(root).length < 2;
    let empty: string | null = null;
    for (const leaf of leaves(root)) {
      const key = `${ws}\u0000${leaf.id}`;
      if (paneTabs(ws, leaf.id).length > 0) held.add(key);
      else if (held.has(key) && !solo) empty = leaf.id;
    }
    if (empty) {
      held.delete(`${ws}\u0000${empty}`);
      forgetPane(ws, empty);
      updateLayout(ws, (r) => closePane(r, empty!));
    }
  });

  // What the tree needs from the shell: which pane plays which part, and where
  // the divider writes land.
  const paneRoles = (): PaneRoles => ({
    ws: wsKey(),
    pinKindOf: (id) => (id === filePane() ? "file" : "shell"),
    roleOf: (id) => (id === filePane() ? "editor" : id === termPane() ? "terminal" : "split"),
    px,
    onResize: resizePaneTo,
    onCommit: () => {
      persistEnvelopes();
      persistLayout();
    },
  });

  function revealEditorPane() {
    const r = filePane();
    if (r) updateLayout(wsKey(), (t) => setPaneHidden(t, r, false));
  }
  // Showing the file tree implies showing the editor it is nested in.
  function toggleFiletree() {
    const next = !showFiletree();
    setShowFiletree(next);
    if (next) revealEditorPane();
    persistLayout();
  }
  // User-initiated commands aimed at content inside the right panel (palette
  // "Show X", Cmd+Shift+F search) reveal both the editor and the file tree.
  // Passive triggers (the diagnostics auto-switch to Problems) never call this,
  // so they update the mode without popping a collapsed panel open.
  function revealRightPanel() {
    revealEditorPane();
    setShowFiletree(true);
    persistLayout();
  }

  // Refit on a reveal or a structural edit, after layout (the rAF).
  //
  // Remembered per workspace, since every input is a read of the *selected*
  // one: one shared set of previous values compares two workspaces' answers
  // across a switch and calls every switch a reveal.
  //
  // A workspace seen for the first time records and emits nothing (PaneView
  // refits on adoption), and so does a switch back to panes left as they were:
  // the activation edge and CodeMirror's hidden-pane effect cover the reveal.
  type PaneGeometry = { s: boolean; t: boolean; e: boolean; f: boolean; layout: PaneNode };
  const lastGeometry = new Map<string, PaneGeometry>();
  createEffect(() => {
    const ws = wsKey();
    const now: PaneGeometry = {
      s: showSidebar(),
      t: showTerminal(),
      e: showEditor(),
      f: showFiletree(),
      layout: env().layout,
    };
    const was = lastGeometry.get(ws);
    lastGeometry.set(ws, now);
    if (!was) return;
    const revealed =
      (now.s && !was.s) || (now.t && !was.t) || (now.e && !was.e) || (now.f && !was.f);
    if (revealed || now.layout !== was.layout) requestAnimationFrame(() => emit(REFIT_PANES));
  });

  // Every binding now comes from the canonical table in utils/hotkeys.ts,
  // including Cmd+P: the table marks it `window` scope so it still does not
  // fire while a terminal has focus, which is what the old special case here
  // achieved by living outside dispatchHotkey.
  function onKeyDown(e: KeyboardEvent) {
    if (dispatchWindowHotkey(e)) e.preventDefault();
  }

  let offOmnibox: (() => void) | undefined;
  let offShortcuts: (() => void) | undefined;
  let offZoomIn: (() => void) | undefined;
  let offZoomOut: (() => void) | undefined;
  let offZoomReset: (() => void) | undefined;
  let offReload: (() => void) | undefined;
  let offToggleSidebar: (() => void) | undefined;
  let offToggleTerminal: (() => void) | undefined;
  let offToggleEditor: (() => void) | undefined;
  let offToggleFiletree: (() => void) | undefined;
  let offSplitPane: (() => void) | undefined;
  let offClosePane: (() => void) | undefined;
  let offMoveTab: (() => void) | undefined;
  let offFocusSearch: (() => void) | undefined;
  let offProjectSearch: (() => void) | undefined;
  let offSetRightMode: (() => void) | undefined;
  let offStopChat: (() => void) | undefined;
  let offPrefsToggle: (() => void) | undefined;
  let offOpenSettings: (() => void) | undefined;
  let offRunLastTask: (() => void) | undefined;
  let offFocusIn: (() => void) | undefined;
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    // Which pane holds focus, for the per-workspace envelope. focusin bubbles
    // where focus does not, so one window listener sees every surface.
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const pane = el?.closest<HTMLElement>("[data-pane-id]");
      if (pane?.dataset.paneId) setFocusedPane(wsKey(), pane.dataset.paneId);
    };
    window.addEventListener("focusin", onFocusIn);
    offFocusIn = () => window.removeEventListener("focusin", onFocusIn);
    offOmnibox = onEventWith<OpenOmnibox>(OPEN_OMNIBOX, ({ prefix }) => setOmnibox({ prefix }));
    offShortcuts = onEvent(TOGGLE_SHORTCUTS, () => setShortcutsOpen((open) => !open));
    offZoomIn = onEvent(ZOOM_IN, zoomIn);
    offZoomOut = onEvent(ZOOM_OUT, zoomOut);
    offZoomReset = onEvent(ZOOM_RESET, resetZoom);
    offReload = onEvent(RELOAD_APP, () => location.reload());
    offToggleSidebar = onEvent(TOGGLE_SIDEBAR, toggleSidebar);
    offToggleTerminal = onEvent(TOGGLE_TERMINAL, toggleTerminal);
    offToggleEditor = onEvent(TOGGLE_EDITOR, toggleEditor);
    offToggleFiletree = onEvent(TOGGLE_FILETREE, toggleFiletree);
    offSplitPane = onEventWith<SplitPane>(SPLIT_PANE, splitPaneFor);
    offClosePane = onEvent(CLOSE_PANE, () => {
      const pane = activePane();
      if (pane) closePaneWithTabs(pane);
    });
    offMoveTab = onEventWith<MoveTabToPane>(MOVE_TAB_TO_PANE, moveTab);
    // Cmd+Shift+E focuses the sidebar filter: reveal the sidebar first if it is
    // collapsed (LeftSidebar defers the focus itself, so it lands after paint).
    offFocusSearch = onEvent(FOCUS_SEARCH, () => {
      if (!showSidebar()) {
        setShowSidebar(true);
        persistLayout();
      }
    });
    // Cmd+Shift+F search and the palette "Show X" actions are user-initiated
    // reveals of the right panel, so they un-hide the editor + file tree.
    offProjectSearch = onEvent(FOCUS_PROJECT_SEARCH, revealRightPanel);
    offSetRightMode = onEvent(SET_RIGHT_MODE, revealRightPanel);
    // The palette's `Preferences: ...` commands. Handled here rather than in the
    // Settings panel because the whole point is that they work with the panel
    // shut: the store is global, and a toggle that first had to open a modal
    // would be slower than the modal.
    offPrefsToggle = onEventWith<PrefsToggle>(PREFS_TOGGLE, ({ key }) => toggleEditorDefault(key));
    offOpenSettings = onEventWith<OpenSettings>(OPEN_SETTINGS, ({ query, entry }) => {
      setSettingsQuery(query ?? "");
      setSettingsEntry(entry);
      setSettingsOpen(true);
    });
    // Stop, from Cmd+. or from a named palette row. Handled here rather than in
    // the chat panel because the whole point is that it works while something
    // else has focus - and `chat_interrupt` needs nothing from the panel but a
    // session id.
    offStopChat = onEventWith<StopChat>(STOP_CHAT, ({ sessionId }) => {
      const target = sessionId ?? chatToStop(liveChats())?.sessionId ?? null;
      if (!target) {
        // Either nothing is running, or several are and none is on screen.
        // `chatToStop` deliberately will not choose between them, since a stop
        // cannot be undone - so say which case it is and where to be explicit.
        const running = stoppableChats(liveChats());
        emitWith<ToastEvent>(TOAST, {
          message: running.length
            ? `${running.length} chats are running. Pick one from the command palette (⌘K) or stop it from its own tab.`
            : "Nothing is running.",
          kind: "info",
        });
        return;
      }
      invoke("chat_interrupt", { sessionId: target }).catch((e) =>
        emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }),
      );
    });
    // Rerun the last task, from ⌘⇧B or its palette row. Handled here because the
    // registry owns the binding but knows no workspace, and the Tasks panel is
    // torn down whenever another right-hand mode is showing - a rerun that only
    // worked while its own panel was open would not be a shortcut past it.
    offRunLastTask = onEvent(RUN_LAST_TASK, () => {
      const outcome = rerunLast(selected()?.folderPath ?? null);
      if (outcome === "ran") return;
      emitWith<ToastEvent>(TOAST, {
        message:
          outcome === "no-workspace"
            ? "Select a branch first."
            : "No task has been run here yet. Pick one from the Tasks panel.",
        kind: "info",
      });
    });
    // Collapse the rail to the intrinsic width of the top-left cluster (lights
    // + toggles), so a hidden sidebar still keeps the breadcrumb clear of them.
    // The cluster fills the rail (flex:1) to right-align the toggles, so its own
    // box width is the rail width; sum the children (plus gaps + padding) to get
    // the content width the collapsed rail should reserve.
    const wc = railEl?.firstElementChild as HTMLElement | null;
    if (wc) {
      const cs = getComputedStyle(wc);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const gap = parseFloat(cs.columnGap) || 0;
      const kids = Array.from(wc.children) as HTMLElement[];
      const content = kids.reduce((s, c) => s + c.offsetWidth, 0) + gap * Math.max(0, kids.length - 1);
      setRailFallback(Math.ceil(content + padX));
    }
    initSettings();
    // Sway no longer imports VS Code themes. An install that had one has been
    // migrated to a bundled palette, so say so once, naming the file, rather
    // than letting the user discover their theme changed on its own. The
    // backend owns the once-ness (a state.json flag), so a repeated call is a
    // no-op and this never becomes a launch nag.
    invoke<string | null>("take_theme_import_notice")
      .then((path) => {
        if (!path) return;
        emitWith<ToastEvent>(TOAST, {
          message: `Imported VS Code themes are no longer supported, so ${path} was dropped. Sway now ships named themes; pick one in Settings.`,
          kind: "info",
        });
      })
      .catch(() => {
        // Never block startup on a notice.
      });
    // Mark shown on display, not on dismiss: a user who quits mid-welcome has
    // still seen it, and showing it again every launch would be the nag this
    // flag exists to prevent.
    invoke<boolean>("onboarding_should_show")
      .then((show) => {
        if (!show) return;
        setWelcome(true);
        setSettingsOpen(true);
        return invoke("onboarding_mark_shown");
      })
      .catch(() => {
        // A failed check just means no onboarding; never block startup on it.
      });
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    offOmnibox?.();
    offShortcuts?.();
    offZoomIn?.();
    offZoomOut?.();
    offZoomReset?.();
    offReload?.();
    offToggleSidebar?.();
    offToggleTerminal?.();
    offToggleEditor?.();
    offToggleFiletree?.();
    offSplitPane?.();
    offClosePane?.();
    offMoveTab?.();
    offStopChat?.();
    offFocusSearch?.();
    offProjectSearch?.();
    offSetRightMode?.();
    offPrefsToggle?.();
    offOpenSettings?.();
    offRunLastTask?.();
    offFocusIn?.();
    document.body.classList.remove("dragging");
  });

  return (
    <div class="app">
      <header class="topbar" data-tauri-drag-region>
        <div
          class="topbar-rail"
          ref={railEl}
          style={{ width: `${showSidebar() ? sidebarW() : railFallback()}px` }}
        >
          <WindowControls showSidebar={showSidebar()} />
        </div>
        <Toolbar selected={selected()} />
        <UpdatePill suppressed={welcome()} />
        <Button
          class="topbar-gear"
          variant="ghost"
          aria-label="Settings"
          tooltip="Settings"
          onClick={() => setSettingsOpen(true)}
          icon={<Icon icon={SettingsIcon} />}
        />
      </header>

      <div class="body" ref={bodyEl}>
        <aside
          class="pane sidebar"
          classList={{ hidden: !showSidebar() }}
          style={{ width: `${sidebarW()}px` }}
        >
          <div class="pane-body tree-body">
            <LeftSidebar selected={selected()} onSelect={setSelected} liveTabs={liveTabs()} />
          </div>
        </aside>

        <Show when={showSidebar()}>
          <Resizer
            side="before"
            value={sidebarW()}
            min={px(SIDEBAR_MIN)}
            max={sidebarMax()}
            onInput={setSidebar}
            onCommit={persistLayout}
          />
        </Show>

        <div class="workspace" classList={{ "no-sidebar": !showSidebar() }}>
          {/* Both panels are service hosts (phase 7): they render surfaces into
              stage hosts and no visible DOM of their own, so they sit beside
              the tree rather than in a pane of it. */}
          <Terminal selected={selected()} onOpenChange={setLiveTabs} onboarding={welcome()} />
          <Editor
            selected={selected()}
            liveTabs={liveTabs()}
            showFiletree={showFiletree()}
            onToggleFiletree={toggleFiletree}
          />
          <div class="work-split">
            <PaneTree node={renderedLayout()} roles={paneRoles()} />
            {/* Workspace chrome, not a pane's (phase 12): the file tree and the
                right panel belong to the workspace the way the sidebar does, so
                they stay put through every split, move and close. */}
            <div class="chrome-slot" ref={(el) => el.appendChild(stageHost("editor-chrome"))} />
          </div>
        </div>
      </div>

      <Show when={omnibox()} keyed>
        {(open) => (
          <Omnibox
            prefix={open.prefix}
            selected={selected()}
            onOpenSettings={() => setSettingsOpen(true)}
            onClose={() => setOmnibox(null)}
          />
        )}
      </Show>

      <Show when={settingsOpen()}>
        <Settings
          welcome={welcome()}
          query={settingsQuery()}
          entry={settingsEntry()}
          onClose={() => (
            setSettingsOpen(false),
            setWelcome(false),
            setSettingsQuery(""),
            setSettingsEntry(undefined)
          )}
        />
      </Show>

      <Show when={shortcutsOpen()}>
        <ShortcutSheet onClose={() => setShortcutsOpen(false)} />
      </Show>

      <AskpassDialog />
      <ToastRegion />
    </div>
  );
}

export default App;
