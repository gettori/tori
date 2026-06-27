import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import TerminalArea from "./components/TerminalArea";
import EditorPane from "./components/EditorPane";
import Sidebar, { type Selection } from "./components/Sidebar";
import {
  emit,
  FOCUS_SIDEBAR,
  FOCUS_TERMINAL,
  FOCUS_EDITOR,
  FOCUS_SEARCH,
  CLOSE_TAB,
} from "./events";
import "./App.css";

const LS_LAYOUT = "sway.layout.v1";
const LS_SELECTION = "sway.selection.v1";

type Layout = { sidebar: number; editor: number };

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LS_LAYOUT);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore corrupt layout
  }
  return { sidebar: 280, editor: 520 };
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
  const [openIds, setOpenIds] = createSignal<Set<string>>(new Set());

  // Persist the last selection (branch only, no session restore-spawn) so the
  // tree reopens where you left it.
  createEffect(() => {
    const s = selected();
    try {
      if (s) localStorage.setItem(LS_SELECTION, JSON.stringify(s));
      else localStorage.removeItem(LS_SELECTION);
    } catch {
      // ignore quota
    }
  });

  function persistLayout() {
    try {
      localStorage.setItem(
        LS_LAYOUT,
        JSON.stringify({ sidebar: sidebar(), editor: editor() }),
      );
    } catch {
      // ignore quota errors
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
    const min = 160;
    const max = 900;

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const next = edge === "left" ? startVal + dx : startVal - dx;
      set(Math.max(min, Math.min(max, next)));
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
    switch (e.key) {
      case "1":
        e.preventDefault();
        emit(FOCUS_SIDEBAR);
        break;
      case "2":
        e.preventDefault();
        emit(FOCUS_TERMINAL);
        break;
      case "3":
        e.preventDefault();
        emit(FOCUS_EDITOR);
        break;
      case "p":
        e.preventDefault();
        emit(FOCUS_SEARCH);
        break;
      case "w":
        e.preventDefault();
        emit(CLOSE_TAB);
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKeyDown));
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    document.body.classList.remove("dragging");
  });

  return (
    <div class="app">
      <aside class="pane sidebar" style={{ width: `${sidebar()}px` }}>
        <header class="pane-head">Sessions</header>
        <div class="pane-body tree-body">
          <Sidebar selected={selected()} onSelect={setSelected} openIds={openIds()} />
        </div>
      </aside>

      <div
        class="splitter"
        onPointerDown={(e) => startDrag(e, sidebar, setSidebar, "left")}
      />

      <main class="pane terminal">
        <header class="pane-head">Terminal</header>
        <TerminalArea selected={selected()} onOpenChange={setOpenIds} />
      </main>

      <div
        class="splitter"
        onPointerDown={(e) => startDrag(e, editor, setEditor, "right")}
      />

      <section class="pane editor" style={{ width: `${editor()}px` }}>
        <header class="pane-head">Editor</header>
        <EditorPane selected={selected()} />
      </section>
    </div>
  );
}

export default App;
