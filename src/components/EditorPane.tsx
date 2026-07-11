import { createSignal, createEffect, on, onCleanup, onMount, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CodeEditor from "./CodeEditor";
import FileTree from "./FileTree";
import PromptModal from "./PromptModal";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "./ConfirmDialog";
import ReviewPanel from "./ReviewPanel";
import OverflowTabBar from "./OverflowTabBar";
import FileIcon from "../seti/FileIcon";
import {
  onWith,
  OPEN_IN_EDITOR,
  PURGE_UNDER_PATH,
  DRAG_PATH_MIME,
  type OpenInEditor,
  type PurgeUnderPath,
} from "../events";
import { isUnderPath } from "../pathScope";
import { isSelfWrite } from "../selfWrites";
import { ensureLsp } from "../lspClient";
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
  const [rightMode, setRightMode] = createSignal<"files" | "changes" | "shared" | "docs">("files");
  const [follow, setFollow] = createSignal(false);
  const [gotoTarget, setGotoTarget] = createSignal<
    { path: string; line: number; col?: number; nonce: number } | null
  >(null);
  let gotoNonce = 0;

  const openPaths = () => openFiles().map((f) => f.path);
  // The session/branch-unit working folder is the anchor for the editor, file
  // tree, gutter, review surface, fs watcher, and LSP, not the project container.
  const root = () => props.selected?.folderPath ?? null;

  // The editable `.shared/` folder lives on the worktree container (projectPath);
  // only worktree units have one. Null for plain / plain-dir units gates the tab.
  const sharedPath = () =>
    props.selected?.projectKind === "worktree" ? `${props.selected.projectPath}/.shared` : null;

  // In-app replacement for window.prompt (unimplemented in WKWebView); mirrors the
  // sidebar's askText. Threaded into the editable Shared tree for name entry.
  const [promptReq, setPromptReq] = createSignal<{
    title: string;
    initial: string;
    resolve: (v: string | null) => void;
  } | null>(null);
  function askText(title: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => setPromptReq({ title, initial, resolve }));
  }
  function resolvePrompt(v: string | null) {
    const req = promptReq();
    setPromptReq(null);
    req?.resolve(v);
  }

  // In-app replacement for window.confirm (also unimplemented in WKWebView); mirrors
  // askText. Threaded into the editable Shared tree for delete confirmation.
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  function askConfirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }
  function resolveConfirm(v: boolean) {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  }

  // A parallel docs/notes tree mirroring <docsRoot>/<group>/<project>, keyed on
  // the canonical group/project (not the branch-unit folder), surfaced as its own
  // Docs tab only when that folder actually exists.
  const [docsRoot, setDocsRoot] = createSignal<string | null>(null);
  const [docsPath, setDocsPath] = createSignal<string | null>(null);
  onMount(async () => {
    try {
      setDocsRoot(await invoke<string>("get_docs_root"));
    } catch {
      // no docs root configured: the docs section stays hidden
    }
  });
  createEffect(
    on([() => props.selected, docsRoot], async ([sel, dr]) => {
      if (!sel || !dr) return setDocsPath(null);
      const candidate = `${dr}/${sel.groupName}/${sel.projectName}`;
      const exists = await invoke<boolean>("file_exists", { path: candidate }).catch(() => false);
      setDocsPath(exists ? candidate : null);
    }),
  );

  // A selection without an available Shared/Docs tab falls back to Files, so the
  // pane is never stuck on a mode the current selection cannot show.
  createEffect(() => {
    if (rightMode() === "shared" && !sharedPath()) setRightMode("files");
    if (rightMode() === "docs" && !docsPath()) setRightMode("files");
  });

  // Start (and on folder switch, replace) the fs watcher so the gutter and the
  // review surface refresh on external changes.
  createEffect(
    on(root, (r) => {
      if (!r) return;
      invoke("fs_watch_start", { projectPath: r }).catch(() => {});
      ensureLsp(r); // start the TS/JS language server for this project
    }),
  );

  function openFile(path: string) {
    if (!openFiles().some((f) => f.path === path)) {
      setOpenFiles([...openFiles(), { path, name: basename(path) }]);
    }
    setActivePath(path);
  }

  async function closeTab(path: string) {
    if (dirty()[path]) {
      const name = openFiles().find((f) => f.path === path)?.name ?? path;
      const ok = await askConfirm({
        title: `Discard unsaved changes to ${name}?`,
        message: "The edits in this tab will be lost.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
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

  // A group is being deleted: force-close every open tab rooted under it, without
  // the per-file dirty prompt (the folder is going away regardless).
  function purgeUnder(path: string) {
    const gone = new Set(openPaths().filter((p) => isUnderPath(p, path)));
    if (!gone.size) return;
    setOpenFiles((fs) => fs.filter((f) => !gone.has(f.path)));
    setDirty((d) => {
      const next = { ...d };
      for (const p of gone) delete next[p];
      return next;
    });
    if (activePath() && gone.has(activePath()!)) {
      const remaining = openFiles();
      setActivePath(remaining.length ? remaining[remaining.length - 1].path : null);
    }
  }

  let offOpen: (() => void) | undefined;
  let offPurge: (() => void) | undefined;
  let offClose: (() => void) | undefined;
  let offFollow: UnlistenFn | undefined;

  onMount(async () => {
    offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => {
      if (!d?.path) return;
      openFile(d.path);
      if (d.line) setGotoTarget({ path: d.path, line: d.line, col: d.col, nonce: ++gotoNonce });
    });
    offPurge = onWith<PurgeUnderPath>(PURGE_UNDER_PATH, ({ path }) => purgeUnder(path));
    // Follow mode: auto-open the most-recently-changed project file. The watcher
    // already filters .git/node_modules/dist/target, and self-writes are skipped,
    // so follow never jumps to git internals, build output, or our own saves.
    offFollow = await listen<{ paths: string[] }>("fs://changed", (e) => {
      if (!follow()) return;
      const external = e.payload.paths.filter((p) => !isSelfWrite(p));
      if (external.length) openFile(external[external.length - 1]);
    });
    // Unsaved-buffer guard on app close. window.confirm can't run here, so always
    // block the close first, then destroy the window ourselves if the user confirms
    // (destroy bypasses this handler, so there is no re-prompt loop).
    offClose = await getCurrentWindow().onCloseRequested(async (event) => {
      const anyDirty = Object.values(dirty()).some(Boolean);
      if (!anyDirty) return;
      event.preventDefault();
      const ok = await askConfirm({
        title: "You have unsaved changes.",
        message: "Close anyway? Unsaved edits will be lost.",
        confirmLabel: "Close without saving",
        danger: true,
      });
      if (ok) await getCurrentWindow().destroy();
    });
  });
  onCleanup(() => {
    offOpen?.();
    offPurge?.();
    offClose?.();
    offFollow?.();
  });

  return (
    <div class="editor-pane">
      <div class="editor-main">
        <OverflowTabBar
          class="editor-tabs"
          items={openFiles()}
          activeId={activePath()}
          idOf={(f) => f.path}
          onActivate={setActivePath}
          onReorder={setOpenFiles}
          renderTab={(f) => (
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
              <FileIcon name={f.name} />
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
          renderMenuItem={(f) => (
            <>
              <FileIcon name={f.name} />
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
            </>
          )}
          trailing={
            <button
              class="follow-toggle"
              classList={{ active: follow() }}
              onClick={() => setFollow(!follow())}
              title="Follow: auto-open the most-recently-changed file"
            >
              Follow
            </button>
          }
        />
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
          <Show when={sharedPath()}>
            <button
              class="right-tab"
              classList={{ active: rightMode() === "shared" }}
              onClick={() => setRightMode("shared")}
            >
              Shared
            </button>
          </Show>
          <Show when={docsPath()}>
            <button
              class="right-tab"
              classList={{ active: rightMode() === "docs" }}
              onClick={() => setRightMode("docs")}
            >
              Docs
            </button>
          </Show>
        </div>
        <Switch>
          <Match when={rightMode() === "files"}>
            <FileTree root={root()} />
          </Match>
          <Match when={rightMode() === "changes"}>
            <ReviewPanel root={root()} />
          </Match>
          <Match when={rightMode() === "shared"}>
            <FileTree root={sharedPath()} editable askText={askText} askConfirm={askConfirm} />
          </Match>
          <Match when={rightMode() === "docs"}>
            <FileTree root={docsPath()} />
          </Match>
        </Switch>
      </div>
      <Show when={promptReq()}>
        <PromptModal
          title={promptReq()!.title}
          initial={promptReq()!.initial}
          onSubmit={(v) => resolvePrompt(v)}
          onCancel={() => resolvePrompt(null)}
        />
      </Show>
      <Show when={confirmReq()}>
        <ConfirmDialog
          title={confirmReq()!.title}
          message={confirmReq()!.message}
          confirmLabel={confirmReq()!.confirmLabel}
          danger={confirmReq()!.danger}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      </Show>
    </div>
  );
}
