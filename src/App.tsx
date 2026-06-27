import { createSignal, onCleanup } from "solid-js";
import TerminalArea from "./components/TerminalArea";
import EditorPane from "./components/EditorPane";
import Sidebar, { type Selection } from "./components/Sidebar";
import "./App.css";

const LS_KEY = "sway.layout.v1";

type Layout = { sidebar: number; editor: number };

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore corrupt layout
  }
  return { sidebar: 280, editor: 520 };
}

function App() {
  const initial = loadLayout();
  const [sidebar, setSidebar] = createSignal(initial.sidebar);
  const [editor, setEditor] = createSignal(initial.editor);
  const [selected, setSelected] = createSignal<Selection | null>(null);

  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ sidebar: sidebar(), editor: editor() }));
    } catch {
      // ignore quota errors
    }
  }

  // Generic horizontal drag handler. `edge` tells which side grows with cursor.
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
      persist();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("dragging");
  }

  onCleanup(() => document.body.classList.remove("dragging"));

  return (
    <div class="app">
      <aside class="pane sidebar" style={{ width: `${sidebar()}px` }}>
        <header class="pane-head">Sessions</header>
        <div class="pane-body tree-body">
          <Sidebar selected={selected()} onSelect={setSelected} />
        </div>
      </aside>

      <div
        class="splitter"
        onPointerDown={(e) => startDrag(e, sidebar, setSidebar, "left")}
      />

      <main class="pane terminal">
        <header class="pane-head">Terminal</header>
        <TerminalArea selected={selected()} />
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
