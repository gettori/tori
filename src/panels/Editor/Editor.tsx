import { For, createSignal, createEffect, createMemo, on, onCleanup, onMount, lazy, untrack, Match, Show, Suspense, Switch, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
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
// The PDF viewer sits behind an edge of its own, and pdf.js behind a second one
// inside it (`pdfjsRuntime`). `pdfDocument` stays on the eager path - the tab
// predicate and the release sweep are needed whether or not the view is
// mounted - and is deliberately free of any pdf.js *value* import.
const PdfView = lazy(() => import("./PdfView"));
import FileTree from "./FileTree/FileTree";
import FilesPanel from "./FilesPanel/FilesPanel";
import PromptModal from "../../components/Dialogs/PromptModal";
import PickerModal from "../../components/Dialogs/PickerModal";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import ReviewPanel from "./ReviewPanel";
import PullRequests from "./PullRequests/PullRequests";
import ProblemsPanel from "./ProblemsPanel";
import CallsPanel from "./CallsPanel";
import Breadcrumbs from "./Breadcrumbs";
// The bar's own stylesheet: these two controls belong to it, not to the editor.
import crumbStyles from "./Breadcrumbs.module.css";
import { diagnostics } from "../../utils/diagnostics";
import { traceSettle } from "../../utils/perfTrace";
import { isMarkdownPath } from "../../utils/liveBuffer";
import { chromeScale, editorDefaults, loadWorkspaceSettings } from "../Settings/settingsStore";
import { toggledWrap, withoutTab, type WrapOverrides } from "./softWrapTabs";
import { clearSymbols } from "../../utils/symbols";
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
import DebugPanel from "./DebugPanel";
import SessionPanel from "./SessionPanel";
import MarkdownPreview from "./MarkdownPreview";
import CommitLog from "./CommitLog";
import LocalHistory from "./LocalHistory";
import CommitDetail from "./CommitDetail";
import ConflictView from "./ConflictView";
import DiffView from "./DiffView";
import GraphView from "./GraphView";
import DebugSourceView from "./DebugSourceView";
import ImageView, { isImagePath } from "./ImageView";
import PdfToolbar from "./PdfToolbar";
import { isPdfPath, releasePdfsExcept } from "./pdfDocument";
import OverflowTabBar from "../../components/OverflowTabBar";
import Resizer from "../../components/Resizer/Resizer";
import IconButton from "../../components/IconButton/IconButton";
import Button from "../../components/Button/Button";
import ContextMenu from "../../components/Menu/ContextMenu";
import { type MenuItem } from "../../components/Menu/rows";
import Tab from "../../components/Tab/Tab";
import { TabMemberChip } from "../../components/MemberChip/MemberChip";
import MemberChipRow from "../../components/MemberChipRow/MemberChipRow";
import FileIcon from "../../seti/FileIcon";
import Icon from "../../components/Icon/Icon";
import {
  X,
  ArrowLeft,
  ArrowRight,
  FileCodeCorner,
  FileTypeCorner,
  FileHeart,
  Files,
  GitCompare,
  GitGraph,
  GitPullRequest,
  TriangleAlert,
  Bug,
  // A call graph, not a telephone: `PhoneCall` reads as telephony.
  Network,
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
  PURGE_WORKSPACE,
  type PurgeWorkspace,
  DRAG_PATH_MIME,
  FOCUS_PROJECT_SEARCH,
  SET_RIGHT_MODE,
  SEARCH_IN_FOLDER,
  SPLIT_PANE,
  DEBUG_START,
  DEBUG_STOP,
  DEBUG_TOGGLE_BREAKPOINT,
  DEBUG_RESTART,
  DEBUG_PICK,
  type DebugPick,
  FILE_RENAMED,
  CLOSE_TAB,
  TAB_JUMP,
  TAB_CYCLE,
  type TabJump,
  EDITOR_CLOSE_TAB,
  EDITOR_CLOSE_PATH,
  EDITOR_TAB_CLOSED,
  type EditorClosePath,
  type EditorTabClosed,
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
  GIT_FETCH,
  GIT_PULL,
  GIT_PULL_REBASE,
  GIT_SYNC,
  GIT_STAGE_ALL,
  GIT_UNSTAGE_ALL,
  GIT_DISCARD_ALL,
  GIT_COMMIT_SIGNOFF,
  GIT_UNDO_COMMIT,
  GIT_STASH_STAGED,
  GIT_MERGE_BRANCH,
  GIT_REBASE_BRANCH,
  GIT_ABORT,
  GIT_BRANCH_CREATE,
  GIT_BRANCH_RENAME,
  GIT_BRANCH_DELETE,
  TOAST,
  type ToastEvent,
  type OpenInEditor,
  type PurgeUnderPath,
  type LiveTab,
  type SetRightMode,
  type SearchInFolder,
  type SplitPane,
  type FileRenamed,
  type FsChanged,
} from "../../utils/events";
import { isUnderPath, mentionPath } from "../../utils/pathScope";
import { rootOf, selectionRoot, workspaceKey } from "../../utils/features";
import {
  createFeatureMembers,
  focusMemberRoot,
  memberFor,
  type MemberRoot,
  type TintedMember,
} from "../../utils/featureMembers";
import { revealSection } from "../../utils/filesSections";
import { dropWorkspaceKey } from "../../utils/purgeWorkspace";
import { dropWorkspaceBreakpoints } from "../../utils/debugBreakpoints";
import { dropWorkspaceExpanded, mapExpandedFiles } from "../../utils/treeExpanded";
import { dropWorkspaceWatches } from "../../utils/debugWatch";
import { blameOn, writeBlamePref } from "../../utils/blamePref";
import { followEdits } from "../../utils/followPref";
import { loadTabs, saveTabs, toStore, mergeStore, restoreFor } from "../../utils/editorTabPersist";
import { dropStashEntry, loadPendingStash, pendingStashPaths, requestStash } from "../../utils/hotExit";
import { closeAllowed } from "../../utils/closeGuard";
import { mayRewrite } from "../../utils/gitGuard";
import { flushDeferredWrites } from "../../utils/deferredWrite";
import {
  refreshGit,
  startGitWatch,
  enterRoots,
  setActiveRoot,
  gitStateFor,
  isConflicted,
  stagedFiles,
  stage as stageFiles,
  unstage as unstageFiles,
  commit as commitStaged,
  push as pushToOrigin,
  changedFiles,
  refreshStatus,
  stageAll,
  unstageAll,
  fetchIn,
  pull as pullIn,
  merge,
  rebase,
  abortIntegrate,
  undoLastCommit,
  createBranch,
  renameBranch,
  deleteBranch,
  stashStaged,
  branchNames,
} from "../../utils/gitActions";
import { publishEditorState, clearEditorState } from "../../utils/editorState";
import { purgeTabsUnder } from "./purgeTabs";
import { searchBufferRoots, searchTabTitle } from "./searchResultsStore";
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
import { sendBlockedReason } from "../../utils/sendTarget";
import { composeSelectionMention, requestSend, type SessionTarget } from "../../utils/safeSend";
import { selectionBlocks } from "../../utils/chatCompose";
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
import { noteTabFocus, kindPaneFocused } from "../../layout/layoutStore";
import { nextActiveAfterClose } from "../../layout/paneLayout";
import { unifiedTabs, type FileUnifiedTab, type UnifiedTab } from "../../tabs/unifiedTabs";
import { registerKind } from "../../tabs/registry";
import { isKindHome, kindHomePane, paneActiveId, paneTabs, panesWithKind } from "../../tabs/paneTabs";
import { focusedPaneId } from "../../layout/layoutStore";
import { paneMenuItems } from "../../tabs/paneTabs";
import { forgetTab, setPaneActive } from "../../layout/tabPlacement";
import { editorStageId, stageHost } from "../../tabs/stageHost";
import styles from "./Editor.module.css";
import patterns from "../../styles/patterns.module.css";

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
  | "calls"
  | "shared"
  | "docs"
  | "session"
  | "search"
  | "debug";
type ModeTab = { mode: RightMode; label: string; icon: LucideIcon };
/** The modes that answer for the member `activeRoot` points at, rather than for
 *  the whole Feature (Changes, Search, Problems) or for the file in front
 *  (Calls, Session, Debug). These are the three the chip row switches;
 *  Files and Search draw member chips of their own. */
const ACTIVE_ROOT_MODES: RightMode[] = ["pulls", "shared", "docs"];

const RIGHT_MODE_TABS: Record<RightMode, ModeTab> = {
  files: { mode: "files", label: "Files", icon: Files },
  changes: { mode: "changes", label: "Changes", icon: GitCompare },
  pulls: { mode: "pulls", label: "Pull requests", icon: GitPullRequest },
  problems: { mode: "problems", label: "Problems", icon: TriangleAlert },
  calls: { mode: "calls", label: "Calls", icon: Network },
  search: { mode: "search", label: "Search", icon: Search },
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
const SYNTHETIC_ICONS: Record<string, LucideIcon> = {
  search: Search,
  graph: GitGraph,
  diff: GitCompare,
};

function tabIcon(t: FileTab) {
  if (!isSyntheticId(t.path)) return <FileIcon name={t.name} />;
  const kind = parseSyntheticId(t.path)?.kind ?? "";
  // History is the fallback because most of these views are one: the log, a
  // commit, a file's history, a conflict's three sides.
  return <Icon icon={SYNTHETIC_ICONS[kind] ?? History} />;
}

const tabName = (t: FileTab) => searchTabTitle(t.path) ?? t.name;

// A file tab's tooltip is its path. A view's is the workspace it belongs to,
// which is the one thing its label cannot say and the only thing telling two
// branch-units' log tabs apart. A results buffer answers with the folders it
// writes into instead: its `ws=` field is a workspace *key*, and inside a
// Feature that is `feature:<id>`, which names nothing a reader knows.
function tabTitle(t: FileTab): string {
  const roots = searchBufferRoots(t.path);
  if (roots?.length) return roots.join("\n");
  return parseSyntheticId(t.path)?.workspace ?? t.path;
}

const LS_RIGHT_W = "sway.editor.rightw.v1";
// Floors in design px at `--ui-scale` 1, scaled with it like the app's outer
// panes. The right panel has no maximum: it grows until the code side would drop
// below its own floor, so a wide editor can be almost all file tree.
const RIGHT_W_MIN = 160;
const CODE_MIN = 320;

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
  /** Move the Feature's active member, from the right panel's own chip row. The
   *  same handler the Toolbar's crumb chips and the sidebar use, so the three
   *  cannot disagree about which member is in front. */
  onActiveRoot?: (root: string) => void;
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
  // The store key, not the folder: a Feature is one workspace over several
  // member folders, so its tabs live under `feature:<id>` while `root()` moves.
  const ws = () => workspaceKey(props.selected);
  const tabs = () => tabsByWs()[ws()] ?? [];
  // One report for every way a tab can go (close, force close, purge), taken
  // from the union across workspaces: a switch only hides tabs and reports none.
  createEffect(
    on(
      tabsByWs,
      (now, prev) => {
        if (!prev) return;
        const paths = (byWs: typeof now) => new Set(Object.values(byWs).flatMap((ts) => ts.map((t) => t.path)));
        const open = paths(now);
        for (const path of paths(prev)) {
          if (!open.has(path)) emitWith<EditorTabClosed>(EDITOR_TAB_CLOSED, { path });
        }
      },
      { defer: true },
    ),
  );
  // ---- Panes (plan phase 9) ----------------------------------------------
  // A column per pane holding file tabs; with no pane tree (a panel mounted
  // outside the shell, which is every panel-only suite) there is one, in the
  // stage host the editor has always used.
  const SOLO_PANE = "editor-stage";
  const editorPaneIds = () => {
    const panes = panesWithKind(ws(), "file");
    if (panes.length) return panes;
    // No file tabs anywhere: the column still belongs in the pane files open
    // into, which is where "open a file from the tree" has to be readable.
    return [kindHomePane(ws(), "file") ?? SOLO_PANE];
  };
  const focusedEditorPane = () => {
    const panes = editorPaneIds();
    const focused = focusedPaneId(ws());
    return focused && panes.includes(focused) ? focused : panes[0];
  };
  /** The file tab a pane shows, or null while it is showing something else. */
  const paneFileId = (paneId: string): string | null => {
    const shown = paneId === SOLO_PANE ? (activeByWs()[ws()] ?? null) : paneActiveId(ws(), paneId);
    // Only a tab that is actually open: the workspace's stored pick outlives
    // the tab it names (closing the last one leaves it behind), and a column
    // asking for it would draw an editor over a file nobody has open.
    return shown && tabs().some((t) => tabId(t) === shown) ? shown : null;
  };
  // The file everything outside the columns means (plan phase 9 task 5): the
  // focused pane's, so the git store, the breadcrumb and every command's
  // enablement follow pane focus rather than one workspace-wide pick.
  const activeId = () => paneFileId(focusedEditorPane()) ?? activeByWs()[ws()] ?? null;
  /**
   * The file actually **on screen**, or null when the pane is showing something
   * else - a chat, a terminal.
   *
   * `activeId` deliberately falls back to the workspace's last file pick so a
   * command still has a target, and that fallback is right for a command and
   * wrong for anything that draws. A tree row highlighted as "the open file"
   * while a chat fills the pane is pointing at something the user cannot see.
   */
  const shownFileId = () => paneFileId(focusedEditorPane());
  function setTabs(next: FileTab[] | ((prev: FileTab[]) => FileTab[])) {
    const key = ws();
    setTabsByWs((prev) => ({
      ...prev,
      [key]: typeof next === "function" ? next(prev[key] ?? []) : next,
    }));
  }
  function setActiveId(id: string | null) {
    if (id) noteTabFocus(id);
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
  // The chrome portals out (phase 7), so the region is measured as editorMain
  // plus the panel's drawn width AT MEASURE TIME (untracked): reading it reactively here
  // would make the clamp below chase its own writes between observer ticks.
  //
  // The observed element is re-picked reactively: a worktree switch can remount
  // the columns (its envelope names different panes), and an observer bound
  // once at mount would keep watching the detached element - whose only further
  // report is width 0, which pins the panel to its floor with min == max.
  const [colEls, setColEls] = createSignal<Record<string, HTMLElement>>({});
  const holdCol = (paneId: string, el: HTMLElement) => {
    setColEls((prev) => ({ ...prev, [paneId]: el }));
    onCleanup(() =>
      setColEls((prev) => {
        const next = { ...prev };
        if (next[paneId] === el) delete next[paneId];
        return next;
      }),
    );
  };
  const [paneW, setPaneW] = createSignal(0);
  createEffect(() => {
    const el = colEls()[focusedEditorPane()];
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      // display:none and detached both report 0. Zero is never a real width for
      // a focused column, so keep the last honest measurement instead of
      // collapsing the bound below to its floor.
      if (entry.contentRect.width > 0) setPaneW(entry.contentRect.width + untrack(rightWidth));
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  // Unbounded until the pane has been measured, so a drag can never be pinned to
  // the floor by a width nothing has reported yet.
  const rightMax = () =>
    paneW() <= 0 ? Infinity : Math.max(px(RIGHT_W_MIN), paneW() - px(CODE_MIN));
  // What the panel renders at. Clamped here rather than written back into the
  // stored width, so a narrowed editor pane or a raised UI scale squeezes it for
  // now and widening the pane again restores the width the user picked.
  const rightWidth = () => Math.min(Math.max(rightW(), px(RIGHT_W_MIN)), rightMax());
  // The mode strip runs through the shared OverflowTabBar, so it collapses into
  // a +N menu on a narrow pane instead of squeezing every label. The bar can
  // reorder tabs when one is picked out of the overflow menu, so the canonical
  // order lives in a signal; availability (session/shared/docs) still filters it
  // on every render.
  const [modeOrder, setModeOrder] = createSignal<RightMode[]>([
    "files",
    "search",
    "changes",
    "pulls",
    "problems",
    "calls",
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
        return problemsHere();
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
      default:
        return true;
    }
  }
  const rightTabs = () => modeOrder().filter(modeAvailable).map((m) => RIGHT_MODE_TABS[m]);
  // This workspace's problems. The store now spans every warm project (the
  // servers stay up across a switch), so what the tab and the panel show has to
  // be scoped here, or one worktree's errors would badge another's tree. Inside
  // a Feature the scope is every member, not the active one: hiding the tab
  // because the repo you happen to be looking at is clean would hide the
  // section that is not.
  const problemsHere = () => {
    const rs = treeRoots()?.map((r) => r.path) ?? (root() != null ? [root()!] : []);
    return rs.length > 0 && Object.keys(diagnostics()).some((p) => rs.some((r) => isUnderPath(p, r)));
  };
  const [searchFocusNonce, setSearchFocusNonce] = createSignal(0);
  // Find in Folder's narrowing, held until the Search panel has applied it.
  const [searchScope, setSearchScope] = createSignal<(SearchInFolder & { nonce: number }) | null>(null);
  let searchScopeNonce = 0;
  // Source-vs-render preview toggle, per tab id (so switching tabs remembers
  // each previewable file's own choice: .md renders to HTML, .svg to its image).
  const [previewOn, setPreviewOn] = createSignal<Set<string>>(new Set());
  // Per-tab soft-wrap overrides; the rule itself lives in `softWrapTabs.ts`.
  const [wrapById, setWrapById] = createSignal<WrapOverrides>({});
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

  /** Set or clear a breakpoint, from a click on its gutter. */
  function toggleBreak(path: string, line: number) {
    toggleBreakpointAt(ws(), path, line);
  }

  /** An edit moved the breakpoints in an open buffer. The buffer is the
   *  authority for the lines it holds; ones past its end (a file shortened by a
   *  checkout) are carried across, since it cannot report them. */
  function breaksMoved(path: string, lines: number[], docLines: number) {
    breakpointsMoved(ws(), path, lines, docLines);
  }

  /** Note arriving somewhere. Synthetic views are skipped: a commit-log or
   *  conflict tab is a thing you opened, not a place in the code you would want
   *  Back to take you to. */
  function recordJump(entry: JumpEntry) {
    if (isSyntheticId(entry.path)) return;
    setJumpsByWs((s) => recordIn(s, ws(), entry));
  }

  // The breakpoints in the file on screen. The store is not held here: `debugBreakpoints.ts` owns it, because a session
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
  // Per pane (plan phase 9): the same questions asked of whatever tab a given
  // pane shows. The zero-argument forms below ask them of the focused pane,
  // which is what every consumer outside the columns still means.
  const tabOf = (id: string | null) => tabs().find((t) => tabId(t) === id) ?? null;
  const fileTabOf = (id: string | null) => {
    const t = tabOf(id);
    return t && !isSyntheticId(t.path) ? t : null;
  };
  const imageOf = (id: string | null) => {
    const t = fileTabOf(id);
    return t != null && isImagePath(t.path);
  };
  const pdfOf = (id: string | null) => {
    const t = fileTabOf(id);
    return t != null && isPdfPath(t.path);
  };
  const svgOf = (id: string | null) => {
    const t = fileTabOf(id);
    return t != null && t.path.toLowerCase().endsWith(".svg");
  };
  const markdownOf = (id: string | null) => {
    const t = fileTabOf(id);
    return t != null && isMarkdownPath(t.path);
  };
  const syntheticOf = (id: string | null) => {
    const t = tabOf(id);
    return t ? parseSyntheticId(t.path) : null;
  };
  const previewingOf = (id: string | null) =>
    (markdownOf(id) || svgOf(id)) && previewOn().has(id ?? "");
  /** What a pane's own CodeMirror view should hold: nothing at all unless the
   *  tab it shows is a file being edited rather than rendered. */
  const editablePathOf = (id: string | null) =>
    tabOf(id) && !imageOf(id) && !pdfOf(id) && !previewingOf(id) && !syntheticOf(id) ? id : null;

  // Parsed PDFs are released the same way CodeEditor evicts buffers: off the
  // open-tab set, not off `PdfView`'s cleanup. A tab switch unmounts the view
  // while the tab, and the page the reader was on, are still there - so a
  // mount-scoped release would re-parse the file on every switch back. This one
  // effect covers every way a tab goes away (close, purge, workspace delete).
  createEffect(on(allOpenPaths, (paths) => releasePdfsExcept(paths)));

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
  // Tabs that carry a source-vs-render toggle: Markdown renders to HTML, SVG
  // renders to its image. Everything else edits in place with no toggle.
  const isPreviewableTab = () => isMarkdownTab() || isSvgTab();
  const showingPreview = () => isPreviewableTab() && previewOn().has(activeId() ?? "");
  function togglePreviewOf(id: string) {
    setPreviewOn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // The command's form: whatever the focused pane is showing.
  function togglePreview() {
    const id = activeId();
    if (id) togglePreviewOf(id);
  }
  function toggleSoftWrap() {
    const id = activeId();
    if (!id || isSyntheticId(id)) return;
    setWrapById((prev) => toggledWrap(prev, id, editorDefaults().softWrap));
  }

  // The session/branch-unit working folder is the anchor for the editor, file
  // tree, gutter, review surface, fs watcher, and LSP, not the project container.
  // For a Feature it is the active member, and null (never "") with none present.
  const root = () => selectionRoot(props.selected);

  // Inside a Feature the file tree draws one section per member, unusable ones
  // included, so a member with no worktree has somewhere to say so and a Retry
  // to offer. A branch unit reads no Feature record at all.
  const featureId = () => (props.selected?.kind === "feature" ? (props.selected.featureId ?? null) : null);
  const members = createFeatureMembers(featureId);

  // Which member a tab's file sits in, for the surfaces that have to name the
  // repo. Null outside a Feature, and for a synthetic view, which belongs to
  // the workspace rather than to any one repo in it.
  const tabMember = (path: string | null): TintedMember | null =>
    path && featureId() && !isSyntheticId(path) ? memberFor(path, members()) : null;

  // The repo the surfaces that follow the *file* ask for: Debug launches in it,
  // Session reports it, and the header line above those panes names it. Not
  // `root()`, which is the member you last clicked in the tree, and not the
  // whole member set either: a debuggee runs in one repo.
  const focusRoot = () => focusMemberRoot(activeId(), members(), root());
  const focusMember = () => (featureId() ? memberFor(focusRoot(), members()) : null);

  /** The member the workspace is pointed at, for the panes that follow
   *  `activeRoot` rather than the file in front: Pull requests, Tasks, Shared
   *  and Docs. Null outside a Feature, where there is only one repo anyway. */
  const activeMember = () => (featureId() ? memberFor(root(), members()) : null);
  /** Which repo the pane below is about. Only inside a Feature: with one repo
   *  on screen there is nothing to disambiguate, and Outline, Calls, Session and
   *  Debug all otherwise read as answers about the whole workspace. */
  const focusMemberLine = () => (
    <Show when={focusMember()}>
      {(m) => (
        <div class={styles.focusMember} data-focus-member={m().member.repoPath}>
          <TabMemberChip member={m()} />
          <span class={styles.focusMemberName}>{m().label}</span>
        </div>
      )}
    </Show>
  );

  /** What a Search Editor tab greps: every member, or the one root. */
  const searchRootsHere = (): MemberRoot[] => {
    const r = root();
    return treeRoots() ?? (r ? [{ path: r, repoPath: r, label: "" }] : []);
  };

  const treeRoots = (): MemberRoot[] | undefined =>
    featureId()
      ? members().map((m) => ({
          path: m.key,
          repoPath: m.member.repoPath,
          label: m.label,
          tint: m.hue,
          state: m.state,
        }))
      : undefined;

  // The tree hands back the section key, which is the worktree when there is one
  // and the repo folder otherwise; the backend wants the repo either way.
  //
  // Routed by `memberState().action`, the same value the button's own label is
  // drawn from. Running `retry_member` for all three made a button reading
  // "Locate" call a command that cannot read the repo it is about to fail on,
  // and land the member on `Failed` until the next read reconciled it back.
  async function repairMember(key: string) {
    const id = featureId();
    const m = members().find((tm) => tm.key === key);
    if (!id || !m || !m.state.action) return;
    try {
      if (m.state.action === "locate") {
        const newRepoPath = await invoke<string | null>("pick_folder");
        // A cancelled picker leaves the record exactly as it was.
        if (!newRepoPath) return;
        await invoke("relocate_member", { featureId: id, repoPath: m.member.repoPath, newRepoPath });
        return;
      }
      await invoke("retry_member", { featureId: id, repoPath: m.member.repoPath });
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: `${m.label}: ${String(e)}`, kind: "error" });
    }
  }

  // The open file is mid-conflict. Read from the shared git store rather than
  // probed per file: the store is already refreshed by every watcher burst and
  // every git action, so the banner appears and clears on the same beat as the
  // Changes panel's Conflicts section, with no second source of truth.

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
      profile: sel.profile,
      folderPath: sel.folderPath,
      sessionCwd: sel.sessionCwd,
      sessionPath: sel.sessionPath,
      sessionTitle: sel.sessionTitle,
      sessionFile: sel.sessionFile,
    };
  }

  // The shared gate rather than a fourth copy of it: it already asks the two
  // questions this asked, plus whether the agent is one this install offers.
  const sendDisabledReason = () => sendBlockedReason(props.selected ?? null);

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

  /**
   * Selected words from a PDF, on their way to the selected session as a page
   * reference plus a chip carrying the text.
   *
   * Here rather than in `PdfView` because the view knows the pages and nothing
   * about sessions, and the same gate the Problems and Conflicts surfaces ask
   * has to answer for this one too. `line` means page throughout: the chips and
   * the jump list already speak in lines, and the two transports spell out
   * "page" for a `.pdf` on the wire, where the agent would read `#L3` as a line.
   */
  async function quoteFromPdf(path: string, text: string, firstPage: number, lastPage: number) {
    const reason = sendDisabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return;
    }
    const t = sendTarget();
    if (!t) return;
    const result = await requestSend({
      ...t,
      text: composeSelectionMention(t, path, firstPage, lastPage),
      blocks: selectionBlocks(path, firstPage, lastPage, text),
    });
    if (result.kind === "blocked") {
      emitWith<ToastEvent>(TOAST, { message: "That session is waiting on a prompt, answer it first.", kind: "error" });
    } else if (result.kind === "timeout") {
      emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
    }
  }

  // `blameOn` is the module's signal, not a local one: the Settings row switches
  // the same preference, and a copy seeded at mount would ignore it.
  function toggleBlame() {
    writeBlamePref(!blameOn());
  }


  function tabMenuItems(t: FileTab): MenuItem[] {
    const panes = paneMenuItems(ws(), { id: tabId(t), kind: "file" });
    const r = root();
    const rel = r && repoRelative(t.path, r);
    if (!r || !rel) return panes;
    return [
      ...panes,
      { separator: true },
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
        disabled={tabMenuItems(p.tab).length === 0}
        items={tabMenuItems(p.tab)}
      >
        {p.children}
      </ContextMenu>
    );
  }

  // The editable `.shared/` folder lives on the worktree container; only a
  // worktree layout has one. Null for plain / plain-dir gates the tab.
  //
  // Inside a Feature the question is per member, and it is asked of the *repo*,
  // not of the Feature: `projectKind` is "feature" there, which is why this tab
  // was hidden outright before. A member's `repoPath` is its project path from
  // discovery, so it is already the container, and `kind` says whether that
  // container is a bare one (`create_worktree` links `.shared/` into each
  // worktree) or a plain repo (whose Feature worktrees sit under
  // `.sway/worktrees`, where no such folder is linked).
  const sharedPath = () => {
    const m = activeMember();
    if (m) return m.kind === "worktree" ? `${m.member.repoPath}/.shared` : null;
    return props.selected?.projectKind === "worktree" ? `${props.selected.projectPath}/.shared` : null;
  };

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

  // Single-select picker, the same shape as the sidebar's askPick: the git
  // commands that name a branch list the repo's branches rather than asking the
  // user to type one they have to remember exactly.
  const [pickReq, setPickReq] = createSignal<{
    title: string;
    items: string[];
    creatable: boolean;
    resolve: (v: string | null) => void;
  } | null>(null);
  function askPick(title: string, items: string[], creatable = false): Promise<string | null> {
    return new Promise((resolve) => setPickReq({ title, items, creatable, resolve }));
  }
  function resolvePick(v: string | null) {
    const req = pickReq();
    setPickReq(null);
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
    const ws = focusRoot();
    if (!ws) return;
    const anchor = debugFilePath() ?? ws;
    const resolved = await resolveRoot(anchor, ws);
    setDebugPick({ kind, scripts: await scriptsAt(resolved), port: attachPortFor(attachPorts(), ws) });
  }

  async function runDebugTarget(target: DebugTarget) {
    const ws = focusRoot();
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
    const ws = focusRoot();
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
  // Inside a Feature the space and project are the *active member's*: the
  // selection's own are `""` and the Feature's name, which name no folder on
  // disk, so this tab was permanently hidden there.
  const docsCandidate = () => {
    const dr = docsRoot();
    const sel = props.selected;
    if (!dr || !sel) return null;
    const m = activeMember();
    const space = m ? m.spaceName : sel.spaceName;
    const project = m ? m.projectName : sel.projectName;
    return space && project ? `${dr}/${space}/${project}` : null;
  };
  // Bumped per probe: moving the active member twice in quick succession leaves
  // two `file_exists` in flight, and the slower one must not answer for the
  // member that is no longer selected. Same latest-wins guard the TODO and
  // Search panels keep.
  let docsProbe = 0;
  createEffect(
    on(docsCandidate, async (candidate) => {
      const probe = ++docsProbe;
      if (!candidate) return setDocsPath(null);
      const exists = await invoke<boolean>("file_exists", { path: candidate }).catch(() => false);
      if (probe !== docsProbe) return;
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
    if (rightMode() === "problems" && !problemsHere()) setRightMode("files");
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

  // A debug run holds a *debuggee*: a process the workspace's code is running,
  // with its own ports, open files and children. Leaving the workspace is
  // exactly the case where nothing on screen names it any more, so it is swept
  // on the way out rather than only when a new one arrives.
  //
  // Keyed on the workspace, not on `root`. Inside a Feature the debuggee belongs
  // to the Feature, and moving the active member is a pointer move: killing the
  // run because you clicked another repo in the tree is not a sweep, it is a
  // stop nobody asked for. `ws()` is "" with nothing selected, so deselecting
  // still fires.
  //
  // Statically imported, unlike the LSP client: `dapSessions` is deliberately
  // editor-free, so it costs no CodeMirror in the chunk.
  //
  // A memo, not the bare `ws` accessor, for the reason `watchKey` is one: `on`
  // re-runs whenever its tracked accessor's dependencies invalidate, not only
  // when the value changes, and a Selection rebuilt with the same key would
  // then stop the run anyway.
  const wsKey = createMemo(ws);
  createEffect(
    on(wsKey, () => {
      void stopAllDap();
      // And the transcript with them: what is on screen is another workspace's
      // program output, and the pane has no way to say whose it was.
      clearDebugConsole();
    }),
  );

  // Projects already swept by local_history_prune this run.
  const prunedHistory = new Set<string>();
  // Start (and on folder switch, replace) the fs watcher so the gutter and the
  // review surface refresh on external changes.
  createEffect(
    on(root, (r) => {
      // Which slot the one-repo surfaces read. Only the pointer: the slots
      // themselves follow the member set, below, so moving the active member
      // inside a Feature costs no read at all.
      setActiveRoot(r);
      // The per-workspace settings overlay, for the same reason: this pane is
      // always mounted and is what knows which workspace is selected, and the
      // Settings panel (which badges the overlay) is usually not open.
      void loadWorkspaceSettings(r);
      if (!r) return;
      // Sweep local history for what a save can never reach: versions past the
      // age cap in files nobody has saved since, and the timelines of worktrees
      // that have been removed. Once per project per run: the sweep walks the
      // store on disk, and a switch is the hottest path in the app.
      if (!prunedHistory.has(r)) {
        prunedHistory.add(r);
        invoke("local_history_prune", { repoPath: r }).catch(() => {});
      }
      // Symbols and call roots are cheap re-fetches from a warm server, so a
      // switch still clears them; diagnostics are NOT cleared, because the warm
      // servers keep them true and the consumers scope to the selected root.
      // A silent stop-and-restart of every server was most of why a worktree
      // switch felt slow: tsserver or rust-analyzer cold-started on every
      // click. The warm-root LRU keeps the last few projects' servers running
      // and stops only what falls off the warm end. Servers are still started
      // lazily by CodeEditor on the first file of each language; the lazy
      // import keeps CodeMirror out of the startup chunk.
      clearSymbols();
      clearCallRoots();
      // Through `lspWarmRoots`, not `lspClient`: that module is in an import
      // cycle, so this dynamic import can resolve before its body has run, and
      // the touch would read bindings that are not there yet. `lspClient` is
      // only reached when a project actually fell off the warm end.
      if (r) {
        void import("./lspWarmRoots").then(({ touchWarmRoot }) => {
          const evicted = touchWarmRoot(r);
          if (evicted.length) void import("./lspClient").then((m) => m.stopEvictedLspRoots(evicted));
        });
      }
    }),
  );

  // The watcher is the one thing that follows the whole Feature rather than the
  // member in front: a background member's edit still has to reach the tree
  // section showing it. Keyed on the joined list, so moving the active root
  // inside a Feature re-issues nothing, and repairing a member (which grows the
  // list) re-issues rather than leaving the newcomer muted for the session.
  const watchRoots = () => {
    const sel = props.selected;
    if (sel?.kind === "feature") return sel.roots ?? [];
    const r = root();
    return r ? [r] : [];
  };
  // A memo, not a bare accessor: `on` re-runs whenever its tracked accessor's
  // dependencies invalidate, not only when the value changes, so a Selection
  // rebuilt with an equal root list would re-issue the whole set. The memo's
  // string equality is what makes moving the active root a no-op here.
  const watchKey = createMemo(() => watchRoots().join("\n"));
  // The git store spans the same set, and for the same reason: a background
  // member's numbers have to be true for the section showing them, the palette
  // and the sidebar count, none of which is the member in front.
  createEffect(
    on(watchKey, (joined) => {
      const roots = joined ? joined.split("\n") : [];
      enterRoots(roots, root());
      void Promise.all(roots.map((r) => refreshGit(r))).then(() => traceSettle("git", ws()));
    }),
  );
  createEffect(
    on(watchKey, (joined) => {
      const roots = joined ? joined.split("\n") : [];
      // An empty set still goes out for a Feature: it evicts, where skipping
      // would leave the last Feature's members watched and unmuted, emitting
      // bursts for a tree nobody is looking at.
      if (props.selected?.kind === "feature") invoke("fs_watch_set", { roots }).catch(() => {});
      else if (roots.length) invoke("fs_watch_start", { projectPath: roots[0] }).catch(() => {});
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
    // And the **pane's** stored pick, not only this kind's claim. A pane holds
    // file tabs and terminal tabs at once and `activeIdInPane` resolves the two:
    // the stored pick wins when its kind still claims it, and otherwise the
    // first claim in display order does - which is always a terminal tab, since
    // `unifiedTabs` emits those first and `visibleId()` falls back to `tabs[0]`
    // so that claim is never quiet. Writing only the claim therefore left the
    // file behind whatever chat the pane was showing. Clicking the tab worked
    // because `PaneView`'s `onActivate` writes both.
    const pane = paneHoldingFile(path) ?? focusedEditorPane();
    if (pane && pane !== SOLO_PANE) setPaneActive(ws(), pane, path);
  }

  /** The pane a file tab is already in, which is not always its kind's home:
   *  a hand-moved tab has to be revealed where it actually sits. */
  const paneHoldingFile = (id: string) =>
    panesWithKind(ws(), "file").find((p) => paneTabs(ws(), p).some((t) => t.id === id));

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
    // Right neighbor, then left: the unified active-after-close policy (plan
    // phase 5). Computed before the list shrinks, or the closed id has no index.
    const nextActive = nextActiveAfterClose(tabs().map(tabId), id);
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
    // Same reason again, for the pane it was in: a path reopened later would
    // otherwise inherit a placement made for the tab that had the path before.
    forgetTab(ws(), id);
    if (activeId() === id) {
      setActiveId(nextActive);
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
    const nextActive = nextActiveAfterClose(tabs().map(tabId), path);
    const remaining = tabs().filter((t) => t.path !== path);
    setTabs(remaining);
    setDirty((d) => {
      const next = { ...d };
      delete next[path];
      return next;
    });
    noteBufferClosed(ws(), path);
    if (activeId() === path) {
      setActiveId(nextActive);
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
    // Ahead of the tab sweep: a breakpoint on a trashed file has no gutter left
    // to click, so nothing could ever remove it and it would go out in every
    // future run's `setBreakpoints`.
    mapBreakpointFiles((p) => (isUnderPath(p, path) ? null : p));
    // A folder that is gone cannot be collapsed by hand: there is no row left
    // to click, so an entry naming it would sit in the store for good.
    mapExpandedFiles((p) => (isUnderPath(p, path) ? null : p));
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

  /** What a Feature wrote under a *member root* rather than under its own key.
   *  Narrower than `purgeWorkspaceKey` on purpose: deleting a Feature offers its
   *  worktrees rather than removing them, and a kept one's tabs, terminals and
   *  tree state belong to that folder as a branch unit. */
  function dropMemberDebugState(memberRoot: string) {
    setAttachPorts((s) => dropWorkspaceKey(s, memberRoot));
    setLastTargets((s) => dropWorkspaceKey(s, memberRoot));
    dropWorkspaceWatches(memberRoot);
  }

  // A workspace key is gone (a Feature was deleted): every store keyed by it
  // drops the key. Marked touched so the persisted tab store drops it too.
  // Dirty text and the stash go only for paths no other workspace still has
  // open: a member's file is usually open under the member's own unit as well.
  function purgeWorkspaceKey(ws: string) {
    const elsewhere = new Set(
      Object.entries(tabsByWs()).flatMap(([w, ts]) => (w === ws ? [] : ts.map((t) => t.path))),
    );
    const removed = (tabsByWs()[ws] ?? []).map((t) => t.path).filter((p) => !elsewhere.has(p));
    setTabsByWs((s) => dropWorkspaceKey(s, ws));
    setActiveByWs((s) => dropWorkspaceKey(s, ws));
    setClosedByWs((s) => dropWorkspaceKey(s, ws));
    setJumpsByWs((s) => dropWorkspaceKey(s, ws));
    setFrecency((s) => dropWorkspaceKey(s, ws));
    setAttachPorts((s) => dropWorkspaceKey(s, ws));
    setLastTargets((s) => dropWorkspaceKey(s, ws));
    dropWorkspaceBreakpoints(ws);
    dropWorkspaceExpanded(ws);
    dropWorkspaceWatches(ws);
    touchedWs.add(ws);
    if (!removed.length) return;
    setDirty((d) => {
      const out = { ...d };
      for (const p of removed) delete out[p];
      return out;
    });
    for (const p of removed) dropStashEntry(p);
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
    mapBreakpointFiles((p) => repoint(p, from, to) ?? p);
    mapExpandedFiles((p) => repoint(p, from, to) ?? p);
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
      projectRoot: gitRoot(),
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
   * CodeEditor's buffer map (so the undo history comes along), the jump list
   * and the reopen stack, so every one of them follows the file
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

  // Which repo the palette's git commands act in. The member owning the file in
  // front, since that is the one whose changes you are looking at; the member in
  // front otherwise, which is the only answer a branch unit has.
  const gitRoot = () => rootOf(activeId(), watchRoots()) ?? root();

  // Repo-relative, which is what every git_* command takes, alongside the repo
  // it is relative to. A file outside every member (a Docs note, a `.shared/`
  // file) has no path git would accept, so it is refused by name rather than
  // staged against the wrong repo.
  //
  // Relativized through `mentionPath` rather than by slicing the root's length:
  // `isUnderPath` normalizes a trailing slash before comparing, so a root that
  // carried one would pass the guard and then yield a path off by a character.
  function activeRepoPath(): { root: string; rel: string } | null {
    const path = activeId();
    if (!path) return null;
    const r = rootOf(path, watchRoots());
    if (!r) {
      emitWith<ToastEvent>(TOAST, {
        message: `${basename(path)} isn't in this workspace, so git has nothing to stage.`,
        kind: "error",
      });
      return null;
    }
    return { root: r, rel: mentionPath(path, r) };
  }

  function stageActive(staging: boolean) {
    const hit = activeRepoPath();
    if (!hit) return;
    void (staging ? stageFiles(hit.root, [hit.rel]) : unstageFiles(hit.root, [hit.rel]));
  }

  async function commitFromPrompt() {
    const r = gitRoot();
    // Re-checked here, not just in the palette's enablement: the index can move
    // between the row being listed and the prompt being answered.
    if (!r || !stagedFiles(r).length) return;
    const message = (await askText("Commit message", ""))?.trim();
    if (!message) return;
    await commitStaged(r, message);
  }

  function pushCurrentBranch() {
    const r = gitRoot();
    const branch = gitStateFor(r).branch;
    if (r && branch) void pushToOrigin(r, branch);
  }

  /** Pull, then push what the pull left ahead. Sequential, not parallel: a push
   *  racing its own pull is how a non-fast-forward rejection happens. */
  async function syncCurrentBranch() {
    const r = gitRoot();
    if (!r) return;
    if (!(await pullIn(r))) return;
    const branch = gitStateFor(r).branch;
    if (branch) await pushToOrigin(r, branch);
  }

  /** A branch to act on, chosen from this repo's own list. */
  async function pickBranch(title: string, { creatable = false, exceptCurrent = false } = {}) {
    const r = gitRoot();
    if (!r) return null;
    const current = gitStateFor(r).branch;
    const names = (await branchNames(r)).filter((n) => !exceptCurrent || n !== current);
    if (!names.length && !creatable) {
      emitWith<ToastEvent>(TOAST, { message: "No other branches in this repo.", kind: "error" });
      return null;
    }
    const picked = await askPick(title, names, creatable);
    return picked ? ({ root: r, branch: picked } as const) : null;
  }

  /** Report an integrate that stopped on a conflict. A conflict is not a
   *  failure, so it opens the Changes tab rather than raising an error: the
   *  unmerged files are there, and that is where they get resolved. */
  function reportIntegrate(outcome: { conflicted: boolean; message: string } | null, verb: string) {
    if (!outcome) return;
    if (!outcome.conflicted) {
      emitWith<ToastEvent>(TOAST, { message: `${verb} done.`, kind: "info" });
      return;
    }
    emitWith<ToastEvent>(TOAST, {
      message: `${verb} stopped on a conflict. Resolve the files in Changes.`,
      kind: "error",
    });
    emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "changes" });
  }

  async function undoLastCommitHere() {
    const r = gitRoot();
    if (!r) return;
    const ok = await askConfirm({
      title: "Undo the last commit?",
      message:
        "The commit goes away and its changes come back staged, so nothing is lost. If it was already pushed, the upstream still has it.",
      confirmLabel: "Undo commit",
    });
    if (ok) await undoLastCommit(r);
  }

  async function discardAllHere() {
    const r = gitRoot();
    if (!r) return;
    const files = changedFiles(r).map((f) => f.path);
    if (!files.length) return;
    const ok = await askConfirm({
      title: `Discard changes to ${files.length} file${files.length === 1 ? "" : "s"}?`,
      message:
        "Every unstaged change in this repo goes back to how it is staged. Anything already staged is kept.\n\nSway saves a snapshot first, so you can bring it back from Undo history in the timeline.",
      confirmLabel: "Discard changes",
      danger: true,
    });
    if (!ok) return;
    // The same guard the Changes panel's own Discard consults: this rewrites
    // every changed file in the worktree, so an agent mid-turn here can have
    // its work clobbered.
    const allowed = await mayRewrite("Discard", r, {
      confirm: askConfirm,
      refuse: (reason) => emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" }),
    });
    if (!allowed) return;
    try {
      await invoke("git_discard_files", { projectPath: r, files });
      await refreshStatus(r);
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
    }
  }

  async function createBranchHere() {
    const r = gitRoot();
    if (!r) return;
    const name = (await askText("New branch name", ""))?.trim();
    if (name) await createBranch(r, name);
  }

  async function renameBranchHere() {
    const r = gitRoot();
    const from = gitStateFor(r).branch;
    if (!r || !from) return;
    const to = (await askText("Rename branch to", from))?.trim();
    if (to && to !== from) await renameBranch(r, from, to);
  }

  async function deleteBranchHere() {
    // The current branch is left out: git refuses to delete the one you are on,
    // so offering it would only ever produce that refusal.
    const chosen = await pickBranch("Delete which branch?", { exceptCurrent: true });
    if (!chosen) return;
    const ok = await askConfirm({
      title: `Delete ${chosen.branch}?`,
      message: "Unmerged commits on it would be lost. Git refuses that unless you force it.",
      confirmLabel: "Delete branch",
      danger: true,
    });
    if (ok) await deleteBranch(chosen.root, chosen.branch);
  }

  async function commitFromPromptSignedOff() {
    const r = gitRoot();
    if (!r || !stagedFiles(r).length) return;
    const message = (await askText("Commit message (signed off)", ""))?.trim();
    if (message) await commitStaged(r, message, false, true);
  }

  let offTouched: UnlistenFn | undefined;
  let offOpen: (() => void) | undefined;
  let offPurge: (() => void) | undefined;
  let offPurgeWs: (() => void) | undefined;
  let offClose: (() => void) | undefined;
  let offFollow: UnlistenFn | undefined;
  let offProjectSearch: (() => void) | undefined;
  let offSetRightMode: (() => void) | undefined;
  let offSearchInFolder: (() => void) | undefined;
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
      onWith<EditorClosePath>(EDITOR_CLOSE_PATH, ({ path, discard }) => {
        if (discard) return forceCloseFile(path);
        const tab = tabs().find((t) => t.path === path);
        if (tab) void closeTab(tabId(tab));
      }),
      // Pane-scoped tab keys (plan phase 6): the same events the terminal
      // panel handles for its own tabs, gated on which pane holds focus, so
      // one keystroke acts on exactly one pane. Close goes through closeTab,
      // which already asks before discarding a dirty buffer.
      onEvent(CLOSE_TAB, () => {
        if (!kindPaneFocused(ws(), "file")) return;
        const id = activeId();
        if (id) void closeTab(id);
      }),
      onWith<TabJump>(TAB_JUMP, ({ index }) => {
        if (!kindPaneFocused(ws(), "file")) return;
        const t = tabs()[index];
        if (t) setActiveId(tabId(t));
      }),
      onEvent(TAB_CYCLE, () => {
        if (!kindPaneFocused(ws(), "file")) return;
        const list = tabs();
        if (!list.length) return;
        const idx = list.findIndex((t) => tabId(t) === activeId());
        setActiveId(tabId(list[(idx + 1) % list.length]));
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
      onEvent(DEBUG_TOGGLE_BREAKPOINT, () => {
        const at = caretHere();
        const path = activeFileTab()?.path;
        if (at && path) toggleBreak(path, at.line);
      }),
      onEvent(DEBUG_RESTART, () => void restartDebugging()),
      onWith<DebugPick>(DEBUG_PICK, (d) => {
        if (d?.kind) void openDebugPicker(d.kind);
      }),
      onEvent(EDITOR_REOPEN_CLOSED, reopenClosedTab),
      onEvent(GIT_STAGE_ACTIVE, () => stageActive(true)),
      onEvent(GIT_UNSTAGE_ACTIVE, () => stageActive(false)),
      onEvent(GIT_COMMIT, () => void commitFromPrompt()),
      onEvent(GIT_PUSH, pushCurrentBranch),
      onEvent(GIT_FETCH, () => {
        const r = gitRoot();
        if (r) void fetchIn(r);
      }),
      onEvent(GIT_PULL, () => {
        const r = gitRoot();
        if (r) void pullIn(r);
      }),
      onEvent(GIT_PULL_REBASE, () => {
        const r = gitRoot();
        if (r) void pullIn(r, true);
      }),
      onEvent(GIT_SYNC, () => void syncCurrentBranch()),
      onEvent(GIT_STAGE_ALL, () => {
        const r = gitRoot();
        if (r) void stageAll(r);
      }),
      onEvent(GIT_UNSTAGE_ALL, () => {
        const r = gitRoot();
        if (r) void unstageAll(r);
      }),
      onEvent(GIT_DISCARD_ALL, () => void discardAllHere()),
      onEvent(GIT_COMMIT_SIGNOFF, () => void commitFromPromptSignedOff()),
      onEvent(GIT_UNDO_COMMIT, () => void undoLastCommitHere()),
      onEvent(GIT_STASH_STAGED, () => {
        const r = gitRoot();
        if (r) void stashStaged(r);
      }),
      onEvent(GIT_MERGE_BRANCH, () => {
        void pickBranch("Merge which branch?", { exceptCurrent: true }).then(async (c) => {
          if (c) reportIntegrate(await merge(c.root, c.branch), "Merge");
        });
      }),
      onEvent(GIT_REBASE_BRANCH, () => {
        void pickBranch("Rebase onto which branch?", { exceptCurrent: true }).then(async (c) => {
          if (c) reportIntegrate(await rebase(c.root, c.branch), "Rebase");
        });
      }),
      onEvent(GIT_ABORT, () => {
        const r = gitRoot();
        if (r) void abortIntegrate(r);
      }),
      onEvent(GIT_BRANCH_CREATE, () => void createBranchHere()),
      onEvent(GIT_BRANCH_RENAME, () => void renameBranchHere()),
      onEvent(GIT_BRANCH_DELETE, () => void deleteBranchHere()),
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
      if (d.preview && !previewOn().has(d.path)) togglePreviewOf(d.path);
      if (d.side) emitWith<SplitPane>(SPLIT_PANE, { dir: "row", tabId: d.path, kind: "file" });
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
    offPurgeWs = onWith<PurgeWorkspace>(PURGE_WORKSPACE, ({ workspace, roots }) => {
      purgeWorkspaceKey(workspace);
      for (const r of roots ?? []) dropMemberDebugState(r);
    });
    // Cmd+Shift+F: switch to Search mode and bump the nonce so SearchPanel
    // refocuses its input even when the mode is already active.
    offProjectSearch = onEvent(FOCUS_PROJECT_SEARCH, () => {
      setRightMode("search");
      setSearchFocusNonce((n) => n + 1);
    });
    offSetRightMode = onWith<SetRightMode>(SET_RIGHT_MODE, (d) => {
      if (d?.mode) setRightMode(d.mode);
      if (d?.section) revealSection(d.section);
    });
    offSearchInFolder = onWith<SearchInFolder>(SEARCH_IN_FOLDER, (d) => {
      setSearchScope({ ...d, nonce: ++searchScopeNonce });
      setRightMode("search");
    });
    offFileRenamed = onWith<FileRenamed>(FILE_RENAMED, (d) => {
      if (d?.from && d.to) followRename(d.from, d.to);
    });
    // Follow mode: auto-open the most-recently-changed project file. The watcher
    // already filters .git/node_modules/dist/target, and self-writes are skipped,
    // so follow never jumps to git internals, build output, or our own saves.
    offFollow = await listen<FsChanged>("fs://changed", (e) => {
      // Another root's burst is not this workspace's news, even though the
      // backend mutes background roots: a burst can land mid-switch.
      if (e.payload.root && e.payload.root !== props.selected?.folderPath) return;
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
      if (!followEdits()) return;
      if (external.length) openFile(external[external.length - 1]);
    });
    // Unsaved-buffer guard on app close. window.confirm can't run here, so always
    // block the close first, then destroy the window ourselves if the user confirms
    // (destroy bypasses this handler, so there is no re-prompt loop).
    offClose = await getCurrentWindow().onCloseRequested(async (event) => {
      // Before any branch: every exit below is `destroy()`, which skips
      // `beforeunload`, and the layout stores write on a debounce now.
      flushDeferredWrites();
      // Block first, unconditionally. Everything under this line is async, and
      // a handler that returns before it has decided has already let the window
      // go: Tauri destroys as soon as the handler settles without a prevent.
      event.preventDefault();
      // The app's own quit question comes before the editor's: a refused quit
      // must not have stashed buffers or asked about them on the way out. The
      // guards are registered elsewhere (App.tsx); this is the only close
      // listener in the app, see utils/closeGuard.
      if (!(await closeAllowed())) return;
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
      if (!anyDirty && !editorDefaults().hotExit) {
        await getCurrentWindow().destroy();
        return;
      }
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
    offPurgeWs?.();
    offClose?.();
    offFollow?.();
    offProjectSearch?.();
    offSetRightMode?.();
    offSearchInFolder?.();
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
  // The bar's trailing cluster while a file tab is active (or while the file
  // pane sits empty). Moved verbatim from the old bar's `trailing` prop.
  // Jump navigation, in the topbar since phase 13: it acts on the workspace's
  // history rather than on a pane's strip, and every strip drawing every kind's
  // controls would otherwise put a copy of it in each pane.
  //
  // Always mounted rather than shown only once there is somewhere to go: a
  // control that appears and disappears moves everything beside it, and the
  // greyed-out pair is what says the list has an end.
  const editorNav = () => (
    <>
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
    </>
  );

  // The source-vs-render toggle, per pane, in that pane's breadcrumb bar rather
  // than in the strip. It is about one file, and only some files have it: in the
  // strip it appeared and vanished as you moved between tabs, re-flowing every
  // pane's row (and pushing tabs into `+N`) on a selection that changed nothing
  // about them.
  // Blame is about the file the trail names, so it sits with the preview toggle
  // rather than in the strip every pane shares: in the strip it was one control
  // for whatever tab happened to be in front, which is not what a split view
  // means by "this file".
  const blameBtn = () => (
    <IconButton
      size="sm"
      // `aria-pressed` by hand, and no `active`: the pressed look this control
      // wants is the composer's, which accents the glyph rather than filling
      // the button, and `active` is the fill.
      aria-pressed={blameOn()}
      icon={<Icon icon={UserRound} class={blameOn() ? crumbStyles.barToggleOn : undefined} />}
      onClick={toggleBlame}
      tooltip={
        blameOn()
          ? "Showing git blame: who last changed each line, shaded by age. Click to hide."
          : "Git blame: show who last changed each line, shaded by age."
      }
    />
  );

  const previewBtn = (id: string) => (
    <IconButton
      size="sm"
      aria-pressed={previewingOf(id)}
      icon={
        <Icon
          icon={previewingOf(id) ? FileCodeCorner : svgOf(id) ? FileHeart : FileTypeCorner}
          class={previewingOf(id) ? crumbStyles.barToggleOn : undefined}
        />
      }
      onClick={() => togglePreviewOf(id)}
      tooltip={
        previewingOf(id)
          ? `Showing rendered ${svgOf(id) ? "SVG" : "Markdown"}. Click to edit the source.`
          : `Preview: render this ${svgOf(id) ? "SVG" : "Markdown"} file instead of editing its source.`
      }
    />
  );

  // The strip's right edge, past every kind's own controls: revealing the tree
  // is about the window rather than about a tab, and it is also the one button
  // whose whole job is to be findable when the thing it opens is not on screen.
  const editorFiletreeReveal = () => (
    <Show when={props.onToggleFiletree && !filetreeOn()}>{filetreeToggleBtn(false)}</Show>
  );

  // Where each column's CodeMirror view goes. Elements rather than ids, so the
  // one editor component can portal into a column it did not render.
  const [slots, setSlots] = createSignal<Record<string, HTMLElement>>({});
  const holdSlot = (paneId: string, el: HTMLElement) => {
    setSlots((prev) => ({ ...prev, [paneId]: el }));
    onCleanup(() =>
      setSlots((prev) => {
        const next = { ...prev };
        if (next[paneId] === el) delete next[paneId];
        return next;
      }),
    );
  };

  /** One pane's editor column: what its tab is, said above the file, and what
   *  the tab actually is (a buffer, a rendered preview, an image, a view). The
   *  editor view itself is portalled into `.codeSlot` by CodeEditor. */
  function EditorColumn(p: { paneId: string }) {
    const fileId = () => paneFileId(p.paneId);
    const focused = () => focusedEditorPane() === p.paneId;
    // A pane showing a terminal tab keeps its editor column mounted (buffers and
    // scroll survive) but out of the way. The file home keeps it only while
    // nothing else is on screen there: two flex:1 stage children split the pane.
    const shown = () =>
      !!fileId() ||
      p.paneId === SOLO_PANE ||
      (isKindHome(ws(), "file", p.paneId) && !paneActiveId(ws(), p.paneId));
    const filePath = () => fileTabOf(fileId())?.path ?? null;
    const conflictedHere = () => isConflicted(watchRoots(), filePath());
    /** This pane's file when it is one that renders, which is what earns the
     *  bar its toggle. */
    const previewableId = () => {
      const id = fileId();
      return id && (markdownOf(id) || svgOf(id)) ? id : null;
    };
    /** This pane's file when it is a PDF, which is what earns the bar its zoom
     *  and page controls and costs it the blame toggle. */
    const pdfId = () => {
      const id = fileId();
      return id && pdfOf(id) ? id : null;
    };
    return (
      <div
        class={styles.editorMain}
        classList={{ [styles.hidden]: !shown() }}
        // Registered by pane id; the width observer effect above picks the
        // focused one, so the right panel's bound tracks focus and remounts
        // rather than whichever column happened to be focused at mount.
        ref={(el) => holdCol(p.paneId, el)}
      >
        {/* Where the open file sits and where the caret sits in it. Below the
            tabs and above everything else in the column: a tab says which file,
            and this says the rest of the answer. Only for a real file - a commit
            log or a conflict view has a `sway://` id, which names no folder any
            picker could list. */}
        <Breadcrumbs
          root={root()}
          path={filePath()}
          member={tabMember(filePath())}
          caret={focused() ? caretHere() : null}
          trailing={
            <>
              {/* Preview first, blame second, because the cluster is pinned to
                  the bar's right edge: the one that comes and goes has to be
                  the one on the moving side of it. */}
              {/* Keyed, or the button freezes: non-keyed Show re-runs its child
                  only when truthiness flips, so moving between two previewable
                  files would leave the first one's button (and its id) in
                  place. */}
              <Show when={previewableId()} keyed>
                {(id) => previewBtn(id)}
              </Show>
              {/* Keyed for the same reason the preview toggle is: the toolbar
                  reads one path's shared view state, so moving between two PDF
                  tabs has to rebuild it rather than leave it on the first. */}
              <Show when={pdfId()} keyed>
                {(id) => <PdfToolbar path={id} />}
              </Show>
              {/* Not for a `sway://` view: a commit log has no working copy for
                  git to blame. Not for a PDF either: blame is per line, and a
                  PDF has none - it is not even read as text. */}
              <Show when={filePath() && !isSyntheticId(filePath()!) && !pdfId()}>{blameBtn()}</Show>
            </>
          }
        />
        {/* Above the editor rather than inside it: the file on screen is the
            merged working-tree copy, markers and all, and nothing in the buffer
            itself says that is why it looks like that. */}
        <Show when={conflictedHere()}>
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
        <div
          class={styles.codeSlot}
          classList={{ [styles.hidden]: !editablePathOf(fileId()) }}
          ref={(el) => holdSlot(p.paneId, el)}
        />
        <Show
          when={fileId()}
          fallback={
            <Show when={!filePaths().length}>
              <div class={styles.editorEmpty}>
                Open a file from the tree to start editing, or press ⌘P to find one by name.
              </div>
            </Show>
          }
        >
          <Show when={syntheticOf(fileId())}>
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
                {/* The other half of the sidebar's Graph section: lanes need
                    width, and the right panel is the narrow column. */}
                <Show when={t().kind === "graph"}>
                  <GraphView workspace={t().workspace} />
                </Show>
                {/* Staging lives here rather than in the Changes panel: a hunk
                    needs the width of a pane, and the panel's rows stay one
                    line tall. Reports discards on the same channel a checkpoint
                    revert does, so a buffer open on the file is offered
                    keep-mine / take-disk. */}
                <Show when={t().kind === "diff"}>
                  <DiffView
                    workspace={t().workspace}
                    arg={t().arg}
                    selected={props.selected}
                    onReverted={handleReverted}
                  />
                </Show>
                {/* Its own CodeMirror instance, not a buffer in CodeEditor:
                    this document has no file behind it and lives under rules no
                    file buffer has (its line count is fixed, and only a result's
                    own text is editable). */}
                <Show when={t().kind === "search"}>
                  <Suspense fallback={<div class={styles.editorEmpty}>Loading editor…</div>}>
                    <SearchResultsBuffer
                      id={fileId()!}
                      roots={searchRootsHere()}
                      members={featureId() ? members() : []}
                      openPaths={filePaths()}
                      confirm={askConfirm}
                    />
                  </Suspense>
                </Show>
                {/* Code with no file behind it, fetched from the adapter by
                    reference. Read-only by construction: there is nothing to
                    save it to. */}
                <Show when={t().kind === "dapsource"}>
                  <DebugSourceView id={fileId()!} name={syntheticTabName(fileId()!)} />
                </Show>
                <Show when={t().kind === "conflict"}>
                  {/* Resolving rewrites the file, so it reports on the same
                      channel a discard or a checkpoint revert does: a buffer
                      open on it with unsaved edits is offered keep-mine /
                      take-disk rather than writing the conflict back. */}
                  <ConflictView workspace={t().workspace} file={t().arg} onResolved={handleReverted} />
                </Show>
              </>
            )}
          </Show>
          <Show when={imageOf(fileId())}>
            <ImageView path={fileId()!} />
          </Show>
          {/* `goto` carries a page rather than a line for a PDF: the chat, the
              chips and the jump list already speak in `line`, and inside Sway
              that is what a PDF's line is. */}
          <Show when={pdfOf(fileId())}>
            <Suspense fallback={<div class={styles.editorEmpty}>Loading viewer...</div>}>
              <PdfView
                path={fileId()!}
                goto={gotoTarget()}
                onQuote={(text, first, last) => void quoteFromPdf(fileId()!, text, first, last)}
              />
            </Suspense>
          </Show>
          <Show when={previewingOf(fileId())}>
            <Show when={svgOf(fileId())} fallback={<MarkdownPreview path={fileId()!} />}>
              <ImageView path={fileId()!} />
            </Show>
          </Show>
        </Show>
      </div>
    );
  }

  // The strip consumes the unified model filtered to this panel's kind: same
  // tabs, same order, same references, read through the union.
  const stripTabs = (): FileUnifiedTab[] =>
    unifiedTabs().filter((u): u is FileUnifiedTab => u.kind === "file" && u.workspace === ws());

  registerKind("file", {
    // The chip composes *before* the file glyph rather than replacing it: `icon`
    // is one slot, and the seti glyph is the other half of what a tab says.
    icon: (u) => {
      const t = asFile(u);
      const m = tabMember(t.path);
      return (
        <>
          {m && <TabMemberChip member={m} />}
          {tabIcon(t)}
        </>
      );
    },
    // The repo reaches the accessible name through a hidden span, never
    // `aria-label`: a name on a tab replaces its visible text rather than adding
    // to it, and 34 `getByRole("tab", { name })` queries read that text.
    title: (u) => {
      const t = asFile(u);
      const m = tabMember(t.path);
      return (
        <>
          {m && <span class={patterns.srOnly}>{m.label} / </span>}
          {tabName(t)}
        </>
      );
    },
    tooltip: (u) => {
      const t = asFile(u);
      const m = tabMember(t.path);
      const base = tabTitle(t);
      // A tab outlives its member's worktree, so the hover text is where the
      // dimmed chip gets a name for what happened to it.
      return m && !m.state.usable ? `${base}\n${m.label}: ${m.state.label}` : base;
    },
    dots: fileDots,
    // The tab moves between panes either way (the registry says so); what a
    // synthetic view cannot do is hand anyone a path, since dropping its id on
    // a terminal would paste `sway://…`, which names nothing on disk.
    onDragStart: (u, e) => {
      const t = asFile(u);
      if (isSyntheticId(t.path)) return;
      e.dataTransfer?.setData(DRAG_PATH_MIME, t.path);
      e.dataTransfer?.setData("text/plain", t.path);
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
      const m = tabMember(t.path);
      // The overflow row is the one place two members' same-named files sit
      // next to each other, so it spends the width on the whole `<repo> / <rel>`
      // rather than on the basename the strip already showed.
      const rel = m && repoRelative(t.path, m.key);
      return (
        <>
          {m && <TabMemberChip member={m} />}
          {tabIcon(t)}
          <span class="tab-name">{m ? `${m.label} / ${rel ?? t.name}` : tabName(t)}</span>
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
    // No ranked cluster of its own any more: every control this panel had in
    // the strip was about one file, and both went to the pane that holds it.
    trailingEdge: editorFiletreeReveal,
    activate: (u) => setActiveId(u.id),
    close: (u) => void closeTab(u.id),
    // Pane hosting (plan phase 7): the file-pinned pane draws this panel's
    // strip and adopts the one shared editor stage; every workspace's tabs
    // render into it, so the pane never needs a host per file.
    stripItems: stripTabs,
    // The workspace's own pick, not the focused pane's: a pane's strip resolves
    // its own active tab from this (see activeIdInPane), and answering with the
    // pane-derived one would ask this question in a circle.
    stripActiveId: () => activeByWs()[ws()] ?? null,
    stripReorder: (next) => setTabs(next.filter((u): u is FileUnifiedTab => u.kind === "file").map((u) => u.file)),
    stripClass: styles.editorTabs,
    // One host per pane (phase 9), so two panes can each hold a view; a pane-less
    // panel keeps the single host it has always rendered into.
    hostIds: (paneId, tabs) =>
      paneId === null || tabs.length || isKindHome(ws(), "file", paneId)
        ? [editorStageId(paneId ?? "editor-stage")]
        : [],
  });

  // A service host since phase 7: no visible output. The code side and the
  // chrome portal into stage hosts (the pane adopts one, App places the other
  // beside it), and the dialogs portal themselves.
  return (
    <>
      {/* One column per pane holding file tabs (plan phase 9), each portalled
          into that pane's own stage host; with no pane tree at all there is one
          column in the host the panel has always used. */}
      <For each={editorPaneIds()}>
        {(paneId) => (
          <Portal mount={stageHost(editorStageId(paneId))}>
            <EditorColumn paneId={paneId} />
          </Portal>
        )}
      </For>
      {/* Mounted on the union, hidden on the visible strip. Gating the mount on
          the current workspace's tab count would unmount CodeEditor the moment
          you selected a workspace with nothing open, and its cleanup destroys
          every view and buffer behind it - including a background workspace's
          unsaved edits, which is the loss `openPaths` carrying the union exists
          to prevent. */}
      <Show when={allOpenPaths().length}>
        <Suspense fallback={filePaths().length ? <div class={styles.editorEmpty}>Loading editor…</div> : null}>
          <CodeEditor
            // What the watcher covers, so a tab on a file outside all of it
            // knows it will hear about an outside write from nobody.
            watchedRoots={watchRoots()}
            // The focused pane's file, which is what the solo form shows and
            // what everything outside the columns means by "the active file".
            activePath={editablePathOf(paneFileId(focusedEditorPane()))}
            paneIds={editorPaneIds()}
            paneHost={(id) => slots()[id]}
            panePath={(id) => editablePathOf(paneFileId(id))}
            paneHidden={(id) => !editablePathOf(paneFileId(id))}
            focusedPaneId={focusedEditorPane()}
            openPaths={allOpenPaths()}
            projectRoot={root()}
            callsVisible={rightMode() === "calls"}
            goto={gotoTarget()}
            onDirty={handleDirty}
            onCursorJump={(path, line) => recordJump({ path, line })}
            onCaretMove={noteCaret}
            breakpoints={breaksHere()}
            onToggleBreakpoint={toggleBreak}
            onBreakpointsMoved={breaksMoved}
            frameLine={frameLocation()}
            onCloseFile={forceCloseFile}
            reverted={reverted()}
            selected={props.selected}
            blame={blameOn()}
            // The active tab's override, or null to follow the setting. Only
            // the shown buffer's answer is needed: the others are re-resolved
            // when they are swapped in.
            softWrap={wrapById()[activeId() ?? ""] ?? null}
            confirm={askConfirm}
          />
        </Suspense>
      </Show>
      <Portal mount={stageHost("editor-nav")}>{editorNav()}</Portal>
      <Portal mount={stageHost("editor-chrome")}>
      <Show when={filetreeOn()}>
        <Resizer
          side="after"
          variant="hairline"
          value={rightWidth()}
          min={px(RIGHT_W_MIN)}
          max={rightMax()}
          onInput={setRightW}
          onCommit={persistRightW}
        />
      </Show>
      <div
        class={styles.rightPanel}
        classList={{ [styles.hidden]: !filetreeOn() }}
        style={{ width: `${rightWidth()}px` }}
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
        {/* Below the tab strip rather than inside a pane: the four modes it
            serves each answer for one repo, and one row above all of them is
            one control to learn instead of four. Only alongside other members:
            one member is not a choice. */}
        <Show when={ACTIVE_ROOT_MODES.includes(rightMode()) && featureId() && members().length > 1}>
          <MemberChipRow
            members={members()}
            activeRoot={root()}
            onActiveRoot={props.onActiveRoot}
          />
        </Show>
        <Switch>
          <Match when={rightMode() === "files"}>
            <FilesPanel
              root={root()}
              members={featureId() ? members() : []}
              activePath={shownFileId()}
              outlinePath={activeId()}
              askText={askText}
              askConfirm={askConfirm}
              onRepair={repairMember}
              onActiveRoot={props.onActiveRoot}
              selected={props.selected}
              settleKey={ws()}
              persistKey={ws()}
            />
          </Match>
          <Match when={rightMode() === "problems"}>
            <ProblemsPanel selected={props.selected} roots={treeRoots()} />
          </Match>
          <Match when={rightMode() === "calls"}>
            {focusMemberLine()}
            <CallsPanel path={activeId()} />
          </Match>
          <Match when={rightMode() === "changes"}>
            <ReviewPanel
              root={root()}
              roots={treeRoots()}
              activePath={activeId()}
              selected={props.selected}
              onReverted={handleReverted}
              onRepair={repairMember}
            />
          </Match>
          <Match when={rightMode() === "pulls"}>
            <PullRequests root={root()} />
          </Match>
          <Match when={rightMode() === "search"}>
            <SearchPanel
              root={root()}
              roots={treeRoots()}
              members={featureId() ? members() : undefined}
              openPaths={filePaths()}
              workspace={ws()}
              focusNonce={searchFocusNonce()}
              scope={searchScope()}
              onScoped={() => setSearchScope(null)}
              dirty={dirty()}
              confirm={askConfirm}
            />
          </Match>
          <Match when={rightMode() === "debug"}>
            {focusMemberLine()}
            <DebugPanel root={focusRoot()} selected={props.selected} />
          </Match>
          <Match when={rightMode() === "session" && props.selected?.sessionId}>
            {focusMemberLine()}
            <SessionPanel
              path={props.selected!.sessionPath ?? null}
              agent={props.selected!.agent ?? "claude"}
              profile={props.selected!.profile}
              cwd={props.selected!.sessionCwd ?? null}
              projectRoot={focusRoot()}
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
      </Portal>
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
      <Show when={pickReq()}>
        <PickerModal
          title={pickReq()!.title}
          items={pickReq()!.items}
          creatable={pickReq()!.creatable}
          onSubmit={(v) => resolvePick(v)}
          onCancel={() => resolvePick(null)}
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
    </>
  );
}
