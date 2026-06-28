import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import Sidebar, { type Selection } from "./components/Sidebar";
import TerminalArea from "./components/TerminalArea";
import EditorPane from "./components/EditorPane";
import Toolbar from "./components/Toolbar";
import WindowControls from "./components/WindowControls";
import { emit, FOCUS_SEARCH, FOCUS_TERMINAL } from "./events";
import { applyTheme } from "./theme";
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
    if (raw) return JSON.parse(raw);
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
    if (e.key === "p" || e.key === "1") {
      e.preventDefault();
      emit(FOCUS_SEARCH);
    } else if (e.key === "2") {
      e.preventDefault();
      emit(FOCUS_TERMINAL);
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("focus", applyTheme);
    applyTheme();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("focus", applyTheme);
    document.body.classList.remove("dragging");
  });

  return (
    <div class="app">
      <header class="topbar" data-tauri-drag-region>
        <WindowControls />
        <Toolbar selected={selected()} />
      </header>

      <div class="body">
        <aside class="pane sidebar" style={{ width: `${sidebar()}px` }}>
          <div class="pane-body tree-body">
            <Sidebar selected={selected()} onSelect={setSelected} />
          </div>
        </aside>

        <div class="splitter" onPointerDown={(e) => startDrag(e, sidebar, setSidebar, "left")} />

        <div class="workspace">
          <div class="work-split">
            <main class="pane terminal">
              <TerminalArea selected={selected()} />
            </main>
            <div class="splitter" onPointerDown={(e) => startDrag(e, editor, setEditor, "right")} />
            <section class="pane editor" style={{ width: `${editor()}px` }}>
              <EditorPane selected={selected()} />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
