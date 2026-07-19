import { createSignal, createEffect, on, onCleanup, onMount, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CodeEditor from "./CodeEditor";
import FileTree from "./FileTree/FileTree";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import ReviewPanel from "./ReviewPanel";
import SearchPanel from "./SearchPanel";
import SessionPanel from "./SessionPanel";
import MarkdownPreview from "./MarkdownPreview";
import ImageView, { isImagePath } from "./ImageView";
import TranscriptViewer from "./TranscriptViewer";
import OverflowTabBar from "../../components/OverflowTabBar";
import FileIcon from "../../seti/FileIcon";
import ClaudeIcon from "../../seti/ClaudeIcon";
import PiIcon from "../../seti/PiIcon";
import Icon from "../../components/Icon/Icon";
import { X } from "lucide-solid";
import {
  on as onEvent,
  onWith,
  OPEN_IN_EDITOR,
  OPEN_TRANSCRIPT,
  PURGE_UNDER_PATH,
  DRAG_PATH_MIME,
  FOCUS_PROJECT_SEARCH,
  SET_RIGHT_MODE,
  type OpenInEditor,
  type OpenTranscript,
  type PurgeUnderPath,
  type LiveTab,
  type SetRightMode,
} from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import { isSelfWrite } from "../../utils/selfWrites";
import { ensureLsp } from "./lspClient";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import styles from "./Editor.module.css";

type FileTab = { kind: "file"; path: string; name: string };
type TranscriptTab = {
  kind: "transcript";
  id: string;
  sessionPath: string;
  agent: "claude" | "pi";
  name: string;
  cwd: string;
};
type Tab = FileTab | TranscriptTab;

function tabId(t: Tab): string {
  return t.kind === "file" ? t.path : `transcript:${t.id}`;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

// Same-origin CM6 editor pane: ⟨ tabs + code │ file tree ⟩. Owns the
// open-editors model (tabs, active file, per-file dirty state); CodeEditor holds
// the per-file buffers and FileTree drives opens via OPEN_IN_EDITOR.
export default function Editor(props: { selected: Selection | null; liveTabs?: LiveTab[] }) {
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal<Record<string, boolean>>({});
  const [rightMode, setRightMode] = createSignal<"files" | "changes" | "shared" | "docs" | "session" | "search">(
    "files",
  );
  const [searchFocusNonce, setSearchFocusNonce] = createSignal(0);
  // Markdown preview toggle, per tab id (so switching tabs remembers each
  // .md file's own source-vs-preview choice).
  const [previewOn, setPreviewOn] = createSignal<Set<string>>(new Set());
  const [follow, setFollow] = createSignal(false);
  const [gotoTarget, setGotoTarget] = createSignal<
    { path: string; line: number; col?: number; nonce: number } | null
  >(null);
  let gotoNonce = 0;

  const filePaths = () => tabs().filter((t): t is FileTab => t.kind === "file").map((t) => t.path);
  const activeTab = () => tabs().find((t) => tabId(t) === activeId()) ?? null;
  const isImageTab = () => {
    const t = activeTab();
    return t?.kind === "file" && isImagePath(t.path);
  };
  const isMarkdownTab = () => {
    const t = activeTab();
    return t?.kind === "file" && t.path.toLowerCase().endsWith(".md");
  };
  const showingPreview = () => isMarkdownTab() && previewOn().has(activeId() ?? "");
  function togglePreview() {
    const id = activeId();
    if (!id) return;
    setPreviewOn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const activeTranscript = () => {
    const t = activeTab();
    return t && t.kind === "transcript" ? t : null;
  };
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

  // A parallel docs/notes tree mirroring <docsRoot>/<space>/<project>, keyed on
  // the canonical space/project (not the branch-unit folder), surfaced as its own
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
      const candidate = `${dr}/${sel.spaceName}/${sel.projectName}`;
      const exists = await invoke<boolean>("file_exists", { path: candidate }).catch(() => false);
      setDocsPath(exists ? candidate : null);
    }),
  );

  // A selection without an available Shared/Docs/Session tab falls back to
  // Files, so the pane is never stuck on a mode the current selection can't show.
  createEffect(() => {
    if (rightMode() === "shared" && !sharedPath()) setRightMode("files");
    if (rightMode() === "docs" && !docsPath()) setRightMode("files");
    if (rightMode() === "session" && !props.selected?.sessionId) setRightMode("files");
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
    if (!tabs().some((t) => t.kind === "file" && t.path === path)) {
      setTabs([...tabs(), { kind: "file", path, name: basename(path) }]);
    }
    setActiveId(path);
  }

  // Opened from the sidebar's session context menu (see OPEN_TRANSCRIPT below).
  // Read-only, so there is never a dirty prompt on close.
  function openTranscript(id: string, sessionPath: string, agent: "claude" | "pi", name: string, cwd: string) {
    if (!tabs().some((t) => t.kind === "transcript" && t.id === id)) {
      setTabs([...tabs(), { kind: "transcript", id, sessionPath, agent, name, cwd }]);
    }
    setActiveId(`transcript:${id}`);
  }

  async function closeTab(id: string) {
    const tab = tabs().find((t) => tabId(t) === id);
    if (!tab) return;
    if (tab.kind === "file" && dirty()[tab.path]) {
      const ok = await askConfirm({
        title: `Discard unsaved changes to ${tab.name}?`,
        message: "The edits in this tab will be lost.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    const remaining = tabs().filter((t) => tabId(t) !== id);
    setTabs(remaining);
    if (tab.kind === "file") {
      setDirty((d) => {
        const next = { ...d };
        delete next[tab.path];
        return next;
      });
      setPreviewOn((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
    if (activeId() === id) {
      setActiveId(remaining.length ? tabId(remaining[remaining.length - 1]) : null);
    }
  }

  function handleDirty(path: string, isDirty: boolean) {
    setDirty((prev) => (prev[path] === isDirty ? prev : { ...prev, [path]: isDirty }));
  }

  // A space is being deleted: force-close every open tab rooted under it, without
  // the per-file dirty prompt (the folder is going away regardless). A
  // transcript tab is "under" a path when its session's transcript file is.
  function purgeUnder(path: string) {
    const goneTabs = tabs().filter((t) => isUnderPath(t.kind === "file" ? t.path : t.sessionPath, path));
    if (!goneTabs.length) return;
    const goneIds = new Set(goneTabs.map(tabId));
    setTabs((ts) => ts.filter((t) => !goneIds.has(tabId(t))));
    setDirty((d) => {
      const next = { ...d };
      for (const t of goneTabs) if (t.kind === "file") delete next[t.path];
      return next;
    });
    if (activeId() && goneIds.has(activeId()!)) {
      const remaining = tabs().filter((t) => !goneIds.has(tabId(t)));
      setActiveId(remaining.length ? tabId(remaining[remaining.length - 1]) : null);
    }
  }

  let offOpen: (() => void) | undefined;
  let offTranscript: (() => void) | undefined;
  let offPurge: (() => void) | undefined;
  let offClose: (() => void) | undefined;
  let offFollow: UnlistenFn | undefined;
  let offProjectSearch: (() => void) | undefined;
  let offSetRightMode: (() => void) | undefined;

  onMount(async () => {
    offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => {
      if (!d?.path) return;
      openFile(d.path);
      if (d.line) setGotoTarget({ path: d.path, line: d.line, col: d.col, nonce: ++gotoNonce });
    });
    offTranscript = onWith<OpenTranscript>(OPEN_TRANSCRIPT, (d) => {
      if (!d?.id || !d.sessionPath) return;
      openTranscript(d.id, d.sessionPath, d.agent, d.name, d.cwd);
    });
    offPurge = onWith<PurgeUnderPath>(PURGE_UNDER_PATH, ({ path }) => purgeUnder(path));
    // Cmd+Shift+F: switch to Search mode and bump the nonce so SearchPanel
    // refocuses its input even when the mode is already active.
    offProjectSearch = onEvent(FOCUS_PROJECT_SEARCH, () => {
      setRightMode("search");
      setSearchFocusNonce((n) => n + 1);
    });
    offSetRightMode = onWith<SetRightMode>(SET_RIGHT_MODE, (d) => {
      if (d?.mode) setRightMode(d.mode);
    });
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
    offTranscript?.();
    offPurge?.();
    offClose?.();
    offFollow?.();
    offProjectSearch?.();
    offSetRightMode?.();
  });

  return (
    <div class={styles.editorPane}>
      <div class={styles.editorMain}>
        <OverflowTabBar
          class={styles.editorTabs}
          items={tabs()}
          activeId={activeId()}
          idOf={tabId}
          onActivate={setActiveId}
          onReorder={setTabs}
          renderTab={(t) => (
            <div
              class={styles.tab}
              classList={{ [styles.active]: tabId(t) === activeId() }}
              onClick={() => setActiveId(tabId(t))}
              title={t.kind === "file" ? t.path : t.name}
              draggable={t.kind === "file"}
              onDragStart={(e) => {
                if (t.kind !== "file") return;
                e.dataTransfer?.setData(DRAG_PATH_MIME, t.path);
                e.dataTransfer?.setData("text/plain", t.path);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <Show when={t.kind === "file"} fallback={t.kind === "transcript" && t.agent === "pi" ? <PiIcon /> : <ClaudeIcon />}>
                <FileIcon name={t.name} />
              </Show>
              <span class="tab-name">{t.name}</span>
              <Show when={t.kind === "file" && dirty()[t.path]}>
                <span class="tab-dirty">●</span>
              </Show>
              <button
                class="tab-close"
                aria-label="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tabId(t));
                }}
              >
                <Icon icon={X} size={14} />
              </button>
            </div>
          )}
          renderMenuItem={(t) => (
            <>
              <Show when={t.kind === "file"} fallback={t.kind === "transcript" && t.agent === "pi" ? <PiIcon /> : <ClaudeIcon />}>
                <FileIcon name={t.name} />
              </Show>
              <span class="tab-name">{t.name}</span>
              <Show when={t.kind === "file" && dirty()[t.path]}>
                <span class="tab-dirty">●</span>
              </Show>
              <button
                class="tab-close"
                aria-label="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tabId(t));
                }}
              >
                <Icon icon={X} size={14} />
              </button>
            </>
          )}
          trailing={
            <>
              <Show when={isMarkdownTab()}>
                <button
                  class={styles.followToggle}
                  classList={{ [styles.active]: showingPreview() }}
                  onClick={togglePreview}
                  title="Toggle Markdown preview"
                >
                  Preview
                </button>
              </Show>
              <button
                class={styles.followToggle}
                classList={{ [styles.active]: follow() }}
                onClick={() => setFollow(!follow())}
                title="Follow: auto-open the most-recently-changed file"
              >
                Follow
              </button>
            </>
          }
        />
        <Show
          when={filePaths().length}
          fallback={
            <div class={styles.editorEmpty}>
              Open a file from the tree to start editing, or press ⌘P to find one by name.
            </div>
          }
        >
          <CodeEditor
            activePath={activeTab()?.kind === "file" && !isImageTab() && !showingPreview() ? activeId() : null}
            openPaths={filePaths()}
            projectRoot={root()}
            goto={gotoTarget()}
            onDirty={handleDirty}
            selected={props.selected}
            hidden={isImageTab() || showingPreview()}
          />
          <Show when={isImageTab()}>
            <ImageView path={activeId()!} />
          </Show>
          <Show when={showingPreview()}>
            <MarkdownPreview path={activeId()!} />
          </Show>
        </Show>
        <Show when={activeTranscript()}>
          {(t) => (
            <TranscriptViewer
              class={styles.transcriptOverlay}
              sessionPath={t().sessionPath}
              agent={t().agent}
              sessionId={t().id}
              repoPath={t().cwd}
              liveTabs={props.liveTabs ?? []}
            />
          )}
        </Show>
      </div>
      <div class={styles.rightPanel}>
        <div class={styles.rightTabs}>
          <button
            class={styles.rightTab}
            classList={{ [styles.active]: rightMode() === "files" }}
            onClick={() => setRightMode("files")}
          >
            Files
          </button>
          <button
            class={styles.rightTab}
            classList={{ [styles.active]: rightMode() === "changes" }}
            onClick={() => setRightMode("changes")}
          >
            Changes
          </button>
          <button
            class={styles.rightTab}
            classList={{ [styles.active]: rightMode() === "search" }}
            onClick={() => setRightMode("search")}
          >
            Search
          </button>
          <Show when={props.selected?.sessionId}>
            <button
              class={styles.rightTab}
              classList={{ [styles.active]: rightMode() === "session" }}
              onClick={() => setRightMode("session")}
            >
              Session
            </button>
          </Show>
          <Show when={sharedPath()}>
            <button
              class={styles.rightTab}
              classList={{ [styles.active]: rightMode() === "shared" }}
              onClick={() => setRightMode("shared")}
            >
              Shared
            </button>
          </Show>
          <Show when={docsPath()}>
            <button
              class={styles.rightTab}
              classList={{ [styles.active]: rightMode() === "docs" }}
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
            <ReviewPanel root={root()} selected={props.selected} />
          </Match>
          <Match when={rightMode() === "search"}>
            <SearchPanel root={root()} focusNonce={searchFocusNonce()} />
          </Match>
          <Match when={rightMode() === "session" && props.selected?.sessionId}>
            <SessionPanel
              path={props.selected!.sessionPath ?? null}
              agent={props.selected!.agent === "pi" ? "pi" : "claude"}
              cwd={props.selected!.sessionCwd ?? null}
              projectRoot={root()}
              selfSessionId={props.selected!.sessionId ?? null}
              liveTabs={props.liveTabs ?? []}
            />
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
