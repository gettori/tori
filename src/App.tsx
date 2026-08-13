import { createSignal, createEffect, onMount, onCleanup, lazy, Suspense, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import LeftSidebar, { type Selection } from "./panels/LeftSidebar/LeftSidebar";
import Terminal from "./panels/Terminal/Terminal";
import Editor from "./panels/Editor/Editor";
import Toolbar from "./components/Toolbar/Toolbar";
import WindowControls from "./components/WindowControls/WindowControls";
import Resizer from "./components/Resizer/Resizer";
import AskpassDialog from "./components/Dialogs/AskpassDialog";
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
import { chatToStop, liveChats, stoppableChats } from "./utils/chatSessions";
import { rerunLast } from "./utils/runTask";
import Omnibox from "./components/Omnibox/Omnibox";
import ShortcutSheet from "./components/ShortcutSheet/ShortcutSheet";
import {
  chromeScale,
  initSettings,
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
  const [editor, setEditor] = createSignal(initial.editor);
  const [showSidebar, setShowSidebar] = createSignal(initial.showSidebar);
  const [showTerminal, setShowTerminal] = createSignal(initial.showTerminal);
  const [showEditor, setShowEditor] = createSignal(initial.showEditor);
  const [showFiletree, setShowFiletree] = createSignal(initial.showFiletree);

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

  // The drag clamp only bites while a pointer is down, so a width restored from a
  // wider display, a window since made narrower, or a UI scale since turned up
  // would apply verbatim and could push a pane (and the divider that resizes it)
  // out of reach. Re-clamp whenever any of those change. Deliberately not
  // persisted: the stored width is what the user chose on the display they chose
  // it on, so unplugging a monitor narrows the pane for now and plugging it back
  // in restores the width.
  createEffect(() => {
    const s = Math.min(Math.max(sidebar(), px(SIDEBAR_MIN)), sidebarMax());
    if (s !== sidebar()) setSidebar(s);
    const e = Math.min(Math.max(editor(), px(EDITOR_MIN)), editorMax());
    if (e !== editor()) setEditor(e);
  });

  const [selected, setSelected] = createSignal<Selection | null>(loadSelection());
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

  function persistLayout() {
    try {
      localStorage.setItem(
        LS_LAYOUT,
        JSON.stringify({
          sidebar: sidebar(),
          editor: editor(),
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
  // Terminal and editor are guarded: hiding the last visible one would leave the
  // work-card empty, so it is refused (the topbar button is also disabled then).
  function toggleTerminal() {
    if (showTerminal() && !showEditor()) return;
    if (showTerminal()) blurIfInside(".pane.terminal");
    setShowTerminal((v) => !v);
    persistLayout();
  }
  function toggleEditor() {
    if (showEditor() && !showTerminal()) return;
    if (showEditor()) blurIfInside(".pane.editor");
    setShowEditor((v) => !v);
    persistLayout();
  }
  // Showing the file tree implies showing the editor it is nested in.
  function toggleFiletree() {
    const next = !showFiletree();
    setShowFiletree(next);
    if (next) setShowEditor(true);
    persistLayout();
  }
  // User-initiated commands aimed at content inside the right panel (palette
  // "Show X", Cmd+Shift+F search) reveal both the editor and the file tree.
  // Passive triggers (the diagnostics auto-switch to Problems) never call this,
  // so they update the mode without popping a collapsed panel open.
  function revealRightPanel() {
    setShowEditor(true);
    setShowFiletree(true);
    persistLayout();
  }

  // Refit-on-reveal, centralized: whenever a pane transitions hidden -> shown,
  // tell the terminal to refit and CodeMirror to re-measure, so every reveal
  // path (button, hotkey, coupling) is covered without depending on a
  // ResizeObserver tick that a display:none -> block flip can miss.
  let prevS = showSidebar();
  let prevT = showTerminal();
  let prevE = showEditor();
  let prevF = showFiletree();
  createEffect(() => {
    const s = showSidebar();
    const t = showTerminal();
    const e = showEditor();
    const f = showFiletree();
    const revealed = (s && !prevS) || (t && !prevT) || (e && !prevE) || (f && !prevF);
    prevS = s;
    prevT = t;
    prevE = e;
    prevF = f;
    if (revealed) requestAnimationFrame(() => emit(REFIT_PANES));
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
  let offFocusSearch: (() => void) | undefined;
  let offProjectSearch: (() => void) | undefined;
  let offSetRightMode: (() => void) | undefined;
  let offStopChat: (() => void) | undefined;
  let offPrefsToggle: (() => void) | undefined;
  let offOpenSettings: (() => void) | undefined;
  let offRunLastTask: (() => void) | undefined;
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
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
    offStopChat?.();
    offFocusSearch?.();
    offProjectSearch?.();
    offSetRightMode?.();
    offPrefsToggle?.();
    offOpenSettings?.();
    offRunLastTask?.();
    document.body.classList.remove("dragging");
  });

  return (
    <div class="app">
      <header class="topbar" data-tauri-drag-region>
        <div
          class="topbar-rail"
          ref={railEl}
          style={{ width: `${showSidebar() ? sidebar() : railFallback()}px` }}
        >
          <WindowControls
            showSidebar={showSidebar()}
            showTerminal={showTerminal()}
            showEditor={showEditor()}
          />
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
          style={{ width: `${sidebar()}px` }}
        >
          <div class="pane-body tree-body">
            <LeftSidebar selected={selected()} onSelect={setSelected} liveTabs={liveTabs()} />
          </div>
        </aside>

        <Show when={showSidebar()}>
          <Resizer
            side="before"
            value={sidebar()}
            min={px(SIDEBAR_MIN)}
            max={sidebarMax()}
            onInput={setSidebar}
            onCommit={persistLayout}
          />
        </Show>

        <div class="workspace" classList={{ "no-sidebar": !showSidebar() }}>
          <div class="work-split">
            <main class="pane terminal" classList={{ hidden: !showTerminal() }}>
              <Terminal selected={selected()} onOpenChange={setLiveTabs} onboarding={welcome()} />
            </main>
            <Show when={showTerminal() && showEditor()}>
              <Resizer
                side="after"
                variant="hairline"
                value={editor()}
                min={px(EDITOR_MIN)}
                max={editorMax()}
                onInput={setEditor}
                onCommit={persistLayout}
              />
            </Show>
            <section
              class="pane editor"
              classList={{ hidden: !showEditor(), fill: !showTerminal() }}
              style={{ width: showTerminal() ? `${editor()}px` : undefined }}
            >
              <Editor
                selected={selected()}
                liveTabs={liveTabs()}
                showFiletree={showFiletree()}
                onToggleFiletree={toggleFiletree}
              />
            </section>
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
    </div>
  );
}

export default App;
