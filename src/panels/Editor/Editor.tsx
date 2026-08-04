import { createSignal, createEffect, on, onCleanup, onMount, lazy, Match, Show, Suspense, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// CodeMirror and its Lezer grammars are ~1.3 MB of source, the single largest
// thing in the bundle, and none of it is needed until a file is actually open.
// The render site below already sits behind `filePaths().length`, so the chunk
// is fetched on the first file open and the pane's own empty state covers the
// gap. Keep this a lazy edge: a static import of CodeEditor, lspClient or
// diffGutter anywhere on the eager path silently undoes the split.
const CodeEditor = lazy(() => import("./CodeEditor"));
import FileTree from "./FileTree/FileTree";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import ReviewPanel from "./ReviewPanel";
import PullRequests from "./PullRequests/PullRequests";
import ProblemsPanel from "./ProblemsPanel";
import OutlinePanel from "./OutlinePanel";
import { diagnostics, clearDiagnostics } from "../../utils/diagnostics";
import { isMarkdownPath } from "../../utils/liveBuffer";
import { editorDefaults, loadWorkspaceSettings } from "../Settings/settingsStore";
import { toggledWrap, withoutTab, type WrapOverrides } from "./softWrapTabs";
import { symbolsSupported, clearSymbols } from "../../utils/symbols";
import type { RevertOutcome } from "./CheckpointTimeline";
import SearchPanel from "./SearchPanel";
import SessionPanel from "./SessionPanel";
import MarkdownPreview from "./MarkdownPreview";
import CommitLog from "./CommitLog";
import CommitDetail from "./CommitDetail";
import ConflictView from "./ConflictView";
import ImageView, { isImagePath } from "./ImageView";
import OverflowTabBar from "../../components/OverflowTabBar";
import Resizer from "../../components/Resizer/Resizer";
import IconButton from "../../components/IconButton/IconButton";
import Button from "../../components/Button/Button";
import Menu, { type MenuItem, type MenuState } from "../../components/Menu/Menu";
import Tab from "../../components/Tab/Tab";
import FileIcon from "../../seti/FileIcon";
import Icon from "../../components/Icon/Icon";
import {
  X,
  ArrowLeft,
  ArrowRight,
  Bot,
  FileCodeCorner,
  FileTypeCorner,
  FileHeart,
  Files,
  GitCompare,
  GitPullRequest,
  TriangleAlert,
  ListTree,
  Search,
  MessagesSquare,
  Share2,
  BookOpen,
  PanelRight,
  History,
  UserRound,
  type LucideIcon,
} from "lucide-solid";
import {
  on as onEvent,
  onWith,
  emitWith,
  OPEN_IN_EDITOR,
  PURGE_UNDER_PATH,
  DRAG_PATH_MIME,
  FOCUS_PROJECT_SEARCH,
  SET_RIGHT_MODE,
  FILE_RENAMED,
  EDITOR_CLOSE_TAB,
  EDITOR_TOGGLE_PREVIEW,
  EDITOR_TOGGLE_SOFT_WRAP,
  EDITOR_GOTO_LINE,
  EDITOR_NAV_BACK,
  EDITOR_NAV_FORWARD,
  EDITOR_REOPEN_CLOSED,
  GIT_STAGE_ACTIVE,
  GIT_UNSTAGE_ACTIVE,
  GIT_COMMIT,
  GIT_PUSH,
  TOAST,
  type ToastEvent,
  type OpenInEditor,
  type PurgeUnderPath,
  type LiveTab,
  type SetRightMode,
  type FileRenamed,
  type FsChanged,
} from "../../utils/events";
import { isUnderPath, mentionPath } from "../../utils/pathScope";
import { readBlamePref, writeBlamePref } from "../../utils/blamePref";
import { loadTabs, saveTabs, toStore, mergeStore, restoreFor } from "../../utils/editorTabPersist";
import { dropStashEntry, loadPendingStash, pendingStashPaths, requestStash } from "../../utils/hotExit";
import {
  refreshGit,
  startGitWatch,
  gitState,
  isConflicted,
  stagedFiles,
  stage as stageFiles,
  unstage as unstageFiles,
  commit as commitStaged,
  push as pushToOrigin,
} from "../../utils/gitActions";
import { publishEditorState, clearEditorState } from "../../utils/editorState";
import { purgeTabsUnder } from "./purgeTabs";
import { renameTabsUnder, repoint } from "./renameTabs";
import { isSyntheticId, parseSyntheticId, syntheticId, syntheticTabName } from "../../utils/syntheticTabs";
import {
  canGoBack,
  canGoForward,
  current,
  listFor,
  mapPathsIn,
  recentTargets,
  recordIn,
  stepIn,
  type JumpEntry,
  type JumpStore,
} from "../../utils/jumpList";
import {
  loadFrecency,
  mapPaths as mapFrecencyPaths,
  note,
  saveFrecency,
  type FrecencyStore,
  type Touch,
} from "../../utils/frecency";
import { rememberClosedTab, sweepClosed, takeClosedTab, type ClosedStore } from "./reopenStack";
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
import { askAgentToResolve } from "../../utils/conflictAsk";
import { findAgent } from "../../utils/agents";
import type { SessionTarget } from "../../utils/safeSend";
import type { RevertCandidate } from "../../utils/revertGuard";
import { isSelfWrite } from "../../utils/selfWrites";
// Not a static import: lspClient pulls @codemirror/lsp-client, which reaches
// the rest of CodeMirror and would put the whole graph back in the startup
// chunk. The only call is the fire-and-forget warm-up below.
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
type RightMode =
  | "files"
  | "changes"
  | "pulls"
  | "problems"
  | "outline"
  | "shared"
  | "docs"
  | "session"
  | "search";
type ModeTab = { mode: RightMode; label: string; icon: LucideIcon };
const RIGHT_MODE_TABS: Record<RightMode, ModeTab> = {
  files: { mode: "files", label: "Files", icon: Files },
  changes: { mode: "changes", label: "Changes", icon: GitCompare },
  pulls: { mode: "pulls", label: "Pull requests", icon: GitPullRequest },
  problems: { mode: "problems", label: "Problems", icon: TriangleAlert },
  outline: { mode: "outline", label: "Outline", icon: ListTree },
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

/** A tab's path relative to its workspace, for the surfaces that speak git.
 *  Null when the tab is a view, or a file from somewhere else entirely.
 *
 *  Strictly *under* the root, not equal to it: the empty string is not a
 *  pathspec, and git reads it as "everything", which is the opposite of one
 *  file's history. */
function repoRelative(path: string, root: string): string | null {
  if (isSyntheticId(path)) return null;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

// A synthetic view takes one glyph for the whole kind; a file keeps the seti
// icon its extension earns it.
function tabIcon(t: FileTab) {
  return isSyntheticId(t.path) ? <Icon icon={History} /> : <FileIcon name={t.name} />;
}

// A file tab's tooltip is its path. A view's is the workspace it belongs to,
// which is the one thing its label cannot say and the only thing telling two
// branch-units' log tabs apart.
function tabTitle(t: FileTab): string {
  return parseSyntheticId(t.path)?.workspace ?? t.path;
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
  // Tabs belong to a workspace (branch-unit folder), not to the editor: a file
  // open in one worktree has no meaning in another, and usually does not exist
  // there. Switching branch-unit therefore swaps the strip, and coming back
  // restores the strip you left. Both maps are keyed by workspace and read
  // through the accessors below, so every call site still says `tabs()`.
  //
  // The empty-string key is the bucket for "no selection yet". Nothing can
  // select into it, so it is transient by construction, and `toStore` refuses to
  // persist under it.
  const [tabsByWs, setTabsByWs] = createSignal<Record<string, FileTab[]>>({});
  const [activeByWs, setActiveByWs] = createSignal<Record<string, string | null>>({});
  // Derived from `root()` rather than reading the prop a second time, so the two
  // cannot drift; they differ only in how each spells "nothing selected".
  const ws = () => root() ?? "";
  const tabs = () => tabsByWs()[ws()] ?? [];
  const activeId = () => activeByWs()[ws()] ?? null;
  function setTabs(next: FileTab[] | ((prev: FileTab[]) => FileTab[])) {
    const key = ws();
    setTabsByWs((prev) => ({
      ...prev,
      [key]: typeof next === "function" ? next(prev[key] ?? []) : next,
    }));
  }
  function setActiveId(id: string | null) {
    const key = ws();
    setActiveByWs((prev) => ({ ...prev, [key]: id }));
  }
  // Dirty state and preview choices are keyed by absolute path, so they need no
  // workspace dimension: a path names exactly one file across every workspace.
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
    "pulls",
    "problems",
    "outline",
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
      // Only for a file whose server actually answers `documentSymbol`. A
      // `.txt` tab, or a language with no server, has no outline to show, and
      // an always-present empty panel reads as "this file has no symbols".
      case "outline":
        return symbolsSupported(activeId());
      default:
        return true;
    }
  }
  const rightTabs = () => modeOrder().filter(modeAvailable).map((m) => RIGHT_MODE_TABS[m]);
  const [searchFocusNonce, setSearchFocusNonce] = createSignal(0);
  // Source-vs-render preview toggle, per tab id (so switching tabs remembers
  // each previewable file's own choice: .md renders to HTML, .svg to its image).
  const [previewOn, setPreviewOn] = createSignal<Set<string>>(new Set());
  // Per-tab soft-wrap overrides; the rule itself lives in `softWrapTabs.ts`.
  const [wrapById, setWrapById] = createSignal<WrapOverrides>({});
  const [follow, setFollow] = createSignal(false);
  const [gotoTarget, setGotoTarget] = createSignal<
    { path: string; line: number; col?: number; nonce: number } | null
  >(null);
  let gotoNonce = 0;
  // Where you have been, per workspace, for the Back/Forward arrows. Bucketed
  // the same way the tab strip is, and for the same reason: a path open in one
  // worktree names nothing in another. The rule lives in `jumpList.ts`.
  const [jumpsByWs, setJumpsByWs] = createSignal<JumpStore>({});
  const jumps = () => listFor(jumpsByWs(), ws());

  /** Note arriving somewhere. Synthetic views are skipped: a commit-log or
   *  conflict tab is a thing you opened, not a place in the code you would want
   *  Back to take you to. */
  function recordJump(entry: JumpEntry) {
    if (isSyntheticId(entry.path)) return;
    setJumpsByWs((s) => recordIn(s, ws(), entry));
  }

  // How much you work in each file, for the pickers' empty box. Read once at
  // start and written back on every change; the pickers read the same storage
  // when they open rather than being handed it, so nothing has to be plumbed
  // through App to two components that mount and unmount on a keystroke.
  const [frecency, setFrecency] = createSignal<FrecencyStore>(loadFrecency(Date.now()));
  createEffect(() => saveFrecency(frecency()));
  // The tabs you closed, for Cmd+Shift+T. Session-lived on purpose: reopening
  // is an undo of something you just did, and last week's closes are what the
  // pickers above are for.
  const [closedByWs, setClosedByWs] = createSignal<ClosedStore>({});

  /** Note working in a file. Synthetic views are skipped for `recordJump`'s
   *  reason: `sway://` is not a path any picker can offer. */
  function noteTouch(path: string, kind: Touch) {
    if (isSyntheticId(path)) return;
    setFrecency((s) => note(s, ws(), path, kind, Date.now()));
  }

  /**
   * Walk the list and go where it lands.
   *
   * Deliberately not routed through OPEN_IN_EDITOR: that is where arrivals are
   * recorded, so going back through it would record the place you came back to
   * as a new destination and take the forward leg with it.
   */
  function goJump(dir: -1 | 1) {
    const before = jumpsByWs();
    const after = stepIn(before, ws(), dir);
    if (after === before) return;
    setJumpsByWs(after);
    const entry = current(listFor(after, ws()));
    if (!entry) return;
    openFile(entry.path);
    // No line means "wherever that file sits", which is what an entry recorded
    // by a tree click means: the tab may already be open a long way down, and
    // scrolling it to the top would be a worse answer than leaving it alone.
    if (entry.line) setGotoTarget({ path: entry.path, line: entry.line, nonce: ++gotoNonce });
  }

  const filePaths = () => tabs().map((t) => t.path);
  // Every workspace's open paths, not just the visible strip's. CodeEditor
  // evicts the buffer of any path this does not name, so handing it the visible
  // strip alone would throw away a background workspace's buffers - unsaved
  // edits included - the moment you switched branch-unit, with none of the
  // discard confirm that closing a tab goes through.
  // Synthetic views are filtered out here rather than downstream: this is the
  // set CodeEditor keeps buffers for, and a `sway://` id has no file to read, no
  // buffer to keep, and so no language server to attach.
  const allOpenPaths = () =>
    Object.values(tabsByWs()).flatMap((ts) => ts.map((t) => t.path).filter((p) => !isSyntheticId(p)));
  const activeTab = () => tabs().find((t) => tabId(t) === activeId()) ?? null;
  // The active tab when it is a real file. The three suffix tests below ask
  // what is on disk, and a synthetic id ends in the workspace path - a folder
  // named `notes.md` would otherwise give the commit log a preview toggle and
  // render MarkdownPreview against a `sway://` id.
  const activeFileTab = () => {
    const t = activeTab();
    return t && !isSyntheticId(t.path) ? t : null;
  };
  const isImageTab = () => {
    const t = activeFileTab();
    return t != null && isImagePath(t.path);
  };
  const isMarkdownTab = () => {
    const t = activeFileTab();
    return t != null && isMarkdownPath(t.path);
  };
  const isSvgTab = () => {
    const t = activeFileTab();
    return t != null && t.path.toLowerCase().endsWith(".svg");
  };
  // A view rather than a file: CodeEditor stays out of its way, the same as it
  // does for an image or a rendered preview.
  const syntheticTab = () => {
    const t = activeTab();
    return t ? parseSyntheticId(t.path) : null;
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
  function toggleSoftWrap() {
    const id = activeId();
    if (!id || isSyntheticId(id)) return;
    setWrapById((prev) => toggledWrap(prev, id, editorDefaults().softWrap));
  }

  // The session/branch-unit working folder is the anchor for the editor, file
  // tree, gutter, review surface, fs watcher, and LSP, not the project container.
  const root = () => props.selected?.folderPath ?? null;

  // The open file is mid-conflict. Read from the shared git store rather than
  // probed per file: the store is already refreshed by every watcher burst and
  // every git action, so the banner appears and clears on the same beat as the
  // Changes panel's Conflicts section, with no second source of truth.
  const conflicted = () => isConflicted(root(), activeFileTab()?.path ?? null);

  /** Open the open file's three-way view. A tab rather than a pane inside this
   *  one: the file itself stays open beside it, which is where the reader ends
   *  up once they know which side they want. */
  function openConflictView() {
    const r = root();
    const path = activeFileTab()?.path;
    const rel = r && path && repoRelative(path, r);
    if (!r || !rel) return;
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("conflict", r, rel) });
  }

  // Safe-send's capability gate, the same pair the Changes and Problems panels
  // keep: a target to name and a reason to refuse when there is nothing to send
  // to (no session selected, or an adapter whose sessions cannot be resumed).
  function sendTarget(): SessionTarget | null {
    const sel = props.selected;
    if (!sel?.sessionId) return null;
    return {
      sessionId: sel.sessionId,
      agent: sel.agent ?? "claude",
      folderPath: sel.folderPath,
      sessionCwd: sel.sessionCwd,
      sessionPath: sel.sessionPath,
      sessionTitle: sel.sessionTitle,
      sessionFile: sel.sessionFile,
    };
  }

  function sendDisabledReason(): string | null {
    const sel = props.selected;
    if (!sel?.sessionId) return "Select a session first";
    if (findAgent(sel.agent ?? "claude").resume_args.length === 0) return "This agent's sessions can't be resumed";
    return null;
  }

  const [askingConflict, setAskingConflict] = createSignal(false);

  /** Hand the open file's conflict to the selected session. The Conflicts
   *  section's row offers the same thing for a file that is not open; both go
   *  through the one composer, so the agent is asked in the same words either
   *  way. */
  async function askAgentToResolveOpen() {
    const r = root();
    const path = activeFileTab()?.path;
    const rel = r && path && repoRelative(path, r);
    const t = sendTarget();
    const reason = sendDisabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return;
    }
    if (!r || !rel || !t || askingConflict()) return;
    setAskingConflict(true);
    try {
      await askAgentToResolve(t, r, rel);
    } finally {
      setAskingConflict(false);
    }
  }

  // The tab strip's right-click menu.
  const [tabMenu, setTabMenu] = createSignal<MenuState | null>(null);

  const [blameOn, setBlameOn] = createSignal(readBlamePref());
  function toggleBlame() {
    const next = !blameOn();
    setBlameOn(next);
    writeBlamePref(next);
  }

  function openTabMenu(e: MouseEvent, t: FileTab) {
    const r = root();
    const rel = r && repoRelative(t.path, r);
    // A view has no history of its own, so the menu it would open is empty, and
    // the browser's own menu is more useful than a menu with nothing in it.
    if (!r || !rel) return;
    e.preventDefault();
    const items: MenuItem[] = [
      {
        label: "File history",
        onClick: () => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("history", r, rel) }),
      },
    ];
    setTabMenu({ x: e.clientX, y: e.clientY, items });
  }

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
    // And Outline disappears when the active tab is a file no server has
    // symbols for, which switching tabs is enough to cause.
    if (rightMode() === "outline" && !symbolsSupported(activeId())) setRightMode("files");
  });

  // Start (and on folder switch, replace) the fs watcher so the gutter and the
  // review surface refresh on external changes.
  createEffect(
    on(root, (r) => {
      // The shared git store's root-change refresh is driven from here, not from
      // the Changes panel: that panel is unmounted whenever the right pane shows
      // anything else, and the palette's git commands still have to know whether
      // this workspace has anything staged or anything to push.
      void refreshGit(r);
      // The per-workspace settings overlay, for the same reason: this pane is
      // always mounted and is what knows which workspace is selected, and the
      // Settings panel (which badges the overlay) is usually not open.
      void loadWorkspaceSettings(r);
      if (!r) return;
      invoke("fs_watch_start", { projectPath: r }).catch(() => {});
      // A new project means a new language server; diagnostics from the old one
      // describe files that are no longer open here, and so do its symbols.
      // The tab set changing evicts both anyway, but that is one more thing
      // than "the servers are gone" has to depend on.
      clearDiagnostics();
      clearSymbols();
      // Stop every server from the previous project. Servers are no longer
      // started here: a session is per (server, root), and which roots a
      // project needs is only known once files are opened, so `CodeEditor`
      // starts one lazily on the first file of each language instead. Already
      // fire-and-forget, so loading the client lazily changes nothing the
      // caller can observe, and it keeps CodeMirror out of the startup chunk.
      void import("./lspClient").then((m) => m.stopAllLsp());
    }),
  );

  // A tab is bucketed by the workspace selected when it was opened, which is
  // what makes Docs-tree and `.shared/` files - real files that live outside any
  // project root - land somewhere predictable instead of nowhere.
  function openFile(path: string) {
    if (!tabs().some((t) => t.path === path)) {
      setTabs([...tabs(), { path, name: isSyntheticId(path) ? syntheticTabName(path) : basename(path) }]);
    }
    setActiveId(path);
  }

  // What was stored last run. Read once, because it is the thing this run's
  // saves are merged into: re-reading would fold our own writes back in.
  const restorable = loadTabs(Date.now());
  // The unsaved buffers last run's quit stashed, if any. Started here and
  // awaited by the restore below, so a tab can never be handed to CodeEditor
  // before the stash it should be built from has arrived. Deliberately not
  // gated on the resolved `hotExit`: the key decides whether new work is
  // stashed, and work already on disk is handed back whatever it says now.
  const stashReady = loadPendingStash(Date.now());
  // Workspaces this run has opened tabs in, ever. `toStore` only sees what is
  // open right now, so at startup it yields `{}`; without this set a save would
  // erase every stored workspace before the first tab is opened.
  const touchedWs = new Set<string>();
  // Workspaces already offered a restore this run, so returning to one does not
  // re-restore over tabs you have since closed.
  const restoredWs = new Set<string>();

  createEffect(() => {
    const live = toStore(
      Object.entries(tabsByWs()).flatMap(([workspace, ts]) => ts.map((t) => ({ path: t.path, workspace }))),
      activeByWs(),
      Date.now(),
    );
    for (const w of Object.keys(live)) touchedWs.add(w);
    saveTabs(mergeStore(restorable, live, touchedWs));
  });

  // Restore on first visit to a workspace, automatically. The terminal's
  // equivalent is an offer banner because a relaunch must never silently spawn
  // agent processes; opening a file spawns nothing, so the ceremony would only
  // cost a click. Lazy by construction: this sets descriptors, and only the
  // active tab's buffer is built, by CodeEditor's own swap.
  async function restoreWorkspace(w: string) {
    const entry = restorable[w];
    if (!entry?.paths.length) return;
    // Files opened here already this run are current truth; a restore would be
    // pasting last run's strip over them. Synthetic tabs do not count: opening
    // the commit log from the sidebar selects the branch-unit and opens the tab
    // in the same breath, which lands while these probes are still in flight,
    // and that must not cost the workspace its file restore.
    if (openFileTabs(w).length) return;
    await stashReady;
    // A path with stashed unsaved work counts as alive whether or not the file
    // is still there: the text that matters is in the stash, not on disk, and
    // dropping the tab is the one outcome that loses it for good.
    const stashed = new Set(pendingStashPaths());
    const alive = new Set<string>();
    await Promise.all(
      entry.paths.map(async (p) => {
        // A path that cannot be probed is treated as gone: a tab whose buffer
        // can only ever report that it failed to open is worse than no tab.
        if (stashed.has(p) || (await invoke<boolean>("file_exists", { path: p }).catch(() => false))) {
          alive.add(p);
        }
      }),
    );
    const { paths, active } = restoreFor(entry, alive);
    if (!paths.length) return;
    // Re-checked after the await: the user may have opened something here while
    // the existence probes were in flight.
    if (openFileTabs(w).length) return;
    // Restored tabs go *after* whatever is already open (a log tab, at most), and
    // an active tab the user has since chosen outranks the stored one.
    setTabsByWs((prev) => ({
      ...prev,
      [w]: [...(prev[w] ?? []), ...paths.map((p) => ({ path: p, name: basename(p) }))],
    }));
    setActiveByWs((prev) => ({ ...prev, [w]: prev[w] ?? active }));
    // The dirty dot comes from the stash, not from a buffer. Only the active
    // tab's buffer is ever built by a restore, so waiting for `onDirty` would
    // leave the other stashed tabs looking clean until they were clicked, which
    // is precisely when someone decides they have nothing to come back to.
    const carrying = paths.filter((p) => stashed.has(p));
    if (carrying.length) {
      setDirty((d) => ({ ...d, ...Object.fromEntries(carrying.map((p) => [p, true])) }));
    }
  }

  /** This workspace's real-file tabs; synthetic views are not restorable state. */
  function openFileTabs(w: string): FileTab[] {
    return (tabsByWs()[w] ?? []).filter((t) => !isSyntheticId(t.path));
  }

  createEffect(() => {
    const w = ws();
    if (!w || restoredWs.has(w)) return;
    restoredWs.add(w);
    void restoreWorkspace(w);
  });

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
    // Discarded means discarded. A tab restored from the stash has its dirty
    // dot before any buffer exists, so nothing has claimed its entry yet, and
    // an entry left pending is carried through the next quit and handed back on
    // the launch after that.
    dropStashEntry(tab.path);
    // Only real files are reopenable. A synthetic view is rebuilt from whatever
    // opened it (a commit, a conflict), so putting its id back would name a tab
    // rather than a file.
    if (!isSyntheticId(tab.path)) setClosedByWs((s) => rememberClosedTab(s, ws(), tab.path));
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
    // Same reason the preview choice goes: a closed tab's per-tab state would
    // otherwise come back to a file reopened days later with no explanation.
    setWrapById((prev) => withoutTab(prev, id));
    if (activeId() === id) {
      setActiveId(remaining.length ? tabId(remaining[remaining.length - 1]) : null);
    }
  }

  /**
   * Put the most recently closed tab back (Cmd+Shift+T).
   *
   * Nothing here restores the *document*: reopening goes through `openFile`, so
   * `CodeEditor` swaps the buffer back in through the path it always uses, and
   * `reviveClosed` decides whether the text it kept still describes the file.
   * A file changed on disk since the close therefore opens fresh rather than
   * replaying an undo history into a document that has moved.
   */
  function reopenClosedTab() {
    const taken = takeClosedTab(closedByWs(), ws());
    if (!taken.path) return;
    setClosedByWs(taken.store);
    openFile(taken.path);
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
    dropStashEntry(path);
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
    // The clean-to-dirty edge, not every keypress: CodeEditor reports this on
    // each document change, so counting them all would score a file by how much
    // was typed into it rather than by how often it was worked in.
    if (isDirty && !dirty()[path]) noteTouch(path, "edit");
    setDirty((prev) => (prev[path] === isDirty ? prev : { ...prev, [path]: isDirty }));
  }

  // A space is being deleted: force-close every open tab rooted under it, without
  // the per-file dirty prompt (the folder is going away regardless). The sweep
  // itself is pure and lives in `purgeTabs`, so it can be tested without a
  // mounted editor and both maps come back from one pass.
  function purgeUnder(path: string) {
    // Ahead of the early return: a place can be in the jump list without a tab
    // still holding it open, and an arrow onto a trashed file is exactly the
    // dangling reference this sweep exists to stop.
    setJumpsByWs((s) => mapPathsIn(s, (p) => (isUnderPath(p, path) ? null : p)));
    setFrecency((s) => mapFrecencyPaths(s, (p) => (isUnderPath(p, path) ? null : p)));
    setClosedByWs((s) => sweepClosed(s, (p) => (isUnderPath(p, path) ? null : p)));
    const next = purgeTabsUnder({ tabs: tabsByWs(), active: activeByWs() }, path);
    if (!next.removed.length) return;
    setTabsByWs(next.tabs);
    setActiveByWs(next.active);
    setDirty((d) => {
      const out = { ...d };
      for (const p of next.removed) delete out[p];
      return out;
    });
    // The folder is going, so stashed work rooted under it has nowhere to be
    // restored to; carrying it forward would resurrect a tab onto a path that
    // no longer exists.
    for (const p of next.removed) dropStashEntry(p);
  }

  // A file or folder moved on disk: repoint every tab addressing it instead of
  // closing anything. A rename is not a removal, so a dirty buffer has to come
  // along with its unsaved text; the sweep itself is pure and lives in
  // `renameTabs`, next to `purgeTabs` for the same reasons.
  function followRename(from: string, to: string) {
    // Same reason as the purge sweep, and the same place: a file can be a
    // recorded place without being an open tab, so this cannot sit behind the
    // "did any tab move" return.
    setJumpsByWs((s) => mapPathsIn(s, (p) => repoint(p, from, to) ?? p));
    setFrecency((s) => mapFrecencyPaths(s, (p) => repoint(p, from, to) ?? p));
    setClosedByWs((s) => sweepClosed(s, (p) => repoint(p, from, to) ?? p));
    const next = renameTabsUnder({ tabs: tabsByWs(), active: activeByWs() }, from, to);
    if (!next.moved.length) return;
    setTabsByWs(next.tabs);
    setActiveByWs(next.active);
    // Dirty flags are keyed by path, so they move with the tab or the strip
    // would show a clean file that still holds unsaved edits.
    setDirty((d) => {
      const out = { ...d };
      for (const m of next.moved) {
        if (m.from in out) {
          out[m.to] = out[m.from];
          delete out[m.from];
        }
      }
      return out;
    });
  }

  // Published for the command palette, which is this pane's sibling and can
  // reach none of the above. One effect over everything the snapshot names, so
  // its parts can never describe two different moments.
  createEffect(() => {
    const active = activeId();
    // A synthetic view reports no active *file*, so the palette's save, preview,
    // go-to-line and stage commands correctly refuse on it. `tabCount` still
    // counts it, which is what keeps "Close editor tab" available.
    const file = active && !isSyntheticId(active) ? active : null;
    publishEditorState({
      activePath: file,
      dirty: file ? !!dirty()[file] : false,
      tabCount: tabs().length,
      projectRoot: root(),
      recentJumps: recentTargets(jumps()),
    });
  });
  onCleanup(clearEditorState);

  // --- Command registry -----------------------------------------------------
  //
  // The editor commands land here because this pane owns the tabs, and the git
  // ones because it is the only always-mounted component that knows both the
  // selected workspace and the active file. Each acts on whatever is active now,
  // never on what the palette row was named after: the two can differ by the
  // time the row is picked.
  //
  // Text input goes through the prompt this pane already owns, so the palette
  // has closed by the time the prompt opens rather than the two stacking.

  async function gotoLineFromPrompt() {
    const path = activeId();
    if (!path) return;
    const answer = await askText("Go to line", "");
    const line = Number(answer?.trim());
    if (!answer || !Number.isInteger(line) || line < 1) return;
    setGotoTarget({ path, line, nonce: ++gotoNonce });
  }

  // Repo-relative, which is what every git_* command takes. A file outside the
  // workspace (a Docs note, a `.shared/` file) has no path git would accept, so
  // it is refused by name rather than staged against the wrong repo.
  //
  // Relativized through `mentionPath` rather than by slicing the root's length:
  // `isUnderPath` normalizes a trailing slash before comparing, so a root that
  // carried one would pass the guard and then yield a path off by a character.
  function activeRepoPath(): string | null {
    const r = root();
    const path = activeId();
    if (!r || !path) return null;
    if (!isUnderPath(path, r)) {
      emitWith<ToastEvent>(TOAST, {
        message: `${basename(path)} isn't in this workspace, so git has nothing to stage.`,
        kind: "error",
      });
      return null;
    }
    return mentionPath(path, r);
  }

  function stageActive(staging: boolean) {
    const r = root();
    const rel = activeRepoPath();
    if (!r || !rel) return;
    void (staging ? stageFiles(r, [rel]) : unstageFiles(r, [rel]));
  }

  async function commitFromPrompt() {
    const r = root();
    // Re-checked here, not just in the palette's enablement: the index can move
    // between the row being listed and the prompt being answered.
    if (!r || !stagedFiles().length) return;
    const message = (await askText("Commit message", ""))?.trim();
    if (!message) return;
    await commitStaged(r, message);
  }

  function pushCurrentBranch() {
    const { root: r, branch } = gitState();
    if (r && branch) void pushToOrigin(r, branch);
  }

  let offTouched: UnlistenFn | undefined;
  let offOpen: (() => void) | undefined;
  let offPurge: (() => void) | undefined;
  let offClose: (() => void) | undefined;
  let offFollow: UnlistenFn | undefined;
  let offProjectSearch: (() => void) | undefined;
  let offSetRightMode: (() => void) | undefined;
  let offFileRenamed: (() => void) | undefined;
  let offGitWatch: (() => void) | undefined;
  let offCommands: (() => void)[] = [];

  onMount(async () => {
    // Registered before the first await: these are synchronous window listeners,
    // and there is no reason to leave a window in which a command silently does
    // nothing.
    offCommands = [
      onEvent(EDITOR_CLOSE_TAB, () => {
        const id = activeId();
        if (id) void closeTab(id);
      }),
      onEvent(EDITOR_TOGGLE_PREVIEW, togglePreview),
      onEvent(EDITOR_TOGGLE_SOFT_WRAP, toggleSoftWrap),
      onEvent(EDITOR_GOTO_LINE, () => void gotoLineFromPrompt()),
      onEvent(EDITOR_NAV_BACK, () => goJump(-1)),
      onEvent(EDITOR_NAV_FORWARD, () => goJump(1)),
      onEvent(EDITOR_REOPEN_CLOSED, reopenClosedTab),
      onEvent(GIT_STAGE_ACTIVE, () => stageActive(true)),
      onEvent(GIT_UNSTAGE_ACTIVE, () => stageActive(false)),
      onEvent(GIT_COMMIT, () => void commitFromPrompt()),
      onEvent(GIT_PUSH, pushCurrentBranch),
    ];
    // `.git` is watcher-filtered, so a fetch moving the upstream emits no
    // fs://changed. Subscribed here because this component outlives the panel
    // that used to hold these listeners.
    offGitWatch = await startGitWatch();
    // Turn end for every adapter: the transcript watcher's debounced signal.
    offTouched = await listen("sessions://changed", () => {
      void refreshTouched();
      void refreshActors().then(refreshEditing);
    });
    offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => {
      if (!d?.path) return;
      openFile(d.path);
      if (d.line) setGotoTarget({ path: d.path, line: d.line, col: d.col, nonce: ++gotoNonce });
      // The one place arrivals are recorded. Go-to-definition, a search hit and
      // a quick-open pick all reach the editor through this event, so recording
      // it here is what keeps each of them worth exactly one entry - a second
      // recording site per feature is how a jump list ends up with two entries
      // for one destination.
      recordJump({ path: d.path, line: d.line });
      noteTouch(d.path, "open");
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
    offFileRenamed = onWith<FileRenamed>(FILE_RENAMED, (d) => {
      if (d?.from && d.to) followRename(d.from, d.to);
    });
    // Follow mode: auto-open the most-recently-changed project file. The watcher
    // already filters .git/node_modules/dist/target, and self-writes are skipped,
    // so follow never jumps to git internals, build output, or our own saves.
    offFollow = await listen<FsChanged>("fs://changed", (e) => {
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
      // Hot exit rewrites the stash on *every* quit, not only when something is
      // unsaved. The file is the whole of this feature's memory, and a quit
      // that wrote nothing left the previous run's entries sitting in it: the
      // next launch loaded them, marked those tabs dirty, and handed the old
      // text back over files that had since been saved. Worse than useless,
      // because `savedText` still matched disk, so it did not even raise the
      // conflict banner - it just quietly reintroduced edits the user had
      // already dealt with.
      //
      // With nothing dirty the write costs one small file and resolves in
      // milliseconds; `stashToWrite` then yields whatever is still genuinely
      // pending (a stashed tab nobody clicked keeps its entry, a claimed or
      // saved one does not).
      if (!anyDirty && !editorDefaults().hotExit) return;
      event.preventDefault();
      // Hot exit replaces the prompt rather than sitting beside it: there is
      // nothing to warn about once the work is kept. But only once it *is*
      // kept - the key being on is not evidence that anything reached the
      // disk, so a refused or unanswered stash falls back to the same confirm
      // that has always been here, and no buffer goes quietly.
      if (editorDefaults().hotExit && (await requestStash())) {
        await getCurrentWindow().destroy();
        return;
      }
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
    offFileRenamed?.();
    offGitWatch?.();
    for (const off of offCommands) off();
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
              onContextMenu={(e) => openTabMenu(e, t)}
              title={tabTitle(t)}
              // A synthetic view has no path to hand anyone: dropping its id on a
              // terminal would paste `sway://…`, which names nothing on disk.
              draggable={!isSyntheticId(t.path)}
              onDragStart={(e) => {
                e.dataTransfer?.setData(DRAG_PATH_MIME, t.path);
                e.dataTransfer?.setData("text/plain", t.path);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
              }}
              icon={tabIcon(t)}
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
              {tabIcon(t)}
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
              {/* Always mounted rather than shown only once there is somewhere
                  to go: a control that appears and disappears moves everything
                  beside it, and the greyed-out pair is what says the list has
                  an end. */}
              <IconButton
                icon={<Icon icon={ArrowLeft} />}
                disabled={!canGoBack(jumps())}
                onClick={() => goJump(-1)}
                title="Go back to where you were (⌃−)"
              />
              <IconButton
                icon={<Icon icon={ArrowRight} />}
                disabled={!canGoForward(jumps())}
                onClick={() => goJump(1)}
                title="Go forward again (⌃⇧−)"
              />
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
              <Show when={activeFileTab()}>
                <IconButton
                  active={blameOn()}
                  icon={<Icon icon={UserRound} />}
                  onClick={toggleBlame}
                  title={
                    blameOn()
                      ? "Showing git blame: who last changed each line, shaded by age. Click to hide."
                      : "Git blame: show who last changed each line, shaded by age."
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
        {/* Above the editor rather than inside it: the file on screen is the
            merged working-tree copy, markers and all, and nothing in the buffer
            itself says that is why it looks like that. */}
        <Show when={conflicted()}>
          <div class={styles.conflictBanner} role="status">
            <span>Merge conflict: this file holds both sides.</span>
            <Button size="xs" onClick={openConflictView}>
              Compare the versions
            </Button>
            <Button
              size="xs"
              disabled={!!sendDisabledReason() || askingConflict()}
              title={sendDisabledReason() ?? "Ask the selected session to resolve this conflict"}
              onClick={askAgentToResolveOpen}
            >
              Ask agent to resolve
            </Button>
          </div>
        </Show>
        {/* Mounted on the union, hidden on the visible strip. Gating the mount
            on the current workspace's tab count would unmount CodeEditor the
            moment you selected a workspace with nothing open, and its cleanup
            destroys the view and every buffer behind it - including a background
            workspace's unsaved edits, which is the loss `openPaths` carrying the
            union exists to prevent. */}
        <Show when={allOpenPaths().length}>
          <Suspense fallback={filePaths().length ? <div class={styles.editorEmpty}>Loading editor…</div> : null}>
            <CodeEditor
              activePath={
                activeTab() && !isImageTab() && !showingPreview() && !syntheticTab() ? activeId() : null
              }
              openPaths={allOpenPaths()}
              projectRoot={root()}
              goto={gotoTarget()}
              onDirty={handleDirty}
              onCursorJump={(path, line) => recordJump({ path, line })}
              onCloseFile={forceCloseFile}
              reverted={reverted()}
              selected={props.selected}
              hidden={!filePaths().length || isImageTab() || showingPreview() || !!syntheticTab()}
              blame={blameOn()}
              // The active tab's override, or null to follow the setting. Only
              // the shown buffer's answer is needed: the others are re-resolved
              // when they are swapped in.
              softWrap={wrapById()[activeId() ?? ""] ?? null}
              confirm={askConfirm}
            />
          </Suspense>
        </Show>
        <Show
          when={filePaths().length}
          fallback={
            <div class={styles.editorEmpty}>
              Open a file from the tree to start editing, or press ⌘P to find one by name.
            </div>
          }
        >
          <Show when={syntheticTab()}>
            {(t) => (
              <>
                <Show when={t().kind === "log"}>
                  <CommitLog workspace={t().workspace} />
                </Show>
                {/* One file's history is the same list under a pathspec, so it
                    is the same component, not a near-copy of it. */}
                <Show when={t().kind === "history"}>
                  <CommitLog workspace={t().workspace} file={t().arg} />
                </Show>
                <Show when={t().kind === "commit"}>
                  <CommitDetail workspace={t().workspace} sha={t().arg} />
                </Show>
                <Show when={t().kind === "conflict"}>
                  {/* Resolving rewrites the file, so it reports on the same
                      channel a discard or a checkpoint revert does: a buffer
                      open on it with unsaved edits is offered keep-mine /
                      take-disk rather than writing the conflict back. */}
                  <ConflictView
                    workspace={t().workspace}
                    file={t().arg}
                    onResolved={handleReverted}
                  />
                </Show>
              </>
            )}
          </Show>
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
            <FileTree
              root={root()}
              editable
              noun="project folder"
              activePath={activeId()}
              askText={askText}
              askConfirm={askConfirm}
            />
          </Match>
          <Match when={rightMode() === "problems"}>
            <ProblemsPanel selected={props.selected} />
          </Match>
          <Match when={rightMode() === "outline"}>
            <OutlinePanel path={activeId()} />
          </Match>
          <Match when={rightMode() === "changes"}>
            <ReviewPanel root={root()} selected={props.selected} onReverted={handleReverted} />
          </Match>
          <Match when={rightMode() === "pulls"}>
            <PullRequests root={root()} />
          </Match>
          <Match when={rightMode() === "search"}>
            <SearchPanel
              root={root()}
              focusNonce={searchFocusNonce()}
              dirty={dirty()}
              confirm={askConfirm}
            />
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
            <FileTree
              root={sharedPath()}
              editable
              noun="shared folder"
              askText={askText}
              askConfirm={askConfirm}
            />
          </Match>
          <Match when={rightMode() === "docs"}>
            <FileTree root={docsPath()} />
          </Match>
        </Switch>
      </div>
      <Show when={tabMenu()}>
        <Menu x={tabMenu()!.x} y={tabMenu()!.y} items={tabMenu()!.items} onClose={() => setTabMenu(null)} />
      </Show>
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
