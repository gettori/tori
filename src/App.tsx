import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import LeftSidebar, { type Selection } from "./panels/LeftSidebar/LeftSidebar";
import Terminal from "./panels/Terminal/Terminal";
import Editor from "./panels/Editor/Editor";
import Toolbar from "./components/Toolbar";
import WindowControls from "./components/WindowControls/WindowControls";
import QuickOpen from "./components/QuickOpen/QuickOpen";
import AskpassDialog from "./components/Dialogs/AskpassDialog";
import Settings from "./panels/Settings/Settings";
import { emit, FOCUS_SEARCH, FOCUS_TERMINAL } from "./events";
import { initSettings } from "./settings";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./App.css";

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
      return s;
    }
  } catch {
    // ignore
  }
  return null;
}

function App() {
  const initial = loadLayout();
  const [sidebar, setSidebar] = createSignal(initial.sidebar);
  const [editor, setEditor] = createSignal(initial.editor);
  const [selected, setSelected] = createSignal<Selection | null>(loadSelection());
  const [quickOpen, setQuickOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

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

  function onKeyDown(e: KeyboardEvent) {
    if (!e.metaKey) return;
    if (e.key === "p") {
      e.preventDefault();
      setQuickOpen(true);
    } else if (e.key === "1") {
      e.preventDefault();
      emit(FOCUS_SEARCH);
    } else if (e.key === "2") {
      e.preventDefault();
      emit(FOCUS_TERMINAL);
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    initSettings();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    document.body.classList.remove("dragging");
  });

  return (
    <div class="app">
      <header class="topbar" data-tauri-drag-region>
        <WindowControls />
        <Toolbar selected={selected()} />
        <button class="topbar-gear" title="Settings" onClick={() => setSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      <div class="body">
        <aside class="pane sidebar" style={{ width: `${sidebar()}px` }}>
          <div class="pane-body tree-body">
            <LeftSidebar selected={selected()} onSelect={setSelected} />
          </div>
        </aside>

        <div class="splitter" onPointerDown={(e) => startDrag(e, sidebar, setSidebar, "left")} />

        <div class="workspace">
          <div class="work-split">
            <main class="pane terminal">
              <Terminal selected={selected()} />
            </main>
            <div class="splitter" onPointerDown={(e) => startDrag(e, editor, setEditor, "right")} />
            <section class="pane editor" style={{ width: `${editor()}px` }}>
              <Editor selected={selected()} />
            </section>
          </div>
        </div>
      </div>

      <Show when={quickOpen()}>
        <QuickOpen root={selected()?.folderPath ?? null} onClose={() => setQuickOpen(false)} />
      </Show>

      <Show when={settingsOpen()}>
        <Settings onClose={() => setSettingsOpen(false)} />
      </Show>

      <AskpassDialog />
    </div>
  );
}

export default App;
