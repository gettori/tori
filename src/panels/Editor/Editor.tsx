import { createSignal, createEffect, on, onCleanup, onMount, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CodeEditor from "./CodeEditor";
import FileTree from "./FileTree/FileTree";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import ReviewPanel from "./ReviewPanel";
import ProblemsPanel from "./ProblemsPanel";
import { diagnostics, clearDiagnostics } from "../../utils/diagnostics";
import type { RevertOutcome } from "./CheckpointTimeline";
import SearchPanel from "./SearchPanel";
import SessionPanel from "./SessionPanel";
import MarkdownPreview from "./MarkdownPreview";
import ImageView, { isImagePath } from "./ImageView";
import OverflowTabBar from "../../components/OverflowTabBar";
import Resizer from "../../components/Resizer/Resizer";
import IconButton from "../../components/IconButton/IconButton";
import Tab from "../../components/Tab/Tab";
import FileIcon from "../../seti/FileIcon";
import Icon from "../../components/Icon/Icon";
import {
  X,
  Bot,
  FileCodeCorner,
  FileTypeCorner,
  FileHeart,
  Files,
  GitCompare,
  TriangleAlert,
  Search,
  MessagesSquare,
  Share2,
  BookOpen,
  PanelRight,
  type LucideIcon,
} from "lucide-solid";
import {
  on as onEvent,
  onWith,
  OPEN_IN_EDITOR,
  PURGE_UNDER_PATH,
  DRAG_PATH_MIME,
  FOCUS_PROJECT_SEARCH,
  SET_RIGHT_MODE,
  type OpenInEditor,
  type PurgeUnderPath,
  type LiveTab,
  type SetRightMode,
} from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import { setTouchedPaths, writtenPaths, isTouched, type TouchOp } from "../../utils/touchedFiles";
import {
  setEditingNow,
  editingIndication,
  isSoleLiveActor,
  isEditingNow,
  EDITING_QUIET_MS,
  type EditingIndication,
} from "../../utils/editingNow";
import { folderActors } from "../../utils/folderActors";
import { shouldPollAccumulatedDiff } from "../../utils/sessionActivity";
import type { RevertCandidate } from "../../utils/revertGuard";
import { isSelfWrite } from "../../utils/selfWrites";
import { ensureLsp } from "./lspClient";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import styles from "./Editor.module.css";

// Every editor tab is a file now that the transcript viewer is gone, so a tab
// *is* its path: `tabId` and `FileTab.path` are the same string, and the tab
// bar's `idOf` is what still names the mapping.
type FileTab = { path: string; name: string };

// The right pane's modes. Tab descriptors are module-level singletons so the
// filtered list hands OverflowTabBar the same object references on every read:
// its `<For>` is referentially keyed, and fresh literals would tear down and
// rebuild every tab's DOM on any unrelated signal change
// (gotchas#reordering-a-referentially-keyed-for-must-preserve-object-identity).
type RightMode = "files" | "changes" | "problems" | "shared" | "docs" | "session" | "search";
type ModeTab = { mode: RightMode; label: string; icon: LucideIcon };
const RIGHT_MODE_TABS: Record<RightMode, ModeTab> = {
  files: { mode: "files", label: "Files", icon: Files },
  changes: { mode: "changes", label: "Changes", icon: GitCompare },
  problems: { mode: "problems", label: "Problems", icon: TriangleAlert },
  search: { mode: "search", label: "Search", icon: Search },
  session: { mode: "session", label: "Session", icon: MessagesSquare },
  shared: { mode: "shared", label: "Shared", icon: Share2 },
  docs: { mode: "docs", label: "Docs", icon: BookOpen },
};

function tabId(t: FileTab): string {
  return t.path;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

const LS_RIGHT_W = "sway.editor.rightw.v1";
const RIGHT_W_MIN = 160;
const RIGHT_W_MAX = 600;

function loadRightW(): number {
  const n = Number(localStorage.getItem(LS_RIGHT_W));
  return Number.isFinite(n) && n >= RIGHT_W_MIN ? Math.min(n, RIGHT_W_MAX) : 240;
}

// Same-origin CM6 editor pane: ⟨ tabs + code │ file tree ⟩. Owns the
// open-editors model (tabs, active file, per-file dirty state); CodeEditor holds
// the per-file buffers and FileTree drives opens via OPEN_IN_EDITOR.
export default function Editor(props: {
  selected: Selection | null;
  liveTabs?: LiveTab[];
  showFiletree?: boolean;
  onToggleFiletree?: () => void;
}) {
  const filetreeOn = () => props.showFiletree ?? true;
  // The file-tree show/hide button lives where the tree currently is: in the
  // right panel's own tab strip (right-aligned) while the tree is shown, and in
  // the editor tab bar (its only remaining home) once the tree is hidden.
  const filetreeToggleBtn = (shown: boolean) => (
    <IconButton
      class={shown ? undefined : styles.paneToggleOff}
      icon={<Icon icon={PanelRight} />}
      aria-pressed={shown}
      onClick={() => props.onToggleFiletree?.()}
      title={shown ? "Hide the file tree (⌘⌥B)" : "Show the file tree (⌘⌥B)"}
    />
  );
  const [tabs, setTabs] = createSignal<FileTab[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal<Record<string, boolean>>({});
  const [rightMode, setRightMode] = createSignal<RightMode>("files");
  // Width of the right (file-tree/search/problems) panel, drag-resized and
  // persisted; the code side flexes to fill the rest.
  const [rightW, setRightW] = createSignal(loadRightW());
  function persistRightW() {
    try {
      localStorage.setItem(LS_RIGHT_W, String(rightW()));
    } catch {
      // ignore
    }
  }
  // The mode strip runs through the shared OverflowTabBar, so it collapses into
  // a +N menu on a narrow pane instead of squeezing every label. The bar can
  // reorder tabs when one is picked out of the overflow menu, so the canonical
  // order lives in a signal; availability (session/shared/docs) still filters it
  // on every render.
  const [modeOrder, setModeOrder] = createSignal<RightMode[]>([
    "files",
    "changes",
    "problems",
    "search",
    "session",
    "shared",
    "docs",
  ]);
  // Files/Changes/Search are always offered; the rest need their target to exist.
  function modeAvailable(m: RightMode): boolean {
    switch (m) {
      case "session":
        return !!props.selected?.sessionId;
      case "shared":
        return !!sharedPath();
      case "docs":
        return !!docsPath();
      // Only worth a tab when something is actually wrong; an always-present
      // "Problems (0)" is noise on a clean tree.
      case "problems":
        return Object.keys(diagnostics()).length > 0;
      default:
        return true;
    }
  }
  const rightTabs = () => modeOrder().filter(modeAvailable).map((m) => RIGHT_MODE_TABS[m]);
  const [searchFocusNonce, setSearchFocusNonce] = createSignal(0);
  // Source-vs-render preview toggle, per tab id (so switching tabs remembers
  // each previewable file's own choice: .md renders to HTML, .svg to its image).
  const [previewOn, setPreviewOn] = createSignal<Set<string>>(new Set());
  const [follow, setFollow] = createSignal(false);
  const [gotoTarget, setGotoTarget] = createSignal<
    { path: string; line: number; col?: number; nonce: number } | null
  >(null);
  let gotoNonce = 0;

  const filePaths = () => tabs().map((t) => t.path);
  const activeTab = () => tabs().find((t) => tabId(t) === activeId()) ?? null;
  const isImageTab = () => {
    const t = activeTab();
    return t != null && isImagePath(t.path);
  };
  const isMarkdownTab = () => {
    const t = activeTab();
    return t != null && t.path.toLowerCase().endsWith(".md");
  };
  const isSvgTab = () => {
    const t = activeTab();
    return t != null && t.path.toLowerCase().endsWith(".svg");
  };
  // Tabs that carry a source-vs-render toggle: Markdown renders to HTML, SVG
  // renders to its image. Everything else edits in place with no toggle.
  const isPreviewableTab = () => isMarkdownTab() || isSvgTab();
  const showingPreview = () => isPreviewableTab() && previewOn().has(activeId() ?? "");
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
    // The Problems tab disappears once the last diagnostic clears.
    if (rightMode() === "problems" && !Object.keys(diagnostics()).length) setRightMode("files");
  });

  // Start (and on folder switch, replace) the fs watcher so the gutter and the
  // review surface refresh on external changes.
  createEffect(
    on(root, (r) => {
      if (!r) return;
      invoke("fs_watch_start", { projectPath: r }).catch(() => {});
      // A new project means a new language server; diagnostics from the old one
      // describe files that are no longer open here.
      clearDiagnostics();
      ensureLsp(r); // start the TS/JS language server for this project
    }),
  );

  function openFile(path: string) {
    if (!tabs().some((t) => t.path === path)) {
      setTabs([...tabs(), { path, name: basename(path) }]);
    }
    setActiveId(path);
  }

  async function closeTab(id: string) {
    const tab = tabs().find((t) => tabId(t) === id);
    if (!tab) return;
    if (dirty()[tab.path]) {
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
    if (activeId() === id) {
      setActiveId(remaining.length ? tabId(remaining[remaining.length - 1]) : null);
    }
  }

  // Agent-touched markers: the selected session's written files, refreshed on
  // turn end. `sessions://changed` already covers every registered adapter's
  // discovery dir (sessions.rs `watch_dirs`), so it is the only trigger needed.
  // Cost is capped at one fetch per trigger, and the backend's mtime cache
  // makes a repeat fetch for an unchanged transcript free.
  //
  // An adapter whose transcript shape `extract_touched_files` cannot parse
  // simply yields an empty set, so the markers no-op rather than misreport.
  async function refreshTouched() {
    const sel = props.selected;
    if (!sel?.sessionPath) {
      setTouchedPaths(new Set());
      return;
    }
    const path = sel.sessionPath;
    touchedFor = path;
    const files = await invoke<{ path: string; op: TouchOp }[]>("session_touched_files", {
      path,
      agent: sel.agent ?? "claude",
    }).catch(() => []);
    // Same out-of-order guard SessionPanel uses: a slower fetch for the
    // previously-selected session must not overwrite the current one's set.
    if (touchedFor !== path) return;
    setTouchedPaths(writtenPaths(files));
  }
  let touchedFor: string | null = null;

  // Clear first, so switching sessions never leaves the previous session's
  // markers on screen while the new fetch is in flight.
  createEffect(
    on(
      () => [props.selected?.sessionPath, props.selected?.agent],
      () => {
        setTouchedPaths(new Set());
        void refreshTouched();
        clearEditing();
        actors = null;
        void refreshActors();
      },
    ),
  );

  // --- Live "editing now" ---------------------------------------------------
  //
  // Composed here because Editor already owns both inputs: the transcript-side
  // fetch (`sessions://changed`) and the `fs://changed` listener. The two are
  // not equal evidence - see editingNow.ts - so the parser path is preferred
  // and the fs path only names a file when the folder has no other actor.
  //
  // The actor set is refreshed on the same cadence as the touched fetch, never
  // per fs event: the detached tier costs a `session_running` probe per off-tab
  // session, which is fine once a turn and far too much per file write.
  const selectedExecuting = () => shouldPollAccumulatedDiff(props.selected?.sessionId);

  // null until the probe lands: gathering is async, so there is a window after a
  // selection change where we do not know who else is live here. isSoleLiveActor
  // treats null as not-sole, so during that window an fs event degrades to the
  // anonymous pulse instead of naming a file on no evidence.
  let actors: RevertCandidate[] | null = null;
  let lastParserPath: string | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;

  function clearEditing() {
    clearTimeout(quietTimer);
    quietTimer = undefined;
    lastParserPath = null;
    setEditingNow(null);
  }

  // Every indication is provisional: it expires unless a fresh signal renews
  // it, so a turn that dies without a closing event cannot leave a file
  // pulsing forever.
  function publishEditing(indication: EditingIndication) {
    setEditingNow(indication);
    clearTimeout(quietTimer);
    if (indication) quietTimer = setTimeout(() => setEditingNow(null), EDITING_QUIET_MS);
  }

  async function refreshActors() {
    const folder = props.selected?.folderPath;
    if (!folder) {
      actors = null;
      return;
    }
    // A failed probe leaves the set null (unknown), not empty - same reason as
    // the in-flight window above.
    const found = await folderActors(folder).catch(() => null);
    if (props.selected?.folderPath !== folder) return;
    actors = found;
  }

  // Transcript side: the last file the session itself said it wrote. Fires on
  // `sessions://changed`, which the watcher emits as the transcript grows
  // mid-turn, not only at turn end - that is what makes an edit burst pulse
  // live rather than after the fact.
  async function refreshEditing() {
    const sel = props.selected;
    if (!sel?.sessionPath || !selectedExecuting()) {
      clearEditing();
      return;
    }
    const path = sel.sessionPath;
    const file = await invoke<{ path: string } | null>("session_editing_now", {
      path,
      agent: sel.agent ?? "claude",
    }).catch(() => null);
    // Same out-of-order guard as refreshTouched: a slow fetch for the previous
    // session must not attribute its file to the current one.
    if (props.selected?.sessionPath !== path) return;
    lastParserPath = file?.path ?? null;
    // A parser that named nothing is silence, not a denial. For an adapter whose
    // transcript shape we cannot read this fires on every `sessions://changed`,
    // and publishing the empty result would stamp out a perfectly good fs-derived
    // indication a moment after it appeared. Leave the existing one to expire on
    // its own quiet timer instead.
    if (!lastParserPath) return;
    publishEditing(
      editingIndication({
        executing: true,
        parserPath: lastParserPath,
        soleLiveActor: isSoleLiveActor(actors, sel.sessionId, sel.folderPath),
      }),
    );
  }

  // Turn end clears the label immediately rather than waiting out the quiet
  // timer: "Executing" dropping is a definite end-of-turn signal.
  createEffect(
    on(selectedExecuting, (executing) => {
      if (!executing) clearEditing();
    }),
  );

  // A tree revert just rewrote/removed files on disk. The fs watcher would
  // deliver these too, but a revert is a deliberate, destructive action whose
  // buffer consequences must not depend on watcher timing or coalescing, so
  // the affected paths go straight to CodeEditor, which runs its normal
  // external-change resolution (clean reload, dirty conflict, deleted
  // conflict) over exactly that set.
  const [reverted, setReverted] = createSignal<{ paths: string[]; nonce: number } | null>(null);
  let revertNonce = 0;
  function handleReverted(outcome: RevertOutcome) {
    const r = root();
    if (!r) return;
    const paths = [...outcome.restored, ...outcome.deleted].map((p) => `${r}/${p}`);
    if (paths.length) setReverted({ paths, nonce: ++revertNonce });
  }

  // Close one file tab with no dirty prompt: the caller has already resolved
  // the question (the deleted-file conflict's "take disk" choice), so a
  // discard prompt here would ask the same thing twice.
  function forceCloseFile(path: string) {
    if (!tabs().some((t) => t.path === path)) return;
    const remaining = tabs().filter((t) => t.path !== path);
    setTabs(remaining);
    setDirty((d) => {
      const next = { ...d };
      delete next[path];
      return next;
    });
    if (activeId() === path) {
      setActiveId(remaining.length ? tabId(remaining[remaining.length - 1]) : null);
    }
  }

  function handleDirty(path: string, isDirty: boolean) {
    setDirty((prev) => (prev[path] === isDirty ? prev : { ...prev, [path]: isDirty }));
  }

  // A space is being deleted: force-close every open tab rooted under it, without
  // the per-file dirty prompt (the folder is going away regardless).
  function purgeUnder(path: string) {
    const goneTabs = tabs().filter((t) => isUnderPath(t.path, path));
    if (!goneTabs.length) return;
    const goneIds = new Set(goneTabs.map(tabId));
    setTabs((ts) => ts.filter((t) => !goneIds.has(tabId(t))));
    setDirty((d) => {
      const next = { ...d };
      for (const t of goneTabs) delete next[t.path];
      return next;
    });
    if (activeId() && goneIds.has(activeId()!)) {
      const remaining = tabs().filter((t) => !goneIds.has(tabId(t)));
      setActiveId(remaining.length ? tabId(remaining[remaining.length - 1]) : null);
    }
  }

  let offTouched: UnlistenFn | undefined;
  let offOpen: (() => void) | undefined;
  let offPurge: (() => void) | undefined;
  let offClose: (() => void) | undefined;
  let offFollow: UnlistenFn | undefined;
  let offProjectSearch: (() => void) | undefined;
  let offSetRightMode: (() => void) | undefined;

  onMount(async () => {
    // Turn end for every adapter: the transcript watcher's debounced signal.
    offTouched = await listen("sessions://changed", () => {
      void refreshTouched();
      void refreshActors().then(refreshEditing);
    });
    offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => {
      if (!d?.path) return;
      openFile(d.path);
      if (d.line) setGotoTarget({ path: d.path, line: d.line, col: d.col, nonce: ++gotoNonce });
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
      const external = e.payload.paths.filter((p) => !isSelfWrite(p));
      // The fs fallback for the live indicator: only consulted when the
      // session's own parser named nothing, so an adapter Sway can read is
      // never second-guessed by a weaker signal. Sway's own saves are already
      // out (isSelfWrite), so the editor can never make a session look busy.
      const sel = props.selected;
      if (sel && !lastParserPath && selectedExecuting() && external.length) {
        const inFolder = external.filter((p) => isUnderPath(p, sel.folderPath));
        if (inFolder.length) {
          publishEditing(
            editingIndication({
              executing: true,
              parserPath: null,
              fsPath: inFolder[inFolder.length - 1],
              soleLiveActor: isSoleLiveActor(actors, sel.sessionId, sel.folderPath),
            }),
          );
        }
      }
      if (!follow()) return;
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
    clearTimeout(quietTimer);
    offTouched?.();
    offOpen?.();
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
            <Tab
              active={tabId(t) === activeId()}
              onClick={() => setActiveId(tabId(t))}
              title={t.path}
              draggable={true}
              onDragStart={(e) => {
                e.dataTransfer?.setData(DRAG_PATH_MIME, t.path);
                e.dataTransfer?.setData("text/plain", t.path);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
              }}
              icon={<FileIcon name={t.name} />}
              trailing={
                <>
                  <Show when={isTouched(t.path) || isEditingNow(t.path)}>
                    <span
                      class={styles.tabTouched}
                      classList={{ [styles.tabEditing]: isEditingNow(t.path) }}
                      title={isEditingNow(t.path) ? "Being edited right now" : "Changed by the selected session"}
                    >
                      ●
                    </span>
                  </Show>
                  <Show when={dirty()[t.path]}>
                    <span class="tab-dirty">●</span>
                  </Show>
                </>
              }
              closeLabel="Close"
              onClose={() => closeTab(tabId(t))}
            >
              {t.name}
            </Tab>
          )}
          renderMenuItem={(t) => (
            <>
              <FileIcon name={t.name} />
              <span class="tab-name">{t.name}</span>
              <Show when={isTouched(t.path) || isEditingNow(t.path)}>
                <span
                  class={styles.tabTouched}
                  classList={{ [styles.tabEditing]: isEditingNow(t.path) }}
                  title={isEditingNow(t.path) ? "Being edited right now" : "Changed by the selected session"}
                >
                  ●
                </span>
              </Show>
              <Show when={dirty()[t.path]}>
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
                <Icon icon={X} />
              </button>
            </>
          )}
          trailing={
            <>
              <Show when={isPreviewableTab()}>
                <IconButton
                  active={showingPreview()}
                  icon={
                    <Icon icon={showingPreview() ? FileCodeCorner : isSvgTab() ? FileHeart : FileTypeCorner} />
                  }
                  onClick={togglePreview}
                  title={
                    showingPreview()
                      ? `Showing rendered ${isSvgTab() ? "SVG" : "Markdown"}. Click to edit the source.`
                      : `Preview: render this ${isSvgTab() ? "SVG" : "Markdown"} file instead of editing its source.`
                  }
                />
              </Show>
              <IconButton
                active={follow()}
                icon={<Icon icon={Bot} />}
                onClick={() => setFollow(!follow())}
                title={
                  follow()
                    ? "Following live edits: auto-opening the most-recently-changed file as sessions edit. Click to stop."
                    : "Follow live edits: auto-open the most-recently-changed file as sessions edit them (skips git, build output, and your own saves)."
                }
              />
              <Show when={props.onToggleFiletree && !filetreeOn()}>
                {filetreeToggleBtn(false)}
              </Show>
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
            activePath={activeTab() && !isImageTab() && !showingPreview() ? activeId() : null}
            openPaths={filePaths()}
            projectRoot={root()}
            goto={gotoTarget()}
            onDirty={handleDirty}
            onCloseFile={forceCloseFile}
            reverted={reverted()}
            selected={props.selected}
            hidden={isImageTab() || showingPreview()}
          />
          <Show when={isImageTab()}>
            <ImageView path={activeId()!} />
          </Show>
          <Show when={showingPreview()}>
            <Show when={isSvgTab()} fallback={<MarkdownPreview path={activeId()!} />}>
              <ImageView path={activeId()!} />
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={filetreeOn()}>
        <Resizer
          side="after"
          variant="hairline"
          value={rightW()}
          min={RIGHT_W_MIN}
          max={RIGHT_W_MAX}
          onInput={setRightW}
          onCommit={persistRightW}
        />
      </Show>
      <div
        class={styles.rightPanel}
        classList={{ [styles.hidden]: !filetreeOn() }}
        style={{ width: `${rightW()}px` }}
      >
        <OverflowTabBar
          class={styles.rightTabs}
          items={rightTabs()}
          activeId={rightMode()}
          idOf={(t) => t.mode}
          onActivate={(id) => setRightMode(id as RightMode)}
          onReorder={(next) => setModeOrder(next.map((t) => t.mode))}
          trailing={<Show when={props.onToggleFiletree}>{filetreeToggleBtn(true)}</Show>}
          renderTab={(t) => (
            <Tab
              active={rightMode() === t.mode}
              icon={<Icon icon={t.icon} />}
              onClick={() => setRightMode(t.mode)}
              title={t.label}
              aria-label={t.label}
            />
          )}
          renderMenuItem={(t) => (
            <>
              <Icon icon={t.icon} />
              <span class="tab-name">{t.label}</span>
            </>
          )}
        />
        <Switch>
          <Match when={rightMode() === "files"}>
            <FileTree root={root()} />
          </Match>
          <Match when={rightMode() === "problems"}>
            <ProblemsPanel selected={props.selected} />
          </Match>
          <Match when={rightMode() === "changes"}>
            <ReviewPanel root={root()} selected={props.selected} onReverted={handleReverted} />
          </Match>
          <Match when={rightMode() === "search"}>
            <SearchPanel root={root()} focusNonce={searchFocusNonce()} />
          </Match>
          <Match when={rightMode() === "session" && props.selected?.sessionId}>
            <SessionPanel
              path={props.selected!.sessionPath ?? null}
              agent={props.selected!.agent ?? "claude"}
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
