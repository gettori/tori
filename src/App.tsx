import { createSignal, createEffect, onMount, onCleanup, lazy, Suspense, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import LeftSidebar, { type Selection } from "./panels/LeftSidebar/LeftSidebar";
import Terminal from "./panels/Terminal/Terminal";
import Editor from "./panels/Editor/Editor";
import Toolbar from "./components/Toolbar/Toolbar";
import WindowControls from "./components/WindowControls/WindowControls";
import QuickOpen from "./components/QuickOpen/QuickOpen";
import AskpassDialog from "./components/Dialogs/AskpassDialog";
import Settings from "./panels/Settings/Settings";
import UpdatePill from "./components/UpdatePill/UpdatePill";
import Button from "./components/Button/Button";
import Icon from "./components/Icon/Icon";
import { Settings as SettingsIcon } from "lucide-solid";
import {
  on as onEvent,
  OPEN_PALETTE,
  OPEN_QUICK_OPEN,
  TOGGLE_SHORTCUTS,
  ZOOM_IN,
  ZOOM_OUT,
  ZOOM_RESET,
  RELOAD_APP,
  type LiveTab,
} from "./utils/events";
import { dispatchWindowHotkey } from "./utils/hotkeys";
import CommandPalette from "./components/CommandPalette/CommandPalette";
import ShortcutSheet from "./components/ShortcutSheet/ShortcutSheet";
import { initSettings, zoomIn, zoomOut, resetZoom } from "./panels/Settings/settingsStore";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./App.css";

// Dev-only styleguide, code-split so it never ships in the production bundle.
const Styleguide = lazy(() => import("./dev/Styleguide"));

const LS_LAYOUT = "sway.layout.v1";
const LS_SELECTION = "sway.selection.v1";

type Layout = { sidebar: number; editor: number };

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LS_LAYOUT);
    if (raw) {
      const v = JSON.parse(raw);
      return { sidebar: v.sidebar ?? 280, editor: v.editor ?? 640 };
    }
  } catch {
    // ignore
  }
  return { sidebar: 280, editor: 640 };
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
  // density/scale/theme controls.
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
  const [selected, setSelected] = createSignal<Selection | null>(loadSelection());
  // Live terminal tabs, surfaced from the terminal area so the sidebar's confirms
  // can count what is actually running in a folder.
  const [liveTabs, setLiveTabs] = createSignal<LiveTab[]>([]);
  const [quickOpen, setQuickOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
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
      localStorage.setItem(LS_LAYOUT, JSON.stringify({ sidebar: sidebar(), editor: editor() }));
    } catch {
      // ignore
    }
  }

  function startDrag(
    e: PointerEvent,
    get: () => number,
    set: (n: number) => void,
    edge: "left" | "right",
  ) {
    e.preventDefault();
    const startX = e.clientX;
    const startVal = get();
    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const next = edge === "left" ? startVal + dx : startVal - dx;
      set(Math.max(180, Math.min(1000, next)));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("dragging");
      persistLayout();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("dragging");
  }

  // Every binding now comes from the canonical table in utils/hotkeys.ts,
  // including Cmd+P: the table marks it `window` scope so it still does not
  // fire while a terminal has focus, which is what the old special case here
  // achieved by living outside dispatchHotkey.
  function onKeyDown(e: KeyboardEvent) {
    if (dispatchWindowHotkey(e)) e.preventDefault();
  }

  let offPalette: (() => void) | undefined;
  let offQuickOpen: (() => void) | undefined;
  let offShortcuts: (() => void) | undefined;
  let offZoomIn: (() => void) | undefined;
  let offZoomOut: (() => void) | undefined;
  let offZoomReset: (() => void) | undefined;
  let offReload: (() => void) | undefined;
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    offPalette = onEvent(OPEN_PALETTE, () => setPaletteOpen(true));
    offQuickOpen = onEvent(OPEN_QUICK_OPEN, () => setQuickOpen(true));
    offShortcuts = onEvent(TOGGLE_SHORTCUTS, () => setShortcutsOpen((open) => !open));
    offZoomIn = onEvent(ZOOM_IN, zoomIn);
    offZoomOut = onEvent(ZOOM_OUT, zoomOut);
    offZoomReset = onEvent(ZOOM_RESET, resetZoom);
    offReload = onEvent(RELOAD_APP, () => location.reload());
    initSettings();
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
    offPalette?.();
    offQuickOpen?.();
    offShortcuts?.();
    offZoomIn?.();
    offZoomOut?.();
    offZoomReset?.();
    offReload?.();
    document.body.classList.remove("dragging");
  });

  return (
    <div class="app">
      <header class="topbar" data-tauri-drag-region>
        <div class="topbar-rail" style={{ width: `${sidebar()}px` }}>
          <WindowControls />
        </div>
        <Toolbar selected={selected()} />
        <UpdatePill suppressed={welcome()} />
        <Button
          class="topbar-gear"
          variant="ghost"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
          icon={<Icon icon={SettingsIcon} />}
        />
      </header>

      <div class="body">
        <aside class="pane sidebar" style={{ width: `${sidebar()}px` }}>
          <div class="pane-body tree-body">
            <LeftSidebar selected={selected()} onSelect={setSelected} liveTabs={liveTabs()} />
          </div>
        </aside>

        <div class="splitter" onPointerDown={(e) => startDrag(e, sidebar, setSidebar, "left")} />

        <div class="workspace">
          <div class="work-split">
            <main class="pane terminal">
              <Terminal selected={selected()} onOpenChange={setLiveTabs} onboarding={welcome()} />
            </main>
            <div class="splitter" onPointerDown={(e) => startDrag(e, editor, setEditor, "right")} />
            <section class="pane editor" style={{ width: `${editor()}px` }}>
              <Editor selected={selected()} liveTabs={liveTabs()} />
            </section>
          </div>
        </div>
      </div>

      <Show when={quickOpen()}>
        <QuickOpen root={selected()?.folderPath ?? null} onClose={() => setQuickOpen(false)} />
      </Show>

      <Show when={paletteOpen()}>
        <CommandPalette
          selected={selected()}
          onSelect={setSelected}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setPaletteOpen(false)}
        />
      </Show>

      <Show when={settingsOpen()}>
        <Settings
          welcome={welcome()}
          onClose={() => (setSettingsOpen(false), setWelcome(false))}
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
