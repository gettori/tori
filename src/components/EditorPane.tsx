import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CodeEditor from "./CodeEditor";
import FileTree from "./FileTree";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../events";
import type { Selection } from "./Sidebar";

type OpenFile = { path: string; name: string };

function basename(path: string): string {
  return path.split("/").pop() || path;
}

// Same-origin CM6 editor pane: ⟨ tabs + code │ file tree ⟩. Owns the
// open-editors model (tabs, active file, per-file dirty state); CodeEditor holds
// the per-file buffers and FileTree drives opens via OPEN_IN_EDITOR.
export default function EditorPane(props: { selected: Selection | null }) {
  const [openFiles, setOpenFiles] = createSignal<OpenFile[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal<Record<string, boolean>>({});

  const openPaths = () => openFiles().map((f) => f.path);

  function openFile(path: string) {
    if (!openFiles().some((f) => f.path === path)) {
      setOpenFiles([...openFiles(), { path, name: basename(path) }]);
    }
    setActivePath(path);
  }

  function closeTab(path: string) {
    if (dirty()[path]) {
      const name = openFiles().find((f) => f.path === path)?.name ?? path;
      if (!confirm(`Discard unsaved changes to ${name}?`)) return;
    }
    const remaining = openFiles().filter((f) => f.path !== path);
    setOpenFiles(remaining);
    setDirty((d) => {
      const next = { ...d };
      delete next[path];
      return next;
    });
    if (activePath() === path) {
      setActivePath(remaining.length ? remaining[remaining.length - 1].path : null);
    }
  }

  function handleDirty(path: string, isDirty: boolean) {
    setDirty((prev) => (prev[path] === isDirty ? prev : { ...prev, [path]: isDirty }));
  }

  let offOpen: (() => void) | undefined;
  let offClose: (() => void) | undefined;

  onMount(async () => {
    offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => {
      if (d?.path) openFile(d.path);
    });
    // Unsaved-buffer guard on app close.
    offClose = await getCurrentWindow().onCloseRequested((event) => {
      const anyDirty = Object.values(dirty()).some(Boolean);
      if (anyDirty && !confirm("You have unsaved changes. Close anyway?")) {
        event.preventDefault();
      }
    });
  });
  onCleanup(() => {
    offOpen?.();
    offClose?.();
  });

  return (
    <div class="editor-pane">
      <div class="editor-main">
        <Show
          when={openFiles().length}
          fallback={<div class="editor-empty">Open a file from the tree to start editing.</div>}
        >
          <div class="editor-tabs">
            <For each={openFiles()}>
              {(f) => (
                <div
                  class="tab"
                  classList={{ active: f.path === activePath() }}
                  onClick={() => setActivePath(f.path)}
                  title={f.path}
                >
                  <span class="tab-name">{f.name}</span>
                  <Show when={dirty()[f.path]}>
                    <span class="tab-dirty">●</span>
                  </Show>
                  <button
                    class="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(f.path);
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
          <CodeEditor activePath={activePath()} openPaths={openPaths()} onDirty={handleDirty} />
        </Show>
      </div>
      <FileTree root={props.selected?.projectPath ?? null} />
    </div>
  );
}
