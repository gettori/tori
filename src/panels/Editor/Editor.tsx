import { createSignal, createEffect, on, onCleanup, onMount, lazy, Match, Show, Suspense, Switch, type JSX } from "solid-js";
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
// The editable search results are a second CodeMirror instance, so they sit
// behind the same edge for the same reason. `searchResultsStore` and
// `searchResultsDoc` are deliberately free of any CodeMirror *value* import, so
// the Search panel can reach them on the eager path without dragging the
// library in behind them.
const SearchResultsBuffer = lazy(() => import("./SearchResultsBuffer"));
import FileTree from "./FileTree/FileTree";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import ReviewPanel from "./ReviewPanel";
import PullRequests from "./PullRequests/PullRequests";
import ProblemsPanel from "./ProblemsPanel";
import OutlinePanel from "./OutlinePanel";
import CallsPanel from "./CallsPanel";
import Breadcrumbs from "./Breadcrumbs";
import BookmarksPanel from "./BookmarksPanel";
import { diagnostics, clearDiagnostics } from "../../utils/diagnostics";
import { isMarkdownPath } from "../../utils/liveBuffer";
import { chromeScale, editorDefaults, loadWorkspaceSettings } from "../Settings/settingsStore";
import { toggledWrap, withoutTab, type WrapOverrides } from "./softWrapTabs";
import { symbolsSupported, clearSymbols } from "../../utils/symbols";
import { callsSupported, clearCallRoots } from "../../utils/callHierarchy";
import { debugRoots, stopAllDap, stopDebugRun } from "../../utils/dapSessions";
import { clearDebugConsole, debugRunning } from "../../utils/debugStore";
import DebugTargetDialog from "../../components/Dialogs/DebugTargetDialog";
import { launchTarget, resolveRoot, scriptsAt } from "../../utils/debugLaunch";
import {
  attachPortFor,
  lastTargetFor,
  loadAttachPorts,
  loadLastTargets,
  saveAttachPorts,
  saveLastTargets,
  setAttachPort,
  setLastTarget,
  type DebugTarget,
  type TargetKind,
} from "../../utils/debugTargets";
import type { RevertOutcome } from "./CheckpointTimeline";
import SearchPanel from "./SearchPanel";
import TodoPanel from "./TodoPanel";
import TasksPanel from "./TasksPanel";
import DebugPanel from "./DebugPanel";
import SessionPanel from "./SessionPanel";
import MarkdownPreview from "./MarkdownPreview";
import CommitLog from "./CommitLog";
import LocalHistory from "./LocalHistory";
import CommitDetail from "./CommitDetail";
import ConflictView from "./ConflictView";
import DebugSourceView from "./DebugSourceView";
import ImageView, { isImagePath } from "./ImageView";
import OverflowTabBar from "../../components/OverflowTabBar";
import Resizer from "../../components/Resizer/Resizer";
import IconButton from "../../components/IconButton/IconButton";
import Button from "../../components/Button/Button";
import ContextMenu from "../../components/Menu/ContextMenu";
import { type MenuItem } from "../../components/Menu/rows";
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
  ListChecks,
  Play,
  Bug,
  ListTree,
  // A call graph, not a telephone: `PhoneCall` reads as telephony.
  Network,
  // Aliased: `Bookmark` here is the glyph, and the type of the same name is the
  // thing it stands for.
  Bookmark as BookmarkGlyph,
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
  DEBUG_START,
  DEBUG_STOP,
  DEBUG_RESTART,
  DEBUG_PICK,
  type DebugPick,
  FILE_RENAMED,
  EDITOR_CLOSE_TAB,
  EDITOR_TOGGLE_PREVIEW,
  EDITOR_TOGGLE_SOFT_WRAP,
  EDITOR_GOTO_LINE,
  EDITOR_NEW_SCRATCH,
  EDITOR_SAVE_AS,
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
import { blameOn, writeBlamePref } from "../../utils/blamePref";
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
import {
  bookmarkRows,
  bookmarksFor,
  labelBookmark,
  loadBookmarks,
  mapPaths as mapBookmarkPaths,
  saveBookmarks,
  setFileBookmarks,
  toggleBookmark,
  type Bookmark,
  type BookmarkStore,
} from "../../utils/bookmarks";
import { frameLocation } from "../../utils/debugStack";
import {
  breakpointMarks,
  breakpointsMoved,
  mapBreakpointFiles,
  noteBufferClosed,
  noteBufferDirty,
  toggleBreakpointAt,
} from "../../utils/debugBreakpoints";
import { rememberClosedTab, sweepClosed, takeClosedTab } from "./reopenStack";
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
import { findAdapter } from "../../utils/agents";
import type { SessionTarget } from "../../utils/safeSend";
import type { RevertCandidate } from "../../utils/revertGuard";
import { isSelfWrite, markSelfWrite } from "../../utils/selfWrites";
import {
  defaultSaveName,
  isScratchPath,
  newScratchFile,
  resolveSavePath,
  scratchDirPath,
} from "../../utils/scratch";
// The window onto CodeEditor's buffers, for the two things Save-as needs and
// this pane cannot hold: the text of a buffer it does not own, and the way to
// tell that buffer its file has been rewritten to match.
import { adoptBufferText, liveBufferText } from "./liveBuffers";
// Not a static import: lspClient pulls @codemirror/lsp-client, which reaches
// the rest of CodeMirror and would put the whole graph back in the startup
// chunk. The only call is the fire-and-forget warm-up below.
import type { Selection } from "../LeftSidebar/LeftSidebar";
import {
  tabsByWs,
  setTabsByWs,
  activeByWs,
  setActiveByWs,
  closedByWs,
  setClosedByWs,
  resetEditorTabModel,
  type FileTab,
} from "./editorTabStore";
import { unifiedTabs, idOf, type FileUnifiedTab, type UnifiedTab } from "../../tabs/unifiedTabs";
import { registerKind, kindEntry, renderRegistryTab } from "../../tabs/registry";
import styles from "./Editor.module.css";

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
  | "calls"
  | "bookmarks"
  | "shared"
  | "docs"
  | "session"
  | "search"
  | "todos"
  | "tasks"
  | "debug";
