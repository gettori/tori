import { createSignal, createEffect, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CodeEditor from "./CodeEditor";
import FileTree from "./FileTree";
import ReviewPanel from "./ReviewPanel";
import { onWith, OPEN_IN_EDITOR, DRAG_PATH_MIME, type OpenInEditor } from "../events";
import { isSelfWrite } from "../selfWrites";
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
  const [rightMode, setRightMode] = createSignal<"files" | "changes">("files");
  const [follow, setFollow] = createSignal(false);
  const [gotoTarget, setGotoTarget] = createSignal<
    { path: string; line: number; col?: number; nonce: number } | null
  >(null);
  let gotoNonce = 0;

  const openPaths = () => openFiles().map((f) => f.path);
  const root = () => props.selected?.projectPath ?? null;

  // Start (and on project switch, replace) the fs watcher so the gutter and the
  // review surface refresh on external changes.
  createEffect(
    on(root, (r) => {
      if (r) invoke("fs_watch_start", { projectPath: r }).catch(() => {});
    }),
  );

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
  let offFollow: UnlistenFn | undefined;

  onMount(async () => {
    offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => {
      if (!d?.path) return;
      openFile(d.path);
      if (d.line) setGotoTarget({ path: d.path, line: d.line, col: d.col, nonce: ++gotoNonce });
    });
    // Follow mode: auto-open the most-recently-changed project file. The watcher
    // already filters .git/node_modules/dist/target, and self-writes are skipped,
    // so follow never jumps to git internals, build output, or our own saves.
    offFollow = await listen<{ paths: string[] }>("fs://changed", (e) => {
      if (!follow()) return;
      const external = e.payload.paths.filter((p) => !isSelfWrite(p));
      if (external.length) openFile(external[external.length - 1]);
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
    offFollow?.();
  });

  return (
    <div class="editor-pane">
      <div class="editor-main">
        <div class="editor-tabs">
          <For each={openFiles()}>
            {(f) => (
              <div
                class="tab"
                classList={{ active: f.path === activePath() }}
                onClick={() => setActivePath(f.path)}
                title={f.path}
                draggable={true}
                onDragStart={(e) => {
                  e.dataTransfer?.setData(DRAG_PATH_MIME, f.path);
                  e.dataTransfer?.setData("text/plain", f.path);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
                }}
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
          <button
            class="follow-toggle"
            classList={{ active: follow() }}
            onClick={() => setFollow(!follow())}
            title="Follow: auto-open the most-recently-changed file"
          >
            Follow
          </button>
        </div>
        <Show
          when={openFiles().length}
          fallback={<div class="editor-empty">Open a file from the tree to start editing.</div>}
        >
          <CodeEditor
            activePath={activePath()}
            openPaths={openPaths()}
            projectRoot={root()}
            goto={gotoTarget()}
            onDirty={handleDirty}
          />
        </Show>
      </div>
      <div class="right-panel">
        <div class="right-tabs">
          <button
            class="right-tab"
            classList={{ active: rightMode() === "files" }}
            onClick={() => setRightMode("files")}
          >
            Files
          </button>
          <button
            class="right-tab"
            classList={{ active: rightMode() === "changes" }}
            onClick={() => setRightMode("changes")}
          >
            Changes
          </button>
        </div>
        <Show when={rightMode() === "files"} fallback={<ReviewPanel root={root()} />}>
          <FileTree root={root()} />
        </Show>
      </div>
    </div>
  );
}