type ModeTab = { mode: RightMode; label: string; icon: LucideIcon };
const RIGHT_MODE_TABS: Record<RightMode, ModeTab> = {
  files: { mode: "files", label: "Files", icon: Files },
  changes: { mode: "changes", label: "Changes", icon: GitCompare },
  pulls: { mode: "pulls", label: "Pull requests", icon: GitPullRequest },
  problems: { mode: "problems", label: "Problems", icon: TriangleAlert },
  outline: { mode: "outline", label: "Outline", icon: ListTree },
  calls: { mode: "calls", label: "Calls", icon: Network },
  bookmarks: { mode: "bookmarks", label: "Bookmarks", icon: BookmarkGlyph },
  search: { mode: "search", label: "Search", icon: Search },
  todos: { mode: "todos", label: "TODOs", icon: ListChecks },
  tasks: { mode: "tasks", label: "Tasks", icon: Play },
  debug: { mode: "debug", label: "Debug", icon: Bug },
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
// Floors in design px at `--ui-scale` 1, scaled with it like the app's outer
// panes. The right panel has no maximum: it grows until the code side would drop
// below its own floor, so a wide editor can be almost all file tree.
const RIGHT_W_MIN = 160;
const CODE_MIN = 320;
// The divider between the two (Resizer.module.css .resizer).
const RIGHT_GUTTER = 8;

function loadRightW(): number {
  const n = Number(localStorage.getItem(LS_RIGHT_W));
  // Taken as stored: the bound depends on the pane's measured width, which does
  // not exist yet. The clamp effect below applies it once it does.
  return Number.isFinite(n) && n > 0 ? n : 240;
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
  // The tab model lives in editorTabStore (module-level, phase 4 composes it);
  // the reset keeps its lifetime tied to this panel exactly as before.
  resetEditorTabModel();
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
      tooltip={shown ? "Hide the file tree (⌘⌥B)" : "Show the file tree (⌘⌥B)"}
    />
  );
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
  // Bounds for that drag, in the same scaled px the CSS uses. Measured from the
  // pane rather than fixed, so the ceiling is "everything the code side can
  // spare" on whatever width the editor currently has.
  const px = (base: number) => base * chromeScale();
  let paneEl: HTMLDivElement | undefined;
  const [paneW, setPaneW] = createSignal(0);
  onMount(() => {
    if (!paneEl) return;
    const ro = new ResizeObserver(([entry]) => setPaneW(entry.contentRect.width));
    ro.observe(paneEl);
    onCleanup(() => ro.disconnect());
  });
  // Unbounded until the pane has been measured, so a drag can never be pinned to
  // the floor by a width nothing has reported yet.
  const rightMax = () =>
    paneW() <= 0 ? Infinity : Math.max(px(RIGHT_W_MIN), paneW() - px(RIGHT_GUTTER) - px(CODE_MIN));
  // Same reason the app clamps its outer panes: the drag clamp only bites while a
  // pointer is down, so a stored width, a narrowed editor pane or a raised UI
  // scale could otherwise leave the code side with nothing. Not persisted, so
  // widening the pane again restores the width the user picked.
  createEffect(() => {
    if (paneW() <= 0) return;
    const w = Math.min(Math.max(rightW(), px(RIGHT_W_MIN)), rightMax());
    if (w !== rightW()) setRightW(w);
  });
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
    "calls",
    "bookmarks",
    "search",
    "todos",
    "tasks",
    "debug",
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
      // Same three-state rule, and the middle state is the point: hidden when
      // the server has no `callHierarchyProvider`, shown when it has one even
      // if the caret is not on anything callable - because "this language
      // cannot do this" and "you are not pointing at a function" are different
      // things to be told, and hiding on empty says the first when it means the
      // second.
      case "calls":
        return callsSupported(activeId());
      // A tab only while something is being debugged. Unlike Problems, the pane
      // behind it is still reachable with nothing running (the palette and the
      // SET_RIGHT_MODE event both open it), and it explains itself when it is:
      // the tab is the always-on cost this gate avoids, not the pane.
      case "debug":
        return debugRunning();
      // Bookmarks is deliberately *not* gated on having any, unlike Problems and
      // Outline above. A mark is made by clicking a gutter column that is empty
      // until you do, and this panel's empty state is the only place that says
      // so; hiding it until a mark exists would hide the instructions behind the
      // thing they explain.
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

  // Where the caret is, for the breadcrumb trail. Carries its own path so a tab
  // swap cannot leave the trail naming a symbol from the file you just left: the
  // bar reads this only while the path still matches what is on screen.
  const [caret, setCaret] = createSignal<{ path: string; line: number; column: number } | null>(null);
  function noteCaret(path: string, line: number, column: number) {
    const at = caret();
    if (at && at.path === path && at.line === line && at.column === column) return;
    setCaret({ path, line, column });
  }
  // Only while the buffer that caret belongs to is the thing on screen. The path
  // test alone is not enough: toggling a Markdown or SVG preview keeps the path
  // and takes the caret away with the source, so the trail would go on naming a
  // symbol in a rendered page where nothing is being edited.
  const caretHere = () => {
    const at = caret();
    if (!at || isImageTab() || showingPreview()) return null;
    return at.path === activeFileTab()?.path ? { line: at.line, column: at.column } : null;
  };

  /** Mark or unmark a line, from a click on the gutter. */
  function toggleMark(path: string, line: number) {
    setBookmarkStore((s) => toggleBookmark(s, ws(), path, line));
  }

  /** An edit moved the marks in an open buffer, so the store follows. The buffer
   *  is the authority for the lines it holds: its positions were mapped through
   *  the change, and the line numbers in storage were not.
   *
   *  Only for the lines it holds, though. A file can be shorter than it was when
   *  a mark was made (a checkout, a revert), and the buffer has no way to report
   *  a mark past its own end. Taking its answer as the whole truth would delete
   *  those on the next keystroke, which is a permanent loss of something a person
   *  put there by hand, so they are carried across untouched. */
  function marksMoved(path: string, marks: Bookmark[], docLines: number) {
    setBookmarkStore((s) => {
      const beyond = bookmarksFor(s, ws(), path).filter((b) => b.line > docLines);
      return setFileBookmarks(s, ws(), path, [...marks, ...beyond]);
    });
  }

  /** Set or clear a breakpoint, from a click on its gutter. */
  function toggleBreak(path: string, line: number) {
    toggleBreakpointAt(ws(), path, line);
  }

  /** An edit moved the breakpoints in an open buffer. Same contract as
   *  `marksMoved` above, including the lines past the buffer's end. */
  function breaksMoved(path: string, lines: number[], docLines: number) {
    breakpointsMoved(ws(), path, lines, docLines);
  }

  /** Name a mark from the panel, or clear the name with an empty answer. The
   *  gutter has one gesture and it is already spent on the toggle; naming is a
   *  thing you do to a list, so it lives where the list is. */
  async function labelMark(row: { path: string; line: number; label?: string }) {
    const label = await askText(`Name the bookmark at line ${row.line}`, row.label ?? "");
    if (label === null) return;
    setBookmarkStore((s) => labelBookmark(s, ws(), row.path, row.line, label));
  }

  /** Note arriving somewhere. Synthetic views are skipped: a commit-log or
   *  conflict tab is a thing you opened, not a place in the code you would want
   *  Back to take you to. */
  function recordJump(entry: JumpEntry) {
    if (isSyntheticId(entry.path)) return;
    setJumpsByWs((s) => recordIn(s, ws(), entry));
  }

  // The lines you marked, per workspace. Read once at start and written back on
  // every change, like frecency below: nothing else needs to be plumbed for it,
  // and a mark has to outlive the tab it was made in.
  const [bookmarks, setBookmarkStore] = createSignal<BookmarkStore>(loadBookmarks());
  createEffect(() => saveBookmarks(bookmarks()));
  const marksHere = () => bookmarksFor(bookmarks(), ws(), activeFileTab()?.path ?? "");
  const bookmarkList = () => bookmarkRows(bookmarks(), ws());

  // The breakpoints in the file on screen. Unlike the bookmarks above, the store
  // is not held here: `debugBreakpoints.ts` owns it, because a session
  // configuring itself asks for the whole workspace's set from outside any
  // component, and a signal that lived in this one would be unreachable from
  // there.
  const breaksHere = () => breakpointMarks(ws(), activeFileTab()?.path ?? "");

  // How much you work in each file, for the pickers' empty box. Read once at
  // start and written back on every change; the pickers read the same storage
  // when they open rather than being handed it, so nothing has to be plumbed
  // through App to two components that mount and unmount on a keystroke.
  const [frecency, setFrecency] = createSignal<FrecencyStore>(loadFrecency(Date.now()));
  createEffect(() => saveFrecency(frecency()));

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
    if (findAdapter(sel.agent ?? "claude").resume_args.length === 0) return "This agent's sessions can't be resumed";
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

  // `blameOn` is the module's signal, not a local one: the Settings row switches
  // the same preference, and a copy seeded at mount would ignore it.
  function toggleBlame() {
    writeBlamePref(!blameOn());
  }

  /** A view has no history of its own, so it has no menu to answer with, and the
   *  browser's own menu is more useful than an empty one. This is the trigger's
   *  `disabled`: Kobalte returns before `preventDefault()` when it is set, which
   *  is exactly what the old handler did by returning early. */
  const tabHasMenu = (t: FileTab) => {
    const r = root();
    return !!r && !!repoRelative(t.path, r);
  };

  function tabMenuItems(t: FileTab): MenuItem[] {
    const r = root();
    const rel = r && repoRelative(t.path, r);
    if (!r || !rel) return [];
    return [
      {
        label: "File history",
        onClick: () => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("history", r, rel) }),
      },
      {
        // Beside it, not instead of it: git's list is what was committed, this
        // one is what was saved, and the version somebody is hunting for is
        // usually in exactly the half the other one never kept.
        label: "Local history",
        onClick: () =>
          emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("localhistory", r, rel) }),
      },
    ];
  }

  /** The tab, with its right-click menu around it or without. `when` is fixed
   *  for the life of the node (a ghost never becomes a real row), so this is a
   *  plain branch rather than a `Show`. */
  function MaybeTabMenu(p: { when: boolean; tab: FileTab; children: JSX.Element }) {
    if (!p.when) return p.children;
    return (
      <ContextMenu
        class={styles.tabMenu}
        disabled={!tabHasMenu(p.tab)}
        items={tabMenuItems(p.tab)}
      >
        {p.children}
      </ContextMenu>
    );
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

  // --- Debugging -----------------------------------------------------------
  //
  // The pane and the protocol live elsewhere; what belongs here is the part
  // that needs the *selection*: which workspace this is, which file is active,
  // and what was last debugged here. F5 is a repeat of that last target, and
  // the picker is what a first press opens instead of doing nothing.
  const [debugPick, setDebugPick] = createSignal<{
    kind: TargetKind;
    scripts: string[];
    port: number;
  } | null>(null);
  const [attachPorts, setAttachPorts] = createSignal(loadAttachPorts());
  const [lastTargets, setLastTargets] = createSignal(loadLastTargets());

  /** The active tab's path, when it is a real file. A scratch buffer or a
   *  synthetic tab (a diff, a commit) has no path node could run. */
  function debugFilePath(): string | null {
    const id = activeId();
    return id && !isSyntheticId(id) ? id : null;
  }

  function debugError(message: string) {
    emitWith<ToastEvent>(TOAST, { message, kind: "error" });
  }

  /** Open the picker, having resolved the root so the scripts it offers are the
   *  ones that root actually declares. In a monorepo those are the package's
   *  own, which is the only list runnable from the `cwd` the config will use. */
  async function openDebugPicker(kind: TargetKind) {
    const ws = root();
    if (!ws) return;
    const anchor = debugFilePath() ?? ws;
    const resolved = await resolveRoot(anchor, ws);
    setDebugPick({ kind, scripts: await scriptsAt(resolved), port: attachPortFor(attachPorts(), ws) });
  }

  async function runDebugTarget(target: DebugTarget) {
    const ws = root();
    if (!ws) return;
    // Remembered before the run rather than after it: a target that fails to
    // start is still the one you meant, and having to re-pick it to retry is
    // the annoying half of the failure.
    setLastTargets((prev) => {
      const next = setLastTarget(prev, ws, target);
      saveLastTargets(next);
      return next;
    });
    if (target.kind === "attach") {
      setAttachPorts((prev) => {
        const next = setAttachPort(prev, ws, target.port);
        saveAttachPorts(next);
        return next;
      });
    }
    setRightMode("debug");
    await launchTarget(target, { projectPath: ws, onError: debugError });
  }

  function startDebugging() {
    const ws = root();
    if (!ws) return;
    const remembered = lastTargetFor(lastTargets(), ws);
    // A remembered file target whose tab is gone is not a target any more, and
    // silently launching it would be worse than asking again.
    const stale =
      remembered?.kind === "file" && !tabs().some((t) => t.path === remembered.path);
    if (remembered && !stale) {
      void runDebugTarget(remembered);
      return;
    }
    void openDebugPicker(debugFilePath() ? "file" : "script");
  }

  function stopDebugging() {
    const run = debugRoots()[0];
    if (run) void stopDebugRun(run.handle.session);
  }

  /** Stop, then run the same target again. Awaited in order rather than
   *  emitting the two events: a start issued while the previous run is still
   *  being torn down finds it live and joins it, so the restart would be a
   *  no-op that looks like one. */
  async function restartDebugging() {
    const run = debugRoots()[0];
    if (run) await stopDebugRun(run.handle.session);
    startDebugging();
  }

  // Where scratch buffers live, fetched once for the same reason the docs root
  // below is: it is a fixed directory the backend owns. The pane needs it for
  // the one place a scratch differs from any other file tab, which is that its
  // file can be taken away (closing an untouched one, promoting one with
  // Save-as). Until it arrives `isScratchPath` answers false for everything, so
  // both of those decline rather than guess.
  const [scratchDir, setScratchDir] = createSignal<string | null>(null);
  onMount(async () => {
    setScratchDir(await scratchDirPath());
  });

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
    // And Calls goes the same way when the active tab's server has no call
    // hierarchy, which switching tabs is enough to cause.
    if (rightMode() === "calls" && !callsSupported(activeId())) setRightMode("files");
  });

  // Debug is the one mode whose fallback is a *transition*, not a state. The
  // others hide a pane that has nothing to show; this pane explains itself when
  // nothing is running, which is what makes it worth opening from the palette
  // before a run exists. So it is left alone when opened empty, and only moved
  // aside when a run that was live ends underneath the reader.
  createEffect(
    on(debugRunning, (running, wasRunning) => {
      if (wasRunning && !running && rightMode() === "debug") setRightMode("files");
    }),
  );

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
      // Above the guard below, unlike the language servers. A debug run holds a
      // *debuggee*, a process the previous project's code was running, with its
      // own ports, open files and children. Deselecting the workspace is exactly
      // the case where nothing left on screen names it, so sweeping only when a
      // new project arrives would strand it with no way to stop it but quitting.
      // Statically imported, unlike the LSP client: `dapSessions` is
      // deliberately editor-free, so it costs no CodeMirror in the chunk.
      void stopAllDap();
      // And the transcript with them: what is on screen is another project's
      // program output, and the pane has no way to say whose it was.
      clearDebugConsole();
      if (!r) return;
      invoke("fs_watch_start", { projectPath: r }).catch(() => {});
      // Sweep local history for what a save can never reach: versions past the
      // age cap in files nobody has saved since, and the timelines of worktrees
      // that have been removed. Once per project open is enough for a store
      // whose caps are otherwise applied on every write.
      invoke("local_history_prune", { repoPath: r }).catch(() => {});
      // A new project means a new language server; diagnostics from the old one
      // describe files that are no longer open here, and so do its symbols.
      // The tab set changing evicts both anyway, but that is one more thing
      // than "the servers are gone" has to depend on.
      clearDiagnostics();
      clearSymbols();
      clearCallRoots();
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

  /**
   * Open a new untitled buffer (Cmd+N).
   *
   * The file is created *before* the tab, and that ordering is the whole
   * feature: a tab with a real path behind it is stored by `editorTabPersist`,
   * probed alive by the restore, stashed by hot exit and read and written by
   * CodeEditor with no special case anywhere. A synthetic `sway://scratch/…` id
   * would have needed one in each, and `toStore` drops synthetic ids on
   * purpose, so an untitled tab could never have survived a relaunch.
   *
   * It lands in whichever workspace is selected, like every other tab. With
   * none selected it goes to the transient no-selection bucket and so does not
   * persist - the same rule the rest of the strip lives under, and the file
   * itself is still there to reopen.
   *
   * Through OPEN_IN_EDITOR rather than `openFile`, so arriving in a scratch is
   * recorded the way arriving anywhere else is: it is a place Back returns to.
   */
  async function newScratch() {
    const path = await newScratchFile();
    if (!path) {
      emitWith<ToastEvent>(TOAST, {
        message: "Could not create a scratch file.",
        kind: "error",
      });
      return;
    }
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path });
  }

  /**
   * Take a scratch's backing file away, into the trash `fs_delete` uses.
   *
   * A no-op for anything else, which is what makes Save-as safe on an ordinary
   * file: that one keeps its original where it was, exactly as Save As does
   * everywhere.
   */
  async function removeScratchFile(path: string) {
    const dir = scratchDir();
    if (!isScratchPath(path, dir)) return;
    await invoke("fs_delete", { root: dir, path, noun: "scratch folder" }).catch(() => {});
  }

  /**
   * Does this file hold nothing at all?
   *
   * The *file*, deliberately, and not the buffer that was showing it. A close
   * that went through the discard confirm threw the buffer's text away without
   * touching disk, so a buffer-shaped answer would keep an empty scratch in
   * exactly the case that produces one. It is also the only answer available
   * for a tab restored from last run that nobody clicked, which has no buffer.
   *
   * A read that fails answers false, so nothing is ever deleted on a guess.
   */
  async function isEmptyOnDisk(path: string): Promise<boolean> {
    return (await invoke<string>("fs_read_file", { path }).catch(() => null)) === "";
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
    // An untitled buffer holding nothing takes its file with it. Cmd+N creates
    // one every time, so without this the scratch directory fills with empty
    // files and the numbering climbs past anything anyone has written.
    //
    // Short-circuited on the scratch test, so closing an ordinary file costs no
    // read at all and can never reach the delete below.
    const spent = isScratchPath(tab.path, scratchDir()) && (await isEmptyOnDisk(tab.path));
    if (spent) void removeScratchFile(tab.path);
    // Only real files are reopenable. A synthetic view is rebuilt from whatever
    // opened it (a commit, a conflict), so putting its id back would name a tab
    // rather than a file; and a scratch just deleted would come back as a failed
    // read of a file that is no longer there.
    if (!isSyntheticId(tab.path) && !spent) setClosedByWs((s) => rememberClosedTab(s, ws(), tab.path));
    const remaining = tabs().filter((t) => tabId(t) !== id);
    setTabs(remaining);
    setDirty((d) => {
      const next = { ...d };
      delete next[tab.path];
      return next;
    });
    // The buffer is gone, so its breakpoints stop waiting on a save that can no
    // longer come; left pending they would be left out of every future run with
    // nothing on screen saying so.
    noteBufferClosed(ws(), tab.path);
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
    noteBufferClosed(ws(), path);
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
    // A breakpoint in an unsaved buffer names a line the adapter has never seen,
    // so it waits. The clean edge is the moment it can be armed, and it arrives
    // after the on-save pipeline has finished moving lines around.
    noteBufferDirty(ws(), path, isDirty);
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
    setBookmarkStore((s) => mapBookmarkPaths(s, (p) => (isUnderPath(p, path) ? null : p)));
    // Ahead of the tab sweep for the bookmarks' reason and one of its own: a
    // breakpoint on a trashed file has no gutter left to click, so nothing could
    // ever remove it and it would go out in every future run's `setBreakpoints`.
    mapBreakpointFiles((p) => (isUnderPath(p, path) ? null : p));
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
    setBookmarkStore((s) => mapBookmarkPaths(s, (p) => repoint(p, from, to) ?? p));
    mapBreakpointFiles((p) => repoint(p, from, to) ?? p);
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

  /**
   * Write the active buffer somewhere new and take the tab with it.
   *
   * Built as **a rename with a write in front of it**. Once the bytes are on
   * disk, `FILE_RENAMED` is the event Phase 1 already gave the tab strip,
   * CodeEditor's buffer map (so the undo history comes along), the jump list,
   * the bookmarks and the reopen stack, so every one of them follows the file
   * without being told about scratch buffers at all.
   *
   * The order is the safety: write, then repoint, then remove the old file. A
   * failed write leaves the untitled buffer exactly where it was, and a scratch
   * whose file is gone before the new one exists is the one sequence that could
   * lose the text.
   */
  async function saveAsFromPrompt() {
    const from = activeFileTab()?.path;
    if (!from) return;
    // The pane does not own the text. `null` is "no buffer holds this path",
    // which is nothing to write rather than an empty file to write.
    const text = liveBufferText(from);
    if (text === null) return;
    const answer = await askText("Save as", defaultSaveName(from));
    // A cancelled prompt is owed no explanation; an answer that named no file
    // is, or the box just closes and nothing appears anywhere.
    if (answer === null) return;
    const to = resolveSavePath(answer, root());
    if (!to) {
      emitWith<ToastEvent>(TOAST, {
        message: root()
          ? `"${answer.trim()}" does not name a file.`
          : "Select a workspace first, or type a path starting with /.",
        kind: "error",
      });
      return;
    }
    // Saving a file onto itself, which is the ordinary save and not this one.
    if (to === from) return;
    if (await invoke<boolean>("file_exists", { path: to }).catch(() => false)) {
      const ok = await askConfirm({
        title: `${basename(to)} already exists.`,
        message: "Saving here replaces what is in it.",
        confirmLabel: "Replace",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await invoke("fs_write_file", { path: to, contents: text });
    } catch (e) {
      emitWith<ToastEvent>(TOAST, {
        message: `Could not save ${basename(to)}: ${String(e)}`,
        kind: "error",
      });
      return;
    }
    // Our own write, so follow mode and the diff gutter do not treat it as
    // somebody else editing the file.
    markSelfWrite(to);
    emitWith<FileRenamed>(FILE_RENAMED, { from, to });
    // The buffer that just moved holds exactly what the file now holds, so it
    // takes that as its baseline too. Without this the promoted tab reads dirty
    // against a file it agrees with, and the next save would be a no-op nobody
    // could explain.
    adoptBufferText(to, text);
    // Whatever the last quit stashed under the old path describes a file that
    // is about to stop existing.
    dropStashEntry(from);
    void removeScratchFile(from);
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
      onEvent(EDITOR_NEW_SCRATCH, () => void newScratch()),
      onEvent(EDITOR_SAVE_AS, () => void saveAsFromPrompt()),
      onEvent(EDITOR_NAV_BACK, () => goJump(-1)),
      onEvent(EDITOR_NAV_FORWARD, () => goJump(1)),
      onEvent(DEBUG_START, startDebugging),
      onEvent(DEBUG_STOP, stopDebugging),
      onEvent(DEBUG_RESTART, () => void restartDebugging()),
      onWith<DebugPick>(DEBUG_PICK, (d) => {
        if (d?.kind) void openDebugPicker(d.kind);
      }),
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

  // Phase 4: the file kind registers its descriptor here, closing over this
  // panel's dirty/touched state and close; the strip below renders through the
  // registry with no per-kind switches of its own.
  const asFile = (u: UnifiedTab) => (u as FileUnifiedTab).file;
  const fileDots = (u: UnifiedTab) => {
    const t = asFile(u);
    return (
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
    );
  };
  registerKind("file", {
    icon: (u) => tabIcon(asFile(u)),
    title: (u) => asFile(u).name,
    tooltip: (u) => tabTitle(asFile(u)),
    dots: fileDots,
    // A synthetic view has no path to hand anyone: dropping its id on a
    // terminal would paste `sway://…`, which names nothing on disk.
    draggable: (u) => !isSyntheticId(asFile(u).path),
    onDragStart: (u, e) => {
      const t = asFile(u);
      e.dataTransfer?.setData(DRAG_PATH_MIME, t.path);
      e.dataTransfer?.setData("text/plain", t.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    },
    // The menu wraps the tab instead of being the tab: `Tab` composes
    // `Tooltip`, which already renders *as* the button, and two wrappers
    // cannot own one element. The registry skips this wrap for the measuring
    // ghost row, which is measured, never reached.
    wrapTab: (u, tab) => (
      <MaybeTabMenu when tab={asFile(u)}>
        {tab}
      </MaybeTabMenu>
    ),
    renderMenuItem: (u) => {
      const t = asFile(u);
      return (
        <>
          {tabIcon(t)}
          <span class="tab-name">{t.name}</span>
          {fileDots(u)}
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
      );
    },
    activate: (u) => setActiveId(u.id),
    close: (u) => void closeTab(u.id),
  });
  // The strip consumes the unified model filtered to this panel's kind: same
  // tabs, same order, same references, read through the union.
  const stripTabs = (): FileUnifiedTab[] =>
    unifiedTabs().filter((u): u is FileUnifiedTab => u.kind === "file" && u.workspace === ws());

  return (
    <div class={styles.editorPane} ref={paneEl}>
      <div class={styles.editorMain}>
        <OverflowTabBar
          class={styles.editorTabs}
          items={stripTabs()}
          activeId={activeId()}
          idOf={idOf}
          onActivate={(id) => {
            const u = stripTabs().find((t) => t.id === id);
            if (u) kindEntry(u.kind).activate(u);
          }}
          onReorder={(next) => setTabs(next.map((u) => u.file))}
          renderTab={renderRegistryTab}
          renderMenuItem={(t) => kindEntry(t.kind).renderMenuItem(t)}
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
                tooltip="Go back to where you were (⌃−)"
              />
              <IconButton
                icon={<Icon icon={ArrowRight} />}
                disabled={!canGoForward(jumps())}
                onClick={() => goJump(1)}
                tooltip="Go forward again (⌃⇧−)"
              />
              <Show when={isPreviewableTab()}>
                <IconButton
                  active={showingPreview()}
                  icon={
                    <Icon icon={showingPreview() ? FileCodeCorner : isSvgTab() ? FileHeart : FileTypeCorner} />
                  }
                  onClick={togglePreview}
                  tooltip={
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
                  tooltip={
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
                tooltip={
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
        {/* Where the open file sits and where the caret sits in it. Below the
            tabs and above everything else in the column: a tab says which file,
            and this says the rest of the answer. Only for a real file - a commit
            log or a conflict view has a `sway://` id, which names no folder any
            picker could list. */}
        <Breadcrumbs root={root()} path={activeFileTab()?.path ?? null} caret={caretHere()} />
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
              tooltipWhenDisabled
              tooltip={sendDisabledReason() ?? "Ask the selected session to resolve this conflict"}
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
              callsVisible={rightMode() === "calls"}
              goto={gotoTarget()}
              onDirty={handleDirty}
              onCursorJump={(path, line) => recordJump({ path, line })}
              onCaretMove={noteCaret}
              bookmarks={marksHere()}
              onToggleBookmark={toggleMark}
              onBookmarksMoved={marksMoved}
              breakpoints={breaksHere()}
              onToggleBreakpoint={toggleBreak}
              onBreakpointsMoved={breaksMoved}
              frameLine={frameLocation()}
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
                {/* The other half of the same question: git's list is what was
                    committed, this one is what was saved. */}
                <Show when={t().kind === "localhistory"}>
                  <LocalHistory workspace={t().workspace} file={t().arg} />
                </Show>
                <Show when={t().kind === "commit"}>
                  <CommitDetail workspace={t().workspace} sha={t().arg} />
                </Show>
                {/* Its own CodeMirror instance, not a buffer in CodeEditor:
                    this document has no file behind it and lives under rules no
                    file buffer has (its line count is fixed, and only a result's
                    own text is editable). */}
                <Show when={t().kind === "search"}>
                  <Suspense fallback={<div class={styles.editorEmpty}>Loading editor…</div>}>
                    <SearchResultsBuffer id={activeId()!} />
                  </Suspense>
                </Show>
                {/* Code with no file behind it, fetched from the adapter by
                    reference. Read-only by construction: there is nothing to
                    save it to. */}
                <Show when={t().kind === "dapsource"}>
                  <DebugSourceView id={activeId()!} name={syntheticTabName(activeId()!)} />
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
          min={px(RIGHT_W_MIN)}
          max={rightMax()}
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
              value={t.mode}
              icon={<Icon icon={t.icon} />}
              tooltip={t.label}
              // The one `aria-label` on a tooltipped `Tab` in the app. A label
              // normally *replaces* a tab's visible text as its name, which is
              // why the guard forbids it - but this tab is icon-only, so the
              // label is the only name it has.
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
          <Match when={rightMode() === "calls"}>
            <CallsPanel path={activeId()} />
          </Match>
          <Match when={rightMode() === "bookmarks"}>
            <BookmarksPanel
              rows={bookmarkList()}
              root={root()}
              onLabel={labelMark}
              onRemove={(row) => toggleMark(row.path, row.line)}
            />
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
          <Match when={rightMode() === "todos"}>
            <TodoPanel root={root()} selected={props.selected} />
          </Match>
          <Match when={rightMode() === "tasks"}>
            <TasksPanel root={root()} />
          </Match>
          <Match when={rightMode() === "debug"}>
            <DebugPanel root={root()} selected={props.selected} />
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
      <Show when={debugPick()}>
        {(pick) => (
          <DebugTargetDialog
            kind={pick().kind}
            filePath={debugFilePath()}
            scripts={pick().scripts}
            port={pick().port}
            onConfirm={(target) => {
              setDebugPick(null);
              void runDebugTarget(target);
            }}
            onCancel={() => setDebugPick(null)}
          />
        )}
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
