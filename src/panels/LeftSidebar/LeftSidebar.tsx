import { createSignal, For, Match, Show, Switch, onMount, onCleanup, createEffect, createMemo, on, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { isLocked } from "../../utils/autopilotStore";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import Dropdown from "../../components/Menu/Dropdown";
import { type MenuItem } from "../../components/Menu/rows";
import PromptModal from "../../components/Dialogs/PromptModal";
import PickerModal from "../../components/Dialogs/PickerModal";
import ConfirmDeleteSpace, { type DeleteEntry } from "../../components/Dialogs/ConfirmDeleteSpace";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import WorktreeRemoveDialog from "../../components/Dialogs/WorktreeRemoveDialog";
import BranchRemoveDialog from "../../components/Dialogs/BranchRemoveDialog";
import InitGitDialog from "../../components/Dialogs/InitGitDialog";
import AddBranchDialog, { type BranchPick, type IssueSourceProps } from "../../components/Dialogs/AddBranchDialog";
import { errorText, issueDraft, unitIssueOf, type Issue, type IssueRef, type LinkOutcome, type UnitIssue } from "../../utils/issues";
import ChangeOriginDialog from "../../components/Dialogs/ChangeOriginDialog";
import NewProjectDialog from "../../components/Dialogs/NewProjectDialog";
import { claimProjectFolder, projectJob, type NewProjectMode } from "../../utils/newProject";
import SpaceDialog, { type SpaceDialogMode } from "../../components/Dialogs/SpaceDialog";
import ProjectIconDialog from "../../components/Dialogs/ProjectIconDialog";
import ProjectAgentsDialog, { ruleRows } from "../../components/Dialogs/ProjectAgentsDialog";
import { projectRows, setProjectRows } from "../../utils/projectAgents";
import { pushToast, type ToastAction } from "../../components/Toasts/Toasts";
import Button from "../../components/Button/Button";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import {
  on as onEvent,
  onWith,
  emit,
  emitWith,
  FOCUS_SEARCH,
  NAVIGATE,
  type NavTarget,
  TOGGLE_SIDEBAR_MODE,
  NEW_TOPIC,
  SESSIONS_REFRESH,
  DRAG_ABS_PATH_MIME,
  OPEN_JOB,
  NEW_SESSION,
  NEW_CHAT_AT,
  PURGE_UNDER_PATH,
  TERMINAL_TAB_FOCUSED,
  ADD_BRANCH_UNIT,
  REMOVE_BRANCH_UNIT,
  type AddBranchUnit,
  type RemoveBranchUnit,
  type OpenJob,
  type NewSession,
  type NewChatAt,
  type PurgeUnderPath,
  type LiveTab,
  type TerminalTabFocused,
  SESSION_DELETED,
  type SessionDeleted,
  SESSION_ACTION,
  type SessionAction,
  OPEN_IN_EDITOR,
  type OpenInEditor,
  TOGGLE_DOCK,
  OPEN_SETTINGS,
  type OpenSettings,
  ACTIVATE_SPACE,
  type ActivateSpace,
} from "../../utils/events";
import { fetchRootIfStale } from "../../utils/remoteSync";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import { projectUnitKind } from "../../utils/topicMembers";
import { traceSwitchStart } from "../../utils/perfTrace";
import { syntheticId } from "../../utils/syntheticTabs";
import { noteCheckpointTicks } from "../../utils/checkpoints";
import {
  rollupStatuses,
  type LiveSessionStatus,
  type Rollup,
} from "../../utils/sessionStatus";
import { liveChatIds } from "../../utils/chatSessions";
import { findAdapter } from "../../utils/agents";
import { asTabProfile } from "../../utils/agentHealth";
import {
  sessions,
  fetchSessions,
  trackFolders,
  refreshSessions,
  findSession,
  onFolderScan,
  type SessionMeta,
  type FolderScan,
  type SessionsChanged,
} from "../../utils/sessionStore";
import {
  noteLiveTabs,
  noteFolderOwners,
  noteForgeUnits,
  noteAttention,
  probeBatch,
  probeSession,
  probeActive,
  liveSessionStatuses,
  inUnit,
} from "../../utils/sessionActivity";
import { forgeChip, forgeDoor } from "../../utils/forgeChip";
import { finishedLook, resyncRoot, syncFor, syncMarks, syncUnits, type FinishedPr } from "../../utils/branchSync";
import { prRelation } from "../../utils/prRelation";
import { resetToUpstream } from "../../utils/gitActions";
import { compactAgo } from "../../utils/compactAge";
import SyncMarks from "../../components/SyncMarks/SyncMarks";
import TooltipLines from "../../components/Tooltip/TooltipLines";
import { forgeAccountName, forgeErrorMessage, needsAttention } from "../../utils/forgeTypes";
import { apiCanServe } from "../../utils/createPr";
import {
  forgeHosts,
  forgeOrgNotice,
  forgePause,
  forgeRepo,
  noteForgeEnabled,
  pickForgeAccount,
  mergeWatched,
  noteWatchedProjects,
  pollNow,
  topicProjects,
  pollOnFocus,
  startForgePolling,
  unitStatus,
  type WatchedProject,
} from "../../utils/forgeStatus";
import { settings as appSettings } from "../Settings/settingsStore";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import ProjectIcon from "../../components/Icon/ProjectIcon";
import { resolveIcon } from "../../components/Icon/iconRegistry";
import { spaceHue, spaceHueRgb, applySpaceTint } from "../../utils/spaceTint";
import { shortHome, spaceInitials } from "../../utils/names";
import { rememberSelection, rememberedUnit, rememberedTopic } from "../../utils/selectionMemory";
import {
  Folder,
  Ellipsis,
  Search,
  Tag,
  Tags,
  type LucideIcon,
  Plus,
  SquareTerminal,
  Unlink,
  Plug,
  ShieldAlert,
  UserRound,
} from "lucide-solid";
import { BranchMark, WorktreeMark } from "../../components/Icon/gitMarks";
import {
  attemptFolderName,
  groupAttempts,
  samePath,
  type AttemptGroup,
  type AttemptRecord,
} from "./attempts";
import Tooltip from "../../components/Tooltip/Tooltip";
import TopicList from "./TopicList";
import { noteTopics, topicKey, topicSelection, isShellsKey, isReference, tabUnderFolder, type Topic } from "../../utils/topics";
import { dockOpen } from "../../layout/dockStore";
import BranchLine from "./BranchLine";
import StatusBubble, { CountBubble } from "./StatusBubble";
import SpaceTile, { ModeTile, TileProbe } from "./SpaceTile";
import {
  BranchRow,
  EmptyRow,
  GroupRow,
  MoreRow,
  ProjectRow,
} from "./SidebarRows";
import rows from "./SidebarRows.module.css";
import styles from "./LeftSidebar.module.css";

// Glyph for a branch-unit row, keyed by its git kind: a worktree (or an empty
// .bare stub) reads as a folder with a branch off it, a branch of a plain repo
// as a branch, and a non-git folder as a plain folder (matching a space's
// folder mark). This used to mark the *project* row; it sits on the branch rows
// now, where the distinction is about the thing named on the row rather than
// about a container whose own identity the project icon carries.
//
// The two git kinds animate while a session under them is executing, so a
// scan down the column finds the working folder without reading a chip; a
// non-git folder has no sessions to report and stays the static Lucide glyph.
//
// `current` is git's checked-out branch, which the row used to say in a teal
// bullet at its right edge. The glyph draws a branch and its tip, so it can
// say where HEAD is in the ink it already has, and the end cluster keeps its
// width for the things that change.
function UnitIcon(props: { kind: string | undefined; active: boolean; current: boolean }) {
  return (
    <Switch fallback={<Icon icon={Folder} />}>
      <Match when={props.kind === "worktree" || props.kind === "incomplete"}>
        <WorktreeMark active={props.active} current={props.current} stub={props.kind === "incomplete"} />
      </Match>
      <Match when={props.kind === "plain"}>
        <BranchMark active={props.active} current={props.current} />
      </Match>
    </Switch>
  );
}

// Hover text for the glyph, which is the one thing on the row that says these
// two without words: a filled branch tip for the current checkout, a dashed
// folder for a .bare with nothing in it.
function iconLabel(u: BranchUnit): string | undefined {
  const parts: string[] = [];
  if (u.isCurrent) parts.push("Current checkout");
  if (u.kind === "incomplete") {
    parts.push("A .bare with no worktrees (right-click to add one or remove it)");
  }
  return parts.length ? parts.join(". ") : undefined;
}

// Mark a drag from a sidebar row as carrying one or more absolute paths, which
// the terminal inserts verbatim as `@<abspath>` (newline-separated for a space).
function startAbsDrag(e: DragEvent, paths: string | string[]) {
  const value = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).join("\n");
  if (!value) return;
  e.dataTransfer?.setData(DRAG_ABS_PATH_MIME, value);
  e.dataTransfer?.setData("text/plain", value);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
}

// A branch-unit: a worktree folder, a branch of a plain repo, a non-git folder
// (plain-dir), or a cleanable stub (incomplete). All four share `folderPath`,
// the working dir the session/editor anchors on.
type BranchUnit = {
  label: string;
  folderPath: string;
  branch: string | null;
  kind: string; // "worktree" | "plain" | "plain-dir" | "incomplete"
  isCurrent: boolean;
  issue?: UnitIssue;
};
type Branch = { name: string; current: boolean };
// `icon`/`iconFile` are what the user chose (a Lucide name, or an image in the
// icon store); `favicon` is what discovery found inside the project. All three
// are optional and resolved in that order by ProjectIcon.
type Project = {
  name: string;
  path: string;
  branchUnits: BranchUnit[];
  icon?: string;
  iconFile?: string;
  favicon?: string;
};
type Space = {
  name: string;
  path: string;
  projects: Project[];
  icon?: string;
  // A swatch name; absent means the hue is derived from `name`.
  color?: string;
};
type ResolvedConfig = { path: string; roots: string[]; spaces: Space[] };

export type Selection = {
  // Absent means "unit": a selection persisted before Topics carried no kind.
  kind?: "unit" | "topic";
  topicId?: string;
  topicName?: string;
  // Present members' folders in order, and the one the editor, git and a spawn
  // run against. Null when no member is present; `folderPath` then mirrors "".
  roots?: string[];
  activeRoot?: string | null;
  /** A Topic's home folder, where its new chats run. */
  home?: string | null;
  spaceName: string;
  projectName: string;
  projectPath: string;
  // The branch-unit's working folder: the anchor every path consumer uses.
  folderPath: string;
  branch: string;
  projectKind: string;
  agent?: string;
  // Which account of `agent` the selected session belongs to; `null` is the
  // default profile. Required so a selection that reaches a spawn cannot omit
  // it and resume somebody else's session under the wrong login.
  profile: string | null;
  sessionId?: string;
  sessionPath?: string;
  // What a file-addressed adapter resumes with; equals sessionPath.
  sessionFile?: string;
  // The session's recorded cwd: where a resume should spawn (Phase 4).
  sessionCwd?: string;
  sessionTitle?: string;
  sessionName?: string | null;
};

// How many branch-units a project card shows before it truncates. Six is about
// what a card can hold without becoming a wall, and it covers a repo's usual
// working set; everything past it is one click away, and never hidden from the
// rollups (the truncation row reports for what it hides).
const BRANCH_CAP = 6;

const LS_EXPANDED = "tori.expanded.v1";
const LS_ACTIVE_SPACE = "tori.active-space.v1";
const LS_MODE = "tori.sidebar-mode.v1";
// Bump the suffix when `ResolvedConfig` changes shape: a cached copy from an
// older build is rendered before the fresh one arrives.
const LS_CONFIG = "tori.sidebar-config.v1";

// What the column shows: the Spaces tree or the Topic list. The filter field,
// the dialogs and the selection are shared; the tree and the space rail are
// unmounted in the other rather than hidden.
type SidebarMode = "spaces" | "topics";
// The order the segments sit in, which is also the order the toggle steps through.
const MODE_VALUES: SidebarMode[] = ["spaces", "topics"];

function loadMode(): SidebarMode {
  try {
    const stored = localStorage.getItem(LS_MODE);
    return MODE_VALUES.find((m) => m === stored) ?? "spaces";
  } catch {
    return "spaces";
  }
}

function loadCachedConfig(): ResolvedConfig | null {
  try {
    const cfg = JSON.parse(localStorage.getItem(LS_CONFIG) ?? "null");
    return Array.isArray(cfg?.spaces) ? cfg : null;
  } catch {
    return null;
  }
}

function loadActiveSpace(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE_SPACE);
  } catch {
    return null;
  }
}

// Two of the four key prefixes are gone with the session rows: `u:` (a branch
// unit, a leaf now) and `h:` (its Historical sub-section, the History panel's
// business). They are dropped on load rather than migrated, so the next toggle
// writes the set back without them; a stored set that is never touched again
// simply keeps a few strings nothing reads.
const DEAD_KEY = /^[uh]:/;

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_EXPANDED);
    if (raw) return new Set<string>((JSON.parse(raw) as string[]).filter((k) => !DEAD_KEY.test(k)));
  } catch {
    // ignore
  }
  return new Set<string>();
}

export default function LeftSidebar(props: {
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
  // Moves a Topic's active member; the selection itself stays a Topic.
  onActiveRoot?: (root: string | null) => void;
  liveTabs?: LiveTab[];
  /** The sidebar is hidden but the space rail stays: draw the rail alone. */
  railOnly?: boolean;
}) {
  // Seeded from the last load so the tree paints at once: a cold `get_config`
  // probes every project with git. The side effects in `loadConfig` run only on
  // the fresh result, never on this copy.
  const [config, setConfig] = createSignal<ResolvedConfig | null>(loadCachedConfig());
  // Every Topic record, for the "in <Topic>" chip on a member unit row.
  // Latest request wins, as in `TopicList`.
  const [topics, setTopics] = createSignal<Topic[]>([]);
  createEffect(() => noteTopics(topics()));
  let topicsSeq = 0;
  async function loadTopics() {
    const mine = ++topicsSeq;
    const list = (await invoke<Topic[] | null>("list_topics").catch(() => null)) ?? [];
    if (mine === topicsSeq) setTopics(list);
  }
  function applyTopic(topic: Topic) {
    setTopics((prev) => {
      const i = prev.findIndex((f) => f.id === topic.id);
      if (i < 0) return [...prev, topic];
      const next = prev.slice();
      next[i] = topic;
      return next;
    });
  }

  // Errors surface as auto-dismissing toasts (bottom-right) rather than a banner
  // pinned above the tree. setError keeps its old signature so all call sites are
  // unchanged; the stack itself moved to components/Toasts (#105), where the
  // empty-string no-op (the old "clear the banner" idiom) now lives too.
  function setError(msg: string, kind: "error" | "info" = "error", action?: ToastAction) {
    pushToast(msg, kind, action);
  }
  const [expanded, setExpanded] = createSignal<Set<string>>(loadExpanded());
  // Per-project origin URL, keyed by project path: gates whether the add-branch
  // dialog fetches and folds in remote branches, and whether the menu offers to
  // change an origin or to set a first one.
  //
  // The URL rather than a flag, because the forge chip has to tell a GitHub
  // remote from a GitLab one, and a boolean can only tell it from nothing. A
  // missing key is "not probed yet" and a `null` value is "probed, no origin";
  // `forgeChip` reads the difference so a launch does not flash every row inert.
  const [origins, setOrigins] = createSignal<Record<string, string | null>>({});
  // Shared entries a container's worktrees never received, per container. Only
  // a non-zero count is drawn: an always-present "0 missing" would be noise on
  // every project, the same rule the Problems tab follows.
  const [sharedGaps, setSharedGaps] = createSignal<Record<string, number>>({});
  // Per-project fan-out attempts, keyed by project path. Git already reports an
  // attempt's worktree; this is only what git has no field for (its group and
  // its goal), so it is fetched alongside the config rather than folded into it.
  const [attempts, setAttempts] = createSignal<Record<string, AttemptRecord[]>>({});
  const [query, setQuery] = createSignal("");
  // The filter is behind a toggle now. Closing clears it: a tree filtered by a
  // field nobody can see is a tree that has lost rows for no stated reason.
  const [searching, setSearching] = createSignal(false);
  function closeSearch() {
    setQuery("");
    setSearching(false);
  }
  const [chosenMode, setMode] = createSignal<SidebarMode>(loadMode());
  // With no project there is no Topics tile to leave Topics by.
  const mode = (): SidebarMode => (topicsReachable() ? chosenMode() : "spaces");
  /** What the filter field is filtering, which is whatever the mode is showing. */
  const filterNoun = () => (mode() === "topics" ? "topics" : "projects");
  /** What the tree's heading says, which is whatever the strip has lit. */
  const headingName = () => (mode() === "topics" ? "Topics" : (activeSpace()?.name ?? "Spaces"));
  createEffect(() => {
    try {
      localStorage.setItem(LS_MODE, chosenMode());
    } catch {
      // ignore quota
    }
  });
  let searchEl: HTMLInputElement | undefined;

  // Spaces are "spaces" (Arc-style): shown as an icon strip at the bottom, one
  // active at a time, and the tree renders only the active space's projects.
  // The FULL list (never q-filtered) so the space strip is stable while filtering.
  const visibleSpaces = () => config()?.spaces ?? [];
  const hasSpaces = () => visibleSpaces().length > 0;
  const hasProjects = () => visibleSpaces().some((g) => g.projects.length > 0);
  // Assumed until config loads, so a cold start in Topics does not flash the
  // empty Spaces tree first.
  const topicsReachable = () => !config() || hasProjects();

  // The active space. Persisted by name; falls back to the first space when the
  // stored name is gone (e.g. the active space was deleted), so it self-heals.
  const [activeSpaceName, setActiveSpaceName] = createSignal<string | null>(loadActiveSpace());
  createEffect(() => {
    const n = activeSpaceName();
    try {
      if (n) localStorage.setItem(LS_ACTIVE_SPACE, n);
    } catch {
      // ignore quota
    }
  });
  const activeSpace = (): Space | null => {
    const gs = visibleSpaces();
    return gs.find((g) => g.name === activeSpaceName()) ?? gs[0] ?? null;
  };
  const activeProjects = () => (activeSpace()?.projects ?? []).filter(projectVisible);

  // Where a right-click on the tree's empty area put the space menu, and the
  // one thing that opens it. Anchor mode rather than a wrapping ContextMenu:
  // the trigger would swallow every row's own menu on the way past.
  const [spaceAnchor, setSpaceAnchor] = createSignal<{ x: number; y: number }>();

  // A right-click nobody claimed belongs to the space. Kobalte's trigger stops
  // the ones it takes (see ContextMenu on nesting), and the guard covers a
  // plain handler that only prevents, so what reaches here is the empty area.
  function onSpaceAreaMenu(e: MouseEvent) {
    if (e.defaultPrevented || !activeSpace()) return;
    e.preventDefault();
    setSpaceAnchor({ x: e.clientX, y: e.clientY });
  }

  // Every selection is also the bookmark for the way back to it: its space, or
  // the Topic slot.
  createEffect(() => rememberSelection(props.selected));

  // Which unit of `p` a folder means. A worktree owns its folder, but a plain
  // repo's branch-units all share the repository's, so there the branch is the
  // identity: take the one named, else the checkout, and only then the first row.
  function unitAt(p: Project, folderPath: string, branch?: string | null): BranchUnit | undefined {
    const here = p.branchUnits.filter((u) => sameCwd(u.folderPath, folderPath));
    if (here.length < 2) return here[0];
    return (
      (branch ? here.find((u) => unitLabel(u) === branch) : undefined) ??
      here.find((u) => u.isCurrent) ??
      here[0]
    );
  }

  // Re-read from the live tree, so a folder that is gone restores nothing
  // rather than a ghost. No `ensureBranch`: navigating must not check anything
  // out behind a click that only said "show me that".
  function restoreUnit(g: Space): boolean {
    const back = rememberedUnit(g.name);
    if (!back) return false;
    const p = g.projects.find((p) => unitAt(p, back.folderPath, back.branch));
    const u = p && unitAt(p, back.folderPath, back.branch);
    if (!p || !u) return false;
    if (unitSelected(u)) return true;
    traceSwitchStart("worktree", u.folderPath);
    props.onSelect({
      ...back,
      spaceName: g.name,
      projectName: p.name,
      projectPath: p.path,
      folderPath: u.folderPath,
      branch: unitLabel(u),
      projectKind: u.kind,
      // A selection persisted before accounts existed has no profile field, so
      // it reads as the default account, which is what it ran as.
      profile: back.profile ?? null,
    });
    return true;
  }

  // The last Topic, re-resolved against the live records: the stored copy is
  // a snapshot, and its members may have come or gone since.
  function restoreTopic(): boolean {
    const back = rememberedTopic();
    const f = back?.topicId ? topics().find((f) => f.id === back.topicId) : null;
    if (!f) return false;
    if (props.selected?.kind === "topic" && props.selected.topicId === f.id) return true;
    selectTopic(f, back!.activeRoot ?? null);
    return true;
  }

  // Switching space switches the work, not just the tree. Nothing remembered
  // means nothing selected: leaving the previous space's worktree open is the
  // bug this fixes, the sidebar showing one context and every pane another.
  function switchSpace(g: Space) {
    if (activeSpaceName() === g.name) return;
    setActiveSpaceName(g.name);
    if (!restoreUnit(g)) props.onSelect(null);
  }

  // The strip lights one thing at a time, so a space tile answers for both axes:
  // it names the space AND says the tree is showing spaces. From another mode
  // the space is set first, and `switchMode` restores into it.
  function openSpace(g: Space) {
    if (mode() === "spaces") return switchSpace(g);
    setActiveSpaceName(g.name);
    switchMode("spaces");
  }

  // The mode is how you browse, not which work is open, so an empty memory
  // leaves the selection alone here rather than clearing it.
  function switchMode(next: SidebarMode) {
    setMode(next);
    if (next === "topics") restoreTopic();
    else {
      const g = activeSpace();
      if (g) restoreUnit(g);
    }
  }

  // In-app replacement for window.prompt (unimplemented in WKWebView). Holds the
  // pending request plus its resolver; askText opens the modal and awaits an
  // answer, resolving with the entered string or null on cancel.
  const [promptReq, setPromptReq] = createSignal<{
    title: string;
    initial: string;
    note?: string;
    resolve: (v: string | null) => void;
  } | null>(null);
  function askText(title: string, initial = "", note?: string): Promise<string | null> {
    return new Promise((resolve) => setPromptReq({ title, initial, note, resolve }));
  }
  function resolvePrompt(v: string | null) {
    const req = promptReq();
    setPromptReq(null);
    req?.resolve(v);
  }

  // Async yes/no confirmation (see ConfirmDialog): the in-app replacement for
  // window.confirm, resolving true on confirm and false on cancel.
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  function askConfirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }
  function resolveConfirm(v: boolean) {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  }

  // In-app single-select picker (see PickerModal). Mirrors askText: askPick
  // opens the picker over `items` and awaits a choice, resolving with the
  // selected string or null on cancel. Select-only: the attach flows that used
  // its `creatable` and `reserve` modes have their own dialog now, and what is
  // left here picks from a fixed list.
  const [pickReq, setPickReq] = createSignal<{
    title: string;
    items: string[];
    resolve: (v: string | null) => void;
  } | null>(null);
  function askPick(title: string, items: string[]): Promise<string | null> {
    return new Promise((resolve) => setPickReq({ title, items, resolve }));
  }
  function resolvePick(v: string | null) {
    const req = pickReq();
    setPickReq(null);
    req?.resolve(v);
  }

  // The delete-space confirmation. Opened with provisional entry names from the
  // tree; the async preview (flags + size) and the running-agent count fill in.
  type SpacePreview = { sizeBytes: number; entries: DeleteEntry[] };
  // The worktree removal confirmation. Opened with the unit + repo; dirty/unpushed
  // fill in async from `worktree_status`, `busy` gates the buttons during removal.
  const [wtReq, setWtReq] = createSignal<{
    p: Project;
    u: BranchUnit;
    dirty: boolean | null;
    unpushed: boolean | null;
    hasRemote: boolean | null;
    runningCount: number;
    busy: boolean;
  } | null>(null);

  // The branch removal confirmation (plain-repo branch units). Mirrors wtReq:
  // unpushed/hasRemote fill in async from `branch_status`, `busy` gates the buttons.
  const [brReq, setBrReq] = createSignal<{
    p: Project;
    u: BranchUnit;
    unpushed: boolean | null;
    hasRemote: boolean | null;
    busy: boolean;
  } | null>(null);

  // The "Initialize git" dialog for a non-git folder (branch + optional origin +
  // layout). `busy` gates the buttons while init runs.
  const [initReq, setInitReq] = createSignal<{ p: Project; busy: boolean } | null>(null);

  // The space-level "New…" dialog: create an empty folder, clone a repo, or
  // bootstrap a bare + worktree project, chosen by a segmented control.
  const [newReq, setNewReq] = createSignal<{ g: Space; busy: boolean } | null>(null);

  // The space create/edit dialog (icon picker). "new" creates a folder under the
  // root; "edit" only rewrites the `[[space]]` icon (keyed by `name`), so the
  // name is immutable there. `busy` gates double-submit like the sibling dialogs.
  const [spaceReq, setSpaceReq] = createSignal<{
    mode: SpaceDialogMode;
    name: string;
    icon: string | null;
    color: string | null;
    busy: boolean;
  } | null>(null);

  // The project icon dialog. Holds the project itself rather than a copy of its
  // icon fields, so a re-discovery while the dialog is open cannot leave the
  // picker showing a state the tree has already moved past.
  const [iconReq, setIconReq] = createSignal<{ p: Project; busy: boolean } | null>(null);
  const [agentsReq, setAgentsReq] = createSignal<Project | null>(null);

  // The origin dialog, for a repo that has one and for a repo that does not:
  // setting a first origin and replacing an existing one are the same command
  // and the same question, and the dialog tells them apart by `current`.
  const [originReq, setOriginReq] = createSignal<{
    p: Project;
    current: string | null;
    busy: boolean;
  } | null>(null);

  // The add-branch / add-worktree dialog. `remotes` is read off disk when it
  // opens and refreshed by the `git://fetch-done` handler, which is what
  // `fetching` reports while a fetch this dialog asked for is in flight.
  // `deleting` is the row whose delete is waiting to be confirmed.
  const [branchReq, setBranchReq] = createSignal<{
    p: Project;
    mode: "branch" | "worktree";
    locals: string[];
    remotes: string[];
    taken: string[];
    fetching: boolean;
    deleting: { branch: string; unpushed: boolean | null; busy: boolean } | null;
    busy: boolean;
    prefill?: string;
    baseDefault?: string;
    issues: boolean;
  } | null>(null);

  // Drag-to-reorder state for the space tiles.
  // `dragSpace` is the name being dragged; `dropHint` marks the tile the drop
  // would land before/after, for the insertion indicator.
  const [dragSpace, setDragSpace] = createSignal<string | null>(null);
  const [dropHint, setDropHint] = createSignal<{ name: string; after: boolean } | null>(null);

  const railed = () => appSettings.appearance.spaceStrip === "side";

  const [deleteReq, setDeleteReq] = createSignal<{
    mode: "space" | "folder" | "project";
    name: string;
    path: string;
    entries: DeleteEntry[];
    loading: boolean;
    runningCount: number;
    sizeBytes: number | null;
  } | null>(null);

  // For folding an absolute path to `~` in the delete confirmation. Read once
  // and kept, rather than per dialog: it cannot change while the app is running,
  // and `""` never folds anything, which is the right answer before it lands.
  const [home, setHome] = createSignal("");
  void homeDir()
    .then((h) => setHome(h.replace(/\/$/, "")))
    .catch(() => {});

  // Live tabs grouped under a folder (prefix match on the tab's workspace).
  // A command tab counts by its cwd: a clone into this space is killed by the
  // delete exactly as a shell here is, so the confirm has to say so.
  //
  // `state === "live"` is the whole of "live" now. Since lazy restore a tab is
  // no longer proof that anything is running: a restored strip is full of
  // entries with nothing behind them, and counting those would tell the user
  // twelve things are running in a folder where nothing is.
  function liveTabsUnder(path: string): LiveTab[] {
    return (props.liveTabs ?? []).filter((t) => t.state === "live" && tabUnderFolder(t, path));
  }

  // How many things are running under `path`: every live shell/agent tab there,
  // plus any pgrep-matched session that no live tab already represents (dedup by
  // the tab's soft sessionId). Live tabs catch shell + fresh-agent tabs that pgrep
  // can't see; the pgrep pass still catches a detached resumed session with no tab.
  //
  // The dedup is the sharp half. It suppresses the probe for every session a tab
  // already names, so before `liveTabsUnder` filtered on state an *inert* tab
  // holding a stored session id hid that session from the probe entirely - and
  // this count is what destructive confirms are worded from.
  //
  // Inclusive on purpose, unlike the tree's own attribution: a Topic agent
  // running in this repo's `.tori/worktrees/` belongs to the Topic, but
  // removing the repo still kills it, so the confirm has to count it.
  async function countRunningAgents(path: string): Promise<number> {
    const tabs = (props.liveTabs ?? []).filter(
      (t) => t.state === "live" && isUnderPath(t.cwd ?? t.workspace, path),
    );
    const tabSessions = new Set(tabs.map((t) => t.sessionId).filter((x): x is string => !!x));
    const nested = await invoke<SessionMeta[]>("list_sessions", { folder: path, inclusive: true }).catch(
      () => [] as SessionMeta[],
    );
    const offTab = nested.filter((s) => !tabSessions.has(s.id) && isUnderPath(s.cwd, path));
    if (offTab.length === 0) return tabs.length;
    // One batch probe for the whole folder: probing each off-tab session on its
    // own is a subprocess per session, which a busy folder pays on every count.
    const detached = await invoke<string[]>("sessions_running", {
      sessions: offTab.map((s) => ({ id: s.id, agent: s.agent ?? "claude" })),
    }).catch(() => [] as string[]);
    return tabs.length + detached.length;
  }

  // The probe, PTY activity and transcript tail all live in `sessionActivity`
  // now: the tray, the dock badge and Phase 5's History panel need the same
  // composition, and none of them should have to mount a sidebar for it. What
  // stays here is feeding it the four things it cannot derive.
  createEffect(() => noteLiveTabs(props.liveTabs ?? []));
  createEffect(() =>
    noteFolderOwners(
      Object.fromEntries(
        (config()?.spaces ?? []).flatMap((g) =>
          g.projects.flatMap((p) =>
            p.branchUnits.map((u) => [u.folderPath, { spaceName: g.name, projectName: p.name }]),
          ),
        ),
      ),
    ),
  );
  // The forge's half of the needs-you pipeline: every branch-unit and whether
  // its pull request wants looking at.
  //
  // Here rather than in the store because the forge status is keyed by *project
  // path* and a session knows only its folder, and this is the one place that
  // holds both. Every space, not just the active one: a failing check on a
  // project you are not currently looking at is exactly the case the tray and
  // the dock badge exist for. (Polling is still active-space-only - this reports
  // whatever the store happens to know, and knows nothing itself.)
  //
  // It reads no dot and no session, so it cannot end up reacting to the statuses
  // it is about to change.
  createEffect(() =>
    noteForgeUnits(
      (config()?.spaces ?? []).flatMap((g) =>
        g.projects.flatMap((p) =>
          p.branchUnits.map((u) => {
            const st = u.branch ? unitStatus(p.path, u.branch) : null;
            return {
              folderPath: u.folderPath,
              projectPath: p.path,
              branch: u.branch,
              kind: u.kind,
              isCurrent: u.isCurrent,
              attention: st !== null && needsAttention(st),
            };
          }),
        ),
      ),
    ),
  );

  // Attention, the one input the store cannot see for itself: it is the sidebar
  // that knows what is selected, and this component that owns the window-focus
  // listener.
  const [windowFocused, setWindowFocused] = createSignal(true);
  createEffect(() => noteAttention(props.selected?.sessionId ?? null, windowFocused()));

  // Turn-level checkpoints (Finding E): snapshot the working tree at each new
  // human prompt, live-tab sessions only, gated by the checkpoints setting.
  // The actual rising-edge detection lives in checkpoints.ts so it can be
  // unit-tested off this component.
  async function refreshCheckpointTicks() {
    if (!appSettings.checkpoints.enabled) return;
    const live = (props.liveTabs ?? []).filter((t) => t.kind === "agent" && t.sessionId);
    if (!live.length) return;
    const allSessions = Object.values(sessions()).flat();
    const ticks = (
      await Promise.all(
        live.map(async (t) => {
          const meta = allSessions.find((s) => s.id === t.sessionId);
          if (!meta) return null;
          const agent = meta.agent ?? "claude";
          const tail = await invoke<{ count: number; last_ts: number }>("session_prompt_tail", {
            path: meta.path,
            agent,
          }).catch(() => null);
          if (!tail) return null;
          return { sessionId: t.sessionId!, repoPath: meta.cwd, promptCount: tail.count, lastPromptTs: tail.last_ts };
        }),
      )
    ).filter((t): t is NonNullable<typeof t> => t != null);
    // Chat sessions checkpoint themselves off their own `turnStarted`, which is
    // the real boundary rather than one inferred from a re-read prompt count.
    // Passing them here keeps the poller's state current without letting it fire
    // a second snapshot for a turn already captured.
    if (ticks.length) await noteCheckpointTicks(ticks, liveChatIds());
  }
  createEffect(on(() => [props.liveTabs, sessions()] as const, () => void refreshCheckpointTicks()));

  // Detached sessions (no live tab) cap at the hollow running dot - working/
  // needs-you both need a real PTY to observe, which only a live tab has. The
  // composition, and the two live lists built on it, are `sessionActivity`'s
  // now; what remains here is rendering them.

  // Rollup helper: the per-state counts among every live session that matches
  // `pred`, for a collapsed branch/project row or a non-active space tile's
  // badge (all four states - waiting, executing, idle, running - each with its
  // own glyph + hue).
  function bubbleFor(pred: (s: LiveSessionStatus) => boolean) {
    return rollupStatuses(liveSessionStatuses().filter(pred));
  }

  // Does this live session belong to `u`? Keyed off the unit row Rust placed
  // it under rather than off a per-row session array, so the rollup does not
  // depend on the rows existing.
  function statusInUnit(s: LiveSessionStatus, u: BranchUnit) {
    return inUnit(s.home, u);
  }

  // No session has a row of its own any more, so a rollup is never a second
  // report of something already on screen: the row that shows it is the only
  // place it appears. Whether to count at all is now purely a question of which
  // *rows* are rendered, which each call site knows.
  function bubbleForUnits(us: readonly BranchUnit[]) {
    return bubbleFor((s) => us.some((u) => statusInUnit(s, u)));
  }

  /// The files a catch-up would fight over, for a tooltip rather than a report.
  ///
  /// The clause above them already counts them ("3 files would conflict"), so
  /// listing every one is a second telling that grows without limit: the list
  /// is unbounded, and twenty of them filled a 280px box twenty lines deep.
  /// Three names answer "which ones" for the cases where that is answerable at
  /// a glance, and the rest is a number again.
  function conflictLines(paths: readonly string[]): string[] {
    const CAP = 3;
    if (paths.length <= CAP) return [...paths];
    return [...paths.slice(0, CAP), `+${paths.length - CAP} more files`];
  }

  // The rollup badge, as every row here wants it: an accessor in, a node out.
  // `StatusBubble` owns the states and their order; this is only the shorthand
  // that keeps a call site reading as the row it belongs to.
  const statusBubble = (get: () => Rollup | null) => <StatusBubble rollup={get} />;

  // The one door a repo needs, on the repo's own row: an account for its host,
  // or a choice between the accounts that host already has.
  //
  // Here rather than on a branch row because neither question is about a branch.
  // Drawn per branch, "add an account" had to be suppressed on all but one row,
  // and the only rule for picking that row was positional: filtering moved the
  // door, truncation hid it behind `+N`, and collapsing the project took it away
  // entirely - which is when a tidy sidebar is hardest to sign in from.
  function forgeDoorNode(p: Project) {
    const door = createMemo(() =>
      forgeDoor({ origin: origins()[p.path], hosts: forgeHosts(), paused: forgePause(p.path) }),
    );
    const connect = () => {
      const d = door();
      return d?.kind === "connect" ? d : null;
    };
    const pickItems = (): MenuItem[] => {
      const repo = forgeRepo(p.path);
      if (repo?.kind !== "pick") return [];
      return [
        { heading: `${repo.host} account` },
        ...repo.candidates.map((a) => ({
          label: forgeAccountName(a),
          onClick: () =>
            void pickForgeAccount(p.path, a.id).catch((e) => setError(forgeErrorMessage(e))),
        })),
      ];
    };
    return (
      <>
        <Show when={connect()}>
          {(c) => (
            <Tooltip
              as="button"
              type="button"
              class={rows.rowGlyph}
              aria-label={`${p.name}: add an account for ${c().host}`}
              label={c().title}
              data-forge-door="connect"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                emitWith<OpenSettings>(OPEN_SETTINGS, { entry: "forge" });
              }}
            >
              <Icon icon={Plug} />
            </Tooltip>
          )}
        </Show>
        {/* Ahead of the doors below, because it outranks them: an account that
            exists and is signed in still cannot see this repo, so "add an
            account" would send the user to fix something that is not broken. */}
        <Show when={forgeOrgNotice(p.path)}>
          {(notice) => (
            <Tooltip
              as="button"
              type="button"
              class={rows.rowGlyph}
              aria-label={`${p.name}: ${notice().message}`}
              label={`${notice().message} ${notice().action}.`}
              data-forge-door="orgUnapproved"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                emitWith<OpenSettings>(OPEN_SETTINGS, { entry: "forge" });
              }}
            >
              <Icon icon={ShieldAlert} />
            </Tooltip>
          )}
        </Show>
        <Show when={door()?.kind === "pickAccount"}>
          {/* The row toggles the project on click, which picking must not also do. */}
          <span onClick={(e) => e.stopPropagation()}>
            <Dropdown
              as="span"
              items={pickItems()}
              placement="bottom-end"
              aria-label={`Pick an account for ${p.name}`}
            >
              <Tooltip
                as="button"
                type="button"
                class={rows.rowGlyph}
                aria-label={`Pick an account for ${p.name}`}
                label="Pick which account this repo uses"
                data-forge-door="pickAccount"
              >
                <Icon icon={UserRound} />
              </Tooltip>
            </Dropdown>
          </span>
        </Show>
      </>
    );
  }

  // Reverse-lookup a session id to its (space, project, unit, session) tuple
  // and select it exactly as clicking its sidebar row would - the notification
  // click handler and the tray's per-session menu entries both focus this way.
  async function selectSessionById(sessionId: string): Promise<boolean> {
    if (selectFromStore(sessionId)) return true;
    // A tray or notification click carries an id and nothing else, and must
    // work whether or not the sidebar ever opened that folder. The live tab
    // hosting the session is what knows where it lives, so on a miss list that
    // one folder and try again rather than sweeping every space.
    const tab = (props.liveTabs ?? []).find((t) => t.sessionId === sessionId);
    if (!tab) return false;
    await fetchSessions(tab.workspace);
    return selectFromStore(sessionId);
  }

  // The store lookup on its own, so the retry above is one call rather than a
  // copy of the walk.
  function selectFromStore(sessionId: string): boolean {
    const hit = findSession(sessionId);
    if (!hit) return false;
    for (const g of config()?.spaces ?? []) {
      for (const p of g.projects) {
        const u = unitAt(p, hit.folder, hit.session.branch);
        if (u) {
          void selectSession(g, p, u, hit.session);
          return true;
        }
      }
    }
    return false;
  }

  // Select the branch-unit that owns `folderPath` (a shell tab's home), the way
  // clicking its branch row would. Used as the tab -> sidebar sync for a tab with
  // no session, and as the fallback when a session tab's session isn't resolvable.
  function selectBranchByFolder(folderPath: string): boolean {
    for (const g of config()?.spaces ?? []) {
      for (const p of g.projects) {
        // No branch to go on: `unitAt` falls back to the checkout, which is the
        // only branch of a plain repo a tab can actually be looking at. The first
        // row would be a different one, and selecting it would ask to check it out.
        const u = unitAt(p, folderPath);
        if (u) {
          void selectUnit(g, p, u);
          return true;
        }
      }
    }
    return false;
  }

  // Select a unit inside `project`, reading the tree loadConfig has just
  // re-discovered rather than the caller's copy of it. A plain repo's branch
  // units all share one folder, so callers there match on the branch.
  function selectUnitIn(project: Project, pick: (u: BranchUnit) => boolean): BranchUnit | undefined {
    for (const g of config()?.spaces ?? []) {
      for (const p of g.projects) {
        if (!samePath(p.path, project.path)) continue;
        const u = p.branchUnits.find(pick);
        if (u) void selectUnit(g, p, u);
        return u;
      }
    }
    return undefined;
  }

  // The reverse of a sidebar selection driving the terminal: the user clicked a
  // terminal tab, so move our selection to match. Load the owning folder's
  // sessions first (the store may not hold a folder outside the active space
  // yet), then select the session; fall back to selecting the branch if it
  // can't be resolved.
  async function focusFromTerminalTab(d: TerminalTabFocused) {
    if (d.sessionId) {
      await fetchSessions(d.folderPath);
      if (await selectSessionById(d.sessionId)) return;
    }
    selectBranchByFolder(d.folderPath);
  }

  // The unit a folder names, and for a worktree project's own folder, which no
  // unit sits in, its checked out unit.
  function locate(folder: string, branch?: string | null) {
    for (const g of config()?.spaces ?? []) {
      for (const p of g.projects) {
        const u = unitAt(p, folder, branch);
        if (u) return { g, p, u };
      }
    }
    for (const g of config()?.spaces ?? []) {
      const p = g.projects.find((p) => samePath(p.path, folder));
      const u = p?.branchUnits.find((u) => u.kind !== "plain" || u.isCurrent);
      if (p && u) return { g, p, u };
    }
    return undefined;
  }

  // A link or a notification: the space shown, the project open, then the
  // session's tab or the unit. Never a checkout, which would change the tree
  // under whatever else is open in that repo behind a click that said "show me".
  async function navigateTo(t: NavTarget) {
    if (t.session && !findSession(t.session) && t.folder) await fetchSessions(t.folder);
    const hit = t.session ? findSession(t.session) : undefined;
    const at = hit ? locate(hit.folder, hit.session.branch) : t.folder ? locate(t.folder) : undefined;
    if (!at) {
      if (t.session && (await selectSessionById(t.session))) return;
      pushToast("That worktree is no longer in Tori.", "info");
      return;
    }
    if (at.u.kind === "plain" && at.u.branch && currentBranch(at.p) !== at.u.branch) {
      pushToast(`${at.p.name} has another branch checked out, so Tori left it as it is.`, "info");
      return;
    }
    setMode("spaces");
    setActiveSpaceName(at.g.name);
    setExpanded(new Set([...expanded(), pkey(at.g, at.p)]));
    if (hit) void selectSession(at.g, at.p, at.u, hit.session);
    else void selectUnit(at.g, at.p, at.u);
  }

  // A History row was acted on. The dropdown has no access to the selection
  // chain (and so to `ensureBranch`'s plain-repo checkout guard), the rename
  // prompt or the delete confirm, so it names the session and the sidebar does
  // exactly what its own row does - one implementation of each action rather
  // than a second copy in the terminal pane.
  async function runSessionAction(d: SessionAction) {
    if (d.action === "open") {
      await selectSessionById(d.sessionId);
      return;
    }
    const hit = findSession(d.sessionId);
    if (!hit) return;
    if (d.action === "rename") await renameSession(hit.session);
    else await deleteSession(hit.session);
  }

  // Every window listener is registered here in the body, not in the async
  // `onMount` below. None of them needs an await, and the five awaited Tauri
  // `listen` calls in there are a window during which an event fired at startup
  // lands on nobody. Tab focus is the one that made this load-bearing: with the
  // sidebar's session rows gone it is the *only* thing that turns a session into
  // the selection, so dropping one leaves the editor's Session panel blank with
  // nothing left to click to fix it.
  onCleanup(onWith<SessionAction>(SESSION_ACTION, (d) => void runSessionAction(d)));
  onCleanup(onWith<NavTarget>(NAVIGATE, (t) => void navigateTo(t)));
  onCleanup(
    onWith<TerminalTabFocused>(TERMINAL_TAB_FOCUSED, (d) => void focusFromTerminalTab(d)),
  );
  // "Delete the branch" from the Pull Requests panel, after it landed one.
  //
  // Routed here rather than done there because this is where the guards live: a
  // dirty worktree, unpushed commits, and agents still running in the folder.
  // The unit's own kind picks which dialog it gets, since a worktree removal is
  // a folder removal and a plain branch is not.
  onCleanup(
    onWith<RemoveBranchUnit>(REMOVE_BRANCH_UNIT, (d) => {
      for (const g of config()?.spaces ?? []) {
        for (const p of g.projects) {
          if (p.path !== d.projectPath) continue;
          const u = p.branchUnits.find((u) => u.branch === d.branch);
          if (!u) continue;
          if (u.kind === "worktree") openRemoveWorktree(p, u);
          else openRemoveBranch(p, u);
          return;
        }
      }
      setError(`No branch unit named "${d.branch}" is open in this project.`);
    }),
  );
  // "New branch from base" in the Pull Requests panel. Routed here for the same
  // reason the removal is: this owns the branch-unit list, and the project's own
  // kind is what says whether it gets a worktree or a branch.
  onCleanup(
    onWith<AddBranchUnit>(ADD_BRANCH_UNIT, (d) => {
      for (const g of config()?.spaces ?? []) {
        for (const p of g.projects) {
          if (p.path !== d.projectPath) continue;
          const kind = projectUnitKind(p);
          if (kind !== "plain" && kind !== "worktree" && kind !== "incomplete") {
            setError(`"${p.name}" has no branches to add to.`);
            return;
          }
          void openBranchDialog(p, kind === "plain" ? "branch" : "worktree", d.base ?? undefined);
          return;
        }
      }
      setError(`No project at "${d.projectPath}" is open here.`);
    }),
  );
  onCleanup(onEvent(SESSIONS_REFRESH, () => refreshSessions()));
  // Deferred to the next frame so focus lands after the sidebar is revealed
  // (App un-hides it on the same event; a synchronous focus would hit a
  // display:none element and be dropped).
  // Opens it when it is closed; the input focuses itself on mount, so this only
  // has to reach for the field when it was already there.
  onCleanup(
    onEvent(FOCUS_SEARCH, () => {
      if (!hasProjects()) return;
      if (!searching()) return setSearching(true);
      requestAnimationFrame(() => searchEl?.select());
    }),
  );
  onCleanup(
    onEvent(TOGGLE_SIDEBAR_MODE, () => {
      if (topicsReachable()) switchMode(MODE_VALUES[(MODE_VALUES.indexOf(mode()) + 1) % MODE_VALUES.length]);
    }),
  );

  function openDeleteSpace(g: Space) {
    setDeleteReq({
      mode: "space",
      name: g.name,
      path: g.path,
      entries: g.projects.map((p) => ({ name: p.name, kind: "repo", dirty: false, unpushed: false })),
      loading: true,
      runningCount: 0,
      sizeBytes: null,
    });
    // Only patch the request if it still targets this space (guards a fast re-open).
    const forThis = (fn: (r: NonNullable<ReturnType<typeof deleteReq>>) => typeof r) =>
      setDeleteReq((r) => (r && r.path === g.path ? fn(r) : r));
    invoke<SpacePreview>("space_delete_preview", { path: g.path })
      .then((pv) => forThis((r) => ({ ...r, entries: pv.entries, sizeBytes: pv.sizeBytes, loading: false })))
      .catch(() => forThis((r) => ({ ...r, loading: false })));
    countRunningAgents(g.path).then((n) => forThis((r) => ({ ...r, runningCount: n })));
  }

  // Open the typed-name confirmation for removing a non-git project folder. Reuses
  // the space delete dialog (same blast-radius preview) with folder wording; the
  // `folder` mode routes confirm to `remove_folder`.
  function openRemoveFolder(p: Project) {
    setDeleteReq({
      mode: "folder",
      name: p.name,
      path: p.path,
      entries: [],
      loading: true,
      runningCount: 0,
      sizeBytes: null,
    });
    const forThis = (fn: (r: NonNullable<ReturnType<typeof deleteReq>>) => typeof r) =>
      setDeleteReq((r) => (r && r.path === p.path ? fn(r) : r));
    invoke<SpacePreview>("space_delete_preview", { path: p.path })
      .then((pv) => forThis((r) => ({ ...r, entries: pv.entries, sizeBytes: pv.sizeBytes, loading: false })))
      .catch(() => forThis((r) => ({ ...r, loading: false })));
    countRunningAgents(p.path).then((n) => forThis((r) => ({ ...r, runningCount: n })));
  }

  // Open the typed-name confirmation for removing a git project (plain repo or
  // worktree container). Uses `project_delete_preview`, whose first entry is the
  // repo root's own uncommitted/unpushed state (a plain repo's key signal); the
  // `project` mode routes confirm to `remove_project`.
  function openRemoveProject(p: Project) {
    setDeleteReq({
      mode: "project",
      name: p.name,
      path: p.path,
      entries: [],
      loading: true,
      runningCount: 0,
      sizeBytes: null,
    });
    const forThis = (fn: (r: NonNullable<ReturnType<typeof deleteReq>>) => typeof r) =>
      setDeleteReq((r) => (r && r.path === p.path ? fn(r) : r));
    invoke<SpacePreview>("project_delete_preview", { path: p.path })
      .then((pv) => forThis((r) => ({ ...r, entries: pv.entries, sizeBytes: pv.sizeBytes, loading: false })))
      .catch(() => forThis((r) => ({ ...r, loading: false })));
    countRunningAgents(p.path).then((n) => forThis((r) => ({ ...r, runningCount: n })));
  }

  // A folder is going away. A unit selection under it clears; a Topic whose
  // active member is under it moves to its next present root and only clears
  // when none remains, so removing one member never closes the Topic.
  function dropSelectionUnder(gone: (folder: string) => boolean) {
    const sel = props.selected;
    if (!sel) return;
    if (sel.kind === "topic") {
      const roots = (sel.roots ?? []).filter((r) => !gone(r));
      if (sel.activeRoot && !gone(sel.activeRoot)) return;
      if (!roots.length) props.onSelect(null);
      else props.onActiveRoot?.(roots[0]);
      return;
    }
    if (gone(sel.folderPath)) props.onSelect(null);
  }

  // Confirmed: tear down PTYs + editor tabs under the target BEFORE the native
  // delete (so no agent writes into a vanishing cwd), then remove the folder and
  // clear the selection if it pointed inside. Routes by mode: a space calls
  // `delete_space`, a plain folder `remove_folder`, a git project `remove_project`.
  async function confirmDeleteSpace() {
    const req = deleteReq();
    if (!req) return;
    setDeleteReq(null);
    emitWith<PurgeUnderPath>(PURGE_UNDER_PATH, { path: req.path });
    const cmd =
      req.mode === "folder" ? "remove_folder" : req.mode === "project" ? "remove_project" : "delete_space";
    try {
      await invoke(cmd, { path: req.path });
      dropSelectionUnder((f) => isUnderPath(f, req.path));
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Persist expansion state so the tree reopens where you left it.
  createEffect(() => {
    try {
      localStorage.setItem(LS_EXPANDED, JSON.stringify([...expanded()]));
    } catch {
      // ignore quota
    }
  });

  async function loadConfig() {
    try {
      const cfg = await invoke<ResolvedConfig>("get_config");
      setConfig(cfg);
      try {
        localStorage.setItem(LS_CONFIG, JSON.stringify(cfg));
      } catch {
        // ignore quota
      }
      setError("");
      // (Re)install the shallow root watch so external folder creates surface.
      invoke("roots_watch_start", { roots: cfg.roots }).catch(() => {});
      // Every row's sync state: the new ones are computed, the departed ones
      // dropped, and the rest left holding what they had. Fire-and-forget, so a
      // slow batch never holds the tree back from rendering.
      void syncUnits(cfg.spaces.flatMap((g) => g.projects.flatMap((p) => p.branchUnits)));
      // Seed the adopted set from the first real discovery (idempotent, and a
      // no-op on empty), so existing folders are never flagged historical.
      const folders = cfg.spaces.flatMap((g) =>
        g.projects.flatMap((p) => p.branchUnits.map((u) => u.folderPath)),
      );
      invoke("seed_adopted", { folders }).catch(() => {});
      // Seed each plain repo's attached-branch set once (origin default, else the
      // checkout), so it shows a sensible branch instead of every local branch.
      const plainRepos = cfg.spaces
        .flatMap((g) => g.projects)
        .filter((p) => p.branchUnits.some((u) => u.kind === "plain"))
        .map((p) => p.path);
      for (const repo of plainRepos) invoke("seed_attached", { repo }).catch(() => {});
      // Populate the per-project origin URL (fire-and-forget) so the remote menu
      // items resolve to the right variant by the time a menu is opened, and the
      // forge chip knows which remotes its API can actually serve.
      void (async () => {
        const map: Record<string, string | null> = {};
        await Promise.all(
          cfg.spaces
            .flatMap((g) => g.projects)
            .filter((p) => {
              const k = projectUnitKind(p);
              return k === "plain" || k === "worktree" || k === "incomplete";
            })
            .map(async (p) => {
              try {
                map[p.path] = await invoke<string | null>("git_origin", { projectPath: p.path });
              } catch {
                map[p.path] = null;
              }
            }),
        );
        setOrigins(map);
      })();
      // Only bare containers link `.shared/` into their worktrees, so only they
      // can have a gap. Read here rather than per render: the answer changes
      // when a worktree is created, which is a config change and lands back in
      // this function.
      void (async () => {
        const map: Record<string, number> = {};
        await Promise.all(
          cfg.spaces
            .flatMap((g) => g.projects)
            .filter((p) => projectUnitKind(p) === "worktree")
            .map(async (p) => {
              map[p.path] = await invoke<number>("shared_drift", { container: p.path }).catch(() => 0);
            }),
        );
        setSharedGaps(map);
      })();
      // Same shape for the fan-out groups: every git project is asked, since the
      // answer is normally an empty list and the call reconciles the map against
      // git, which is what keeps a group whose worktree was removed outside Tori
      // from rendering at all.
      void (async () => {
        const map: Record<string, AttemptRecord[]> = {};
        await Promise.all(
          cfg.spaces
            .flatMap((g) => g.projects)
            .filter((p) => gitProject(p))
            .map(async (p) => {
              try {
                map[p.path] = await invoke<AttemptRecord[]>("list_project_attempts", { root: p.path });
              } catch {
                map[p.path] = [];
              }
            }),
        );
        setAttempts(map);
      })();
    } catch (e) {
      setError(String(e));
    }
  }

  // Open the create-space dialog (needs a root to mkdir under).
  function addSpace() {
    if (!(config()?.roots ?? []).length) return;
    setSpaceReq({ mode: "new", name: "", icon: null, color: null, busy: false });
  }

  // Open the edit-space dialog, prefilled. Keyed by name; only the icon is
  // editable.
  function editSpace(g: Space) {
    setSpaceReq({
      mode: "edit",
      name: g.name,
      icon: g.icon ?? null,
      color: g.color ?? null,
      busy: false,
    });
  }

  // Confirmed: create runs the single `add_space` command (mkdir + icon write +
  // one emit); edit runs `set_space_meta`. Each command emits `config://changed`,
  // which drives the reload, so there is no manual loadConfig here. On failure,
  // surface the error and leave the dialog open.
  async function confirmSpace(opts: { name: string; icon: string | null; color: string | null }) {
    const req = spaceReq();
    if (!req) return;
    setSpaceReq({ ...req, busy: true });
    try {
      if (req.mode === "new") {
        const roots = config()?.roots ?? [];
        if (!roots.length) throw new Error("No base folder configured");
        await invoke("add_space", {
          root: roots[0],
          name: opts.name,
          icon: opts.icon,
          color: opts.color,
        });
      } else {
        await invoke("set_space_meta", { name: req.name, icon: opts.icon, color: opts.color });
      }
      setSpaceReq(null);
    } catch (e) {
      setError(String(e));
      setSpaceReq({ ...req, busy: false });
    }
  }

  // Confirmed: one of two commands, picked by which branch of the choice came
  // back. An uploaded image is passed as its SOURCE path - `set_project_icon_file`
  // copies it into the icon store and returns where it landed, so the config
  // never points at a file the user might later move. Both commands emit
  // `config://changed`, which drives the reload, so there is no loadConfig here.
  async function confirmProjectIcon(choice: { icon?: string; file?: string }) {
    const req = iconReq();
    if (!req) return;
    setIconReq({ ...req, busy: true });
    try {
      if (choice.file) {
        await invoke("set_project_icon_file", { path: req.p.path, source: choice.file });
      } else {
        await invoke("set_project_icon", { path: req.p.path, icon: choice.icon ?? null });
      }
      setIconReq(null);
    } catch (e) {
      setError(String(e));
      setIconReq({ ...req, busy: false });
    }
  }

  // The native picker behind the dialog's upload tile. A cancel is a null, not
  // an error, so the dialog just stays as it was.
  async function pickIconFile(): Promise<string | null> {
    try {
      return (await invoke<string | null>("pick_icon_file")) ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  // Reorder drag lives alongside the tile's existing abs-path drag (which drops a
  // space's project paths into the terminal): the abs-path payload is still set,
  // and `dragSpace` gates the in-bar reorder.
  function onSpaceDragOver(e: DragEvent, g: Space) {
    if (!dragSpace() || dragSpace() === g.name) return;
    e.preventDefault(); // mark this tile a valid drop target
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = railed() ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    setDropHint({ name: g.name, after });
  }

  async function onSpaceDrop(e: DragEvent, g: Space) {
    const from = dragSpace();
    const hint = dropHint();
    setDragSpace(null);
    setDropHint(null);
    if (!from || from === g.name) return;
    e.preventDefault();
    const after = hint?.name === g.name ? hint.after : false;
    // Full new order of space names (persisted so the next reload keeps it).
    const next = visibleSpaces()
      .map((s) => s.name)
      .filter((n) => n !== from);
    let at = next.indexOf(g.name);
    if (at < 0) return;
    if (after) at += 1;
    next.splice(at, 0, from);
    try {
      await invoke("set_space_order", { names: next });
    } catch (err) {
      setError(String(err));
    }
  }

  async function runInTab(g: Space, mode: "clone" | "bare", name: string, url: string) {
    const bad = await claimProjectFolder(g.path, name);
    if (bad) return setError(bad);
    setError("");
    emitWith<OpenJob>(OPEN_JOB, projectJob(mode, g.path, name, url));
  }

  // Open the space-level "New…" dialog.
  function openNewProject(g: Space) {
    setNewReq({ g, busy: false });
  }

  // Confirmed: route by mode. An empty folder is a direct `add_folder` invoke; a
  // clone or bare + worktree runs in a terminal tab (native git progress +
  // ambient auth). url/name pass as positional args (never interpolated), so
  // there is no shell injection.
  async function confirmNewProject(opts: { mode: NewProjectMode; name: string; url: string }) {
    const req = newReq();
    if (!req) return;
    const { g } = req;
    if (opts.mode === "folder") {
      setNewReq({ ...req, busy: true });
      try {
        await invoke("add_folder", { spacePath: g.path, name: opts.name });
        await loadConfig();
        setNewReq(null);
      } catch (e) {
        setError(String(e));
        setNewReq({ ...req, busy: false });
      }
      return;
    }
    // clone / bare open a terminal tab; runInTab validates the name and surfaces
    // its own errors, so close the dialog and hand off.
    setNewReq(null);
    await runInTab(g, opts.mode, opts.name, opts.url);
  }

  async function cleanupStub(u: BranchUnit) {
    const ok = await askConfirm({
      title: "Remove this empty container?",
      message: "Deletes the .bare repository and its folder. Any branches only in it are lost.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("cleanup_incomplete", { path: u.folderPath });
    } catch (e) {
      setError(String(e));
    }
  }

  // No confirm: prune only drops git's records of folders that are already gone.
  async function pruneWorktrees(p: Project) {
    try {
      const n = await invoke<number>("prune_worktree_records", { repoPath: p.path });
      setError(
        n === 0
          ? `${p.name} has no stale worktrees.`
          : `Pruned ${n} stale worktree${n === 1 ? "" : "s"} from ${p.name}.`,
        "info",
      );
    } catch (e) {
      setError(String(e));
    }
  }

  // --- worktree lifecycle ---

  // Open the removal confirmation for a worktree, then fetch its dirty/unpushed
  // status so the dialog can warn about work about to be lost. The teardown of any
  // live PTYs/editor tabs and the actual delete happen on confirm.
  function openRemoveWorktree(p: Project, u: BranchUnit) {
    setWtReq({ p, u, dirty: null, unpushed: null, hasRemote: null, runningCount: 0, busy: false });
    // Count what's running under the worktree (shell tabs + agents), so removal
    // warns before it tears their PTYs down.
    countRunningAgents(u.folderPath).then((n) =>
      setWtReq((r) => (r && r.u.folderPath === u.folderPath ? { ...r, runningCount: n } : r)),
    );
    invoke<{ dirty: boolean; unpushed: boolean; hasRemote: boolean }>("worktree_status", {
      path: u.folderPath,
    })
      .then((s) =>
        setWtReq((r) =>
          r && r.u.folderPath === u.folderPath
            ? { ...r, dirty: s.dirty, unpushed: s.unpushed, hasRemote: s.hasRemote }
            : r,
        ),
      )
      .catch(() =>
        setWtReq((r) =>
          r && r.u.folderPath === u.folderPath
            ? { ...r, dirty: false, unpushed: false, hasRemote: false }
            : r,
        ),
      );
  }

  // Confirmed: tear down any PTYs + editor tabs under the worktree first (so no
  // agent writes into a vanishing cwd). Delete the remote branch first while the
  // local branch's tracking config still exists to resolve it (a failure there is
  // reported but does not abort the removal), then force-remove the worktree,
  // deleting the local branch too when asked. `force` is passed since the dialog has
  // already shown any uncommitted/unpushed warning.
  async function confirmRemoveWorktree(opts: { deleteLocal: boolean; deleteRemote: boolean }) {
    const req = wtReq();
    if (!req) return;
    const { p, u } = req;
    setWtReq({ ...req, busy: true });
    emitWith<PurgeUnderPath>(PURGE_UNDER_PATH, { path: u.folderPath });
    try {
      if (opts.deleteRemote && u.branch) {
        try {
          await invoke("delete_remote_branch", { repo: p.path, branch: u.branch });
        } catch (e) {
          setError(`Remote branch not deleted: ${String(e)}`);
        }
      }
      if (opts.deleteLocal && u.branch) {
        await invoke("remove_worktree_and_branch", {
          repoPath: p.path,
          worktreePath: u.folderPath,
          branch: u.branch,
          force: true,
        });
      } else {
        await invoke("remove_worktree", { repoPath: p.path, worktreePath: u.folderPath, force: true });
      }
      dropSelectionUnder((f) => isUnderPath(f, u.folderPath));
      setWtReq(null);
      await loadConfig();
    } catch (e) {
      setWtReq(null);
      setError(String(e));
    }
  }

  // --- plain-dir git lifecycle ---

  // Open the "Initialize git" dialog for a non-git folder.
  function openInitGit(p: Project) {
    setInitReq({ p, busy: false });
  }

  // Confirmed: initialize git in the folder, in place. `bare` picks the layout (a
  // normal `git init` vs a `.bare` + worktree container); a given URL is set as
  // origin afterward (both layouts support it). Re-discovers on success.
  async function confirmInitGit(opts: { branch: string; url: string; bare: boolean }) {
    const req = initReq();
    if (!req) return;
    const { p } = req;
    setInitReq({ ...req, busy: true });
    try {
      if (opts.bare) {
        await invoke("bare_init", { projectPath: p.path, branch: opts.branch || null });
      } else {
        // git_init returns whether an initial commit was made; a false means git has
        // no identity, so the repo is unborn (branches can't be created yet).
        const committed = await invoke<boolean>("git_init", {
          projectPath: p.path,
          branch: opts.branch || null,
        });
        if (!committed) {
          setError(
            "Repo created, but git has no user.name/user.email set, so no initial commit was made. Configure a git identity, then commit to start creating branches.",
            "info",
          );
        }
      }
      if (opts.url) {
        await invoke("git_remote_add", { projectPath: p.path, url: opts.url });
      }
      setInitReq(null);
      await loadConfig();
    } catch (e) {
      setInitReq(null);
      setError(String(e));
    }
  }

  // Open the origin dialog, on the URL the repo has *now* rather than on the
  // cached one: the map is refreshed per config load, and this is the one place
  // the exact current value is the thing being compared against.
  async function openOrigin(p: Project) {
    let current = origins()[p.path] ?? null;
    try {
      current = await invoke<string | null>("git_origin", { projectPath: p.path });
    } catch {
      /* fall through with whatever the map had */
    }
    setOriginReq({ p, current, busy: false });
  }

  // Confirmed: point origin at the new URL. `git_remote_add` does a set-url when
  // origin already exists, so the same command sets a first one and replaces an
  // existing one. Note: remote-tracking refs (refs/remotes/origin/*) keep their
  // old state until the next fetch; pointing at a *different* repo leaves stale
  // tracking branches (and any worktree upstreams) until you fetch.
  async function confirmOrigin(url: string) {
    const req = originReq();
    if (!req) return;
    setOriginReq({ ...req, busy: true });
    try {
      await invoke("git_remote_add", { projectPath: req.p.path, url });
      setOrigins((m) => ({ ...m, [req.p.path]: url }));
      setOriginReq(null);
    } catch (e) {
      setOriginReq(null);
      setError(String(e));
    }
  }

  // --- plain-repo branch actions (attach/detach model) ---

  const hasOrigin = (p: Project) => (origins()[p.path] ?? null) !== null;

  /** Whether a fetch on `repo` is news for the open picker. A container's fetch
   *  is reported once for the container when Tori ran it and once per folder in
   *  it when the sweep did, and both mean the same refs moved. */
  const coversPicker = (req: NonNullable<ReturnType<typeof branchReq>>, repo: string) =>
    req.p.path === repo || req.p.branchUnits.some((u) => u.folderPath === repo);

  // Repos already warned about a missing credential helper, so the notice fires
  // once per session, not on every fetch.
  const helperWarned = new Set<string>();

  // Kick the loud fetch, the one that may stop and ask: a one-time (per session)
  // warning when no credential helper will cache the login, then the fetch
  // itself. The git://fetch-done handler folds what lands into the open picker.
  function beginBackgroundFetch(repo: string) {
    if (!helperWarned.has(repo)) {
      helperWarned.add(repo);
      invoke<boolean>("git_has_credential_helper", { repo })
        .then((has) => {
          if (!has) {
            setError(
              "No git credential helper configured - you'll be prompted every fetch. Configure one (e.g. osxkeychain) to cache credentials.",
              "info",
            );
          }
        })
        .catch(() => {});
    }
    invoke("git_fetch", { repo }).catch((e) => {
      // No thread started, so no done or error event is coming: the picker's
      // own pulse has to be put out from here or it runs forever.
      setBranchReq((r) => (r && coversPicker(r, repo) ? { ...r, fetching: false } : r));
      setError(String(e));
    });
  }

  // Open the add-branch / add-worktree dialog: list what is local and what the
  // last fetch left on disk, both of which are ref reads and neither of which
  // touches the network. One dialog for the two menu rows, because the question
  // is the same and only what is done with the answer differs.
  async function openBranchDialog(p: Project, mode: "branch" | "worktree", prefill?: string) {
    let branches: Branch[];
    try {
      branches = await invoke<Branch[]>("list_branches", { path: p.path });
    } catch (e) {
      return setError(String(e));
    }
    // The remote list used to arrive only with `git://fetch-done`, which made
    // the whole picker wait on a network round trip for refs that were already
    // in `refs/remotes` - and show nothing at all offline. It is a
    // `for-each-ref`: hundreds of branches cost milliseconds.
    const remotes = await invoke<string[]>("list_remote_branches", { repo: p.path }).catch(() => []);
    // What a new branch starts on. Origin's default is the answer nearly every
    // time; a repo with no origin has none, and where HEAD is standing is the
    // next best thing (and what creating a branch did before it was asked).
    const fallback = branches.find((b) => b.current)?.name;
    const baseDefault =
      (await invoke<string | null>("repo_default_branch", { repo: p.path }).catch(() => null)) ??
      fallback;
    // A branch the tree already shows is listed but refused: it is still an
    // answer to "which branches are there" and not one to "which do you want".
    const shown = mode === "worktree" ? "worktree" : "plain";
    const issues = await invoke<boolean>("issues_source", { projectPath: p.path }).catch(() => false);
    setBranchReq({
      p,
      mode,
      locals: branches.map((b) => b.name),
      remotes,
      taken: p.branchUnits.filter((u) => u.kind === shown && u.branch).map((u) => u.branch as string),
      fetching: false,
      deleting: null,
      busy: false,
      prefill,
      baseDefault,
      issues,
    });
    // Quiet and floored at the schedule's cadence, so opening the picker on a
    // container the sweep just covered costs nothing and can never stop to ask
    // for a password. What lands folds in; nothing waits on it. The header's
    // own Fetch is the one that goes and looks properly.
    if (hasOrigin(p)) fetchRootIfStale(p.path);
  }

  // The picker's Fetch: the loud one, with the askpass bridge behind it, for
  // when the branch you are looking for is not in the list. `fetching` is set
  // here rather than on the quiet fetch above because this is the only one that
  // is certain to report back.
  function fetchForBranchDialog() {
    const req = branchReq();
    if (!req || req.fetching) return;
    setBranchReq({ ...req, fetching: true });
    beginBackgroundFetch(req.p.path);
  }

  /** Rewrite the armed delete, if it is still the one that asked. */
  const forDeleting = (branch: string, fn: (d: { branch: string; unpushed: boolean | null; busy: boolean }) => typeof d) =>
    setBranchReq((r) => (r?.deleting?.branch === branch ? { ...r, deleting: fn(r.deleting) } : r));

  // Arm the picker's delete: the confirm strip goes up at once and the one fact
  // that decides whether this is safe - commits the remote has never seen -
  // fills in behind it, exactly as the tree's own removal dialog does it.
  function askDeleteBranchInPicker(branch: string) {
    const req = branchReq();
    if (!req || req.deleting) return;
    setBranchReq({ ...req, deleting: { branch, unpushed: null, busy: false } });
    invoke<{ unpushed: boolean; hasRemote: boolean }>("branch_status", { repo: req.p.path, branch })
      .then((s) => forDeleting(branch, (d) => ({ ...d, unpushed: s.unpushed })))
      .catch(() => forDeleting(branch, (d) => ({ ...d, unpushed: false })));
  }

  // Confirmed: `git branch -D` through the same command the tree's removal uses,
  // then re-read the branch list rather than splicing the row out, because the
  // delete also prunes the store entry and the truth is cheap to ask for.
  async function confirmDeleteBranchInPicker() {
    const req = branchReq();
    const deleting = req?.deleting;
    if (!req || !deleting || deleting.busy) return;
    setBranchReq({ ...req, deleting: { ...deleting, busy: true } });
    try {
      await invoke("delete_branch", { repo: req.p.path, branch: deleting.branch });
    } catch (e) {
      setBranchReq((r) => (r ? { ...r, deleting: null } : r));
      return setError(String(e));
    }
    const locals = await invoke<Branch[]>("list_branches", { path: req.p.path })
      .then((bs) => bs.map((b) => b.name))
      .catch(() => req.locals.filter((name) => name !== deleting.branch));
    setBranchReq((r) => (r ? { ...r, locals, deleting: null } : r));
  }

  /** The container's Worktree settings page, as an editor tab. The container
   *  the tab's id, so the page reads the right one wherever the tab lands. */
  function openSharedFiles(p: Project) {
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("shared", p.path) });
  }


  // Confirmed. Where the branch was found is what says how to add it, and the
  // dialog carries that rather than this re-deriving it from the name: a local
  // branch attaches, a remote-only one attaches with tracking, and a name that
  // is neither is created on the base the dialog names and checked out.
  async function confirmAddBranch(pick: BranchPick) {
    const req = branchReq();
    if (!req) return;
    const { p, mode } = req;
    setBranchReq({ ...req, busy: true });
    try {
      if (pick.issue) return await startFromIssue(p, mode, pick, pick.issue);
      if (mode === "worktree") {
        // create_worktree DWIMs the target itself (an existing local checks out,
        // a remote-only name is tracked, a brand-new name starts a branch off
        // `base`, or off origin's default when there is none), so the kind is
        // the dialog's business here and not this command's. It answers the
        // folder it made, which is the only thing that tells one worktree row
        // from another.
        const folder = await invoke<string>("create_worktree", {
          repoPath: p.path,
          branch: pick.name,
          base: pick.base ?? null,
        });
        setBranchReq(null);
        await loadConfig();
        const unit = selectUnitIn(p, (u) => samePath(u.folderPath, folder));
        if (unit) emitWith<NewChatAt>(NEW_CHAT_AT, { folderPath: unit.folderPath, projectName: p.name });
        return;
      }
      if (pick.kind === "remote") {
        await invoke("attach_remote_branch", { repo: p.path, branch: pick.name });
      } else if (pick.kind === "local") {
        await invoke("attach_branch", { repo: p.path, branch: pick.name });
      } else {
        await invoke("new_branch", { repo: p.path, branch: pick.name, base: pick.base ?? null });
        await invoke("git_checkout", { repoPath: p.path, branch: pick.name });
      }
      setBranchReq(null);
      await loadConfig();
      // Naming a branch that did not exist is asking to work on it, and git is
      // already on it: land the selection there too. Attaching an existing
      // branch is not, and selecting it would raise the checkout confirm.
      if (pick.kind === "new") selectUnitIn(p, (u) => u.branch === pick.name);
    } catch (e) {
      setBranchReq(null);
      setError(errorText(e));
    }
  }

  // Started from an issue. Linking goes first because the host makes the
  // branch; after that it is added like any other branch, tracking the one the
  // host made, then the unit remembers its issue and opens on a draft of it.
  async function startFromIssue(
    p: Project,
    mode: "branch" | "worktree",
    pick: BranchPick,
    from: { issue: Issue; link: boolean },
  ) {
    const { issue, link } = from;
    if (link) {
      const outcome = await invoke<LinkOutcome>("issues_link", {
        projectPath: p.path,
        key: issue.key,
        branch: pick.name,
        base: pick.base ?? null,
      });
      if (outcome === "unlinked") {
        setError(`${pick.name} was already on GitHub, so it is not linked to ${issue.display}`, "info");
      }
    }
    let folder = p.path;
    if (mode === "worktree") {
      // No base once linked: with none, `create_worktree` fetches and tracks
      // the matching remote branch, which is the one the host just made.
      folder = await invoke<string>("create_worktree", {
        repoPath: p.path,
        branch: pick.name,
        base: link ? null : (pick.base ?? null),
      });
    } else {
      if (link || pick.kind === "remote") await invoke("attach_remote_branch", { repo: p.path, branch: pick.name });
      else if (pick.kind === "local") await invoke("attach_branch", { repo: p.path, branch: pick.name });
      else await invoke("new_branch", { repo: p.path, branch: pick.name, base: pick.base ?? null });
      await invoke("git_checkout", { repoPath: p.path, branch: pick.name });
    }
    await invoke("issues_record", { projectPath: p.path, branch: pick.name, issue: unitIssueOf(issue) }).catch((e) =>
      setError(errorText(e)),
    );
    setBranchReq(null);
    await loadConfig();
    const unit = selectUnitIn(p, (u) =>
      mode === "worktree" ? samePath(u.folderPath, folder) : u.branch === pick.name,
    );
    emitWith<NewChatAt>(NEW_CHAT_AT, {
      folderPath: unit?.folderPath ?? folder,
      projectName: p.name,
      prompt: issueDraft(issue),
      origin: { display: issue.display, url: issue.url },
    });
  }

  const issueSourceFor = (p: Project): IssueSourceProps => ({
    assigned: () => invoke<IssueRef[]>("issues_assigned", { projectPath: p.path }),
    get: (key) => invoke<Issue>("issues_get", { projectPath: p.path, key }),
    ahead: (base) =>
      invoke<{ unpushed: boolean }>("branch_status", { repo: p.path, branch: base }).then((s) => s.unpushed),
  });

  // Switch the shared working tree to this branch (runs the checkout guard).
  async function checkoutUnit(g: Space, p: Project, u: BranchUnit) {
    await selectUnit(g, p, u);
  }

  // --- fan-out ---

  // A branch stem from the goal, so three attempts at one question read as one
  // family in `git branch` too. Kept to the characters `attempt_folder` accepts
  // verbatim, since the folder is derived from the branch.
  function branchStem(goal: string): string {
    const slug = goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "");
    return slug || "attempt";
  }

  // Fan out: create N attempts at one task, each its own worktree on its own
  // branch, with the dependency directories cloned in.
  //
  // Two questions rather than a dialog: the goal is the one thing git will not
  // record, and the count is the whole rest of the decision. The branches are
  // derived from the goal instead of being typed three times, since attempts are
  // alternatives to be thrown away, not names anyone has to live with.
  //
  // Sequential, not parallel: `git worktree add` takes the repository index
  // lock, so three at once would race for it.
  async function fanOut(p: Project) {
    // An attempt is a worktree on a new branch, and a branch has to start from a
    // commit. Asked before the two questions rather than left to git: the
    // refusal does not depend on the answers, and `git worktree add -b` meets an
    // unborn HEAD with "fatal: invalid reference: HEAD" and a hint about
    // `--orphan`, which is not what anyone here wants. A repo initialized while
    // git had no identity lands in exactly this state (see `confirmInitGit`).
    let head: string;
    try {
      head = await invoke<string>("git_head_sha", { projectPath: p.path });
    } catch (e) {
      return setError(String(e));
    }
    if (!head) {
      return setError(
        `“${p.name}” has no commits yet, so there is nothing for the attempts to branch from. Commit once, then fan out.`,
        "info",
      );
    }

    const goal = await askText(
      "Fan out: what are these attempts for?",
      "",
      "Recorded with the group, so a promotion later can still say what was being attempted.",
    );
    if (goal == null) return; // cancelled
    const what = goal.trim();
    if (!what) return;
    const count = await askPick("How many attempts?", ["2", "3", "4"]);
    if (!count) return;

    const stem = branchStem(what);
    const groupId = `${stem}-${Date.now().toString(36)}`;
    const uncloned = new Set<string>();
    let made = 0;
    for (let i = 1; i <= Number(count); i++) {
      try {
        const created = await invoke<{ path: string; branch: string; uncloned: string[] }>(
          "create_attempt",
          { root: p.path, groupId, goal: what, branch: `${stem}-${i}` },
        );
        created.uncloned.forEach((d) => uncloned.add(d));
        made++;
      } catch (e) {
        // Stop rather than press on: the same failure (a name collision, a
        // locked index) will hit every remaining attempt. The ones already
        // created stay, as a group of however many succeeded.
        setError(`Created ${made} of ${count} attempts. ${String(e)}`);
        break;
      }
    }
    await loadConfig();
    // The group appearing in the tree is the success message. Only the part the
    // tree cannot show is said out loud: a dependency directory that was not
    // cloned, which the user would otherwise meet at the first build.
    if (uncloned.size) {
      setError(
        `Not cloned into the attempts (install them there): ${[...uncloned].join(", ")}`,
        "info",
      );
    }
  }

  // Promote one attempt and discard the rest of its group. The winner is kept
  // exactly as it stands, on its own branch: nothing here merges, and what to do
  // with that branch afterwards is ordinary git work.
  async function promoteAttempt(p: Project, u: BranchUnit, a: AttemptRecord) {
    const losers = (attempts()[p.path] ?? []).filter(
      (x) => x.groupId === a.groupId && !samePath(x.path, a.path),
    );
    const n = losers.length;
    // What is still running inside the attempts about to be deleted. Counted
    // before the confirm, as worktree removal does: a promotion removes with
    // `force`, so nothing further down stops for a live agent, and the tabs are
    // torn down here a moment later.
    const running = (await Promise.all(losers.map((l) => countRunningAgents(l.path)))).reduce(
      (a, b) => a + b,
      0,
    );
    const ok = await askConfirm({
      title: `Promote “${unitLabel(u)}”?`,
      message:
        `“${unitLabel(u)}” is kept as it is, on its own branch and unmerged. ` +
        (n === 0
          ? "It stops being an attempt."
          : `The other ${n} attempt${n === 1 ? "" : "s"} in this group ` +
            `${n === 1 ? "is" : "are"} deleted outright: worktree, branch, sessions and checkpoints. ` +
            (running > 0
              ? `${running} terminal tab${running === 1 ? "" : "s"} or agent${running === 1 ? " is" : "s are"} running in them and will be stopped. `
              : "") +
            "This cannot be undone."),
      confirmLabel: "Promote",
      danger: n > 0,
    });
    if (!ok) return;

    // Tear down PTYs and editor tabs under each loser before it goes, so no
    // agent is left writing into a vanishing cwd (as worktree removal does).
    for (const loser of losers) emitWith<PurgeUnderPath>(PURGE_UNDER_PATH, { path: loser.path });
    try {
      // The recorded path, not the unit's: it is what the backend resolves the
      // group by, and a synthesized unit carries no other identity.
      const problems = await invoke<string[]>("promote_attempt", {
        root: p.path,
        winnerPath: a.path,
      });
      dropSelectionUnder((f) => losers.some((l) => isUnderPath(f, l.path)));
      // Per-loser problems: the promotion itself succeeded, so this is not an
      // error dialog, but each line names a leftover someone has to clear by
      // hand and saying nothing would leave it to be discovered.
      if (problems.length) {
        setError(`Promoted. ${problems.length} attempt(s) did not fully go: ${problems.join("; ")}`);
      }
    } catch (e) {
      setError(String(e));
    }
    await loadConfig();
  }

  // Open the removal confirmation for a plain-repo branch, then fetch its
  // unpushed / has-remote status so the dialog can warn and offer remote deletion.
  function openRemoveBranch(p: Project, u: BranchUnit) {
    if (!u.branch) return;
    const branch = u.branch;
    setBrReq({ p, u, unpushed: null, hasRemote: null, busy: false });
    invoke<{ unpushed: boolean; hasRemote: boolean }>("branch_status", { repo: p.path, branch })
      .then((s) =>
        setBrReq((r) =>
          r && r.u.branch === branch ? { ...r, unpushed: s.unpushed, hasRemote: s.hasRemote } : r,
        ),
      )
      .catch(() =>
        setBrReq((r) =>
          r && r.u.branch === branch ? { ...r, unpushed: false, hasRemote: false } : r,
        ),
      );
  }

  // Confirmed branch removal. Delete the remote branch first (while the local
  // branch's tracking config still resolves it; a failure there is reported but
  // does not abort). Then either delete the local branch (git branch -D + prune the
  // store) or, when local is unchecked, just detach it (drop it from Tori's list,
  // git branch kept). Its sessions re-home onto the current checkout either way.
  async function confirmRemoveBranch(opts: { deleteLocal: boolean; deleteRemote: boolean }) {
    const req = brReq();
    if (!req || !req.u.branch) return;
    const { p, u } = req;
    const branch = u.branch!;
    setBrReq({ ...req, busy: true });
    try {
      if (opts.deleteRemote) {
        try {
          await invoke("delete_remote_branch", { repo: p.path, branch });
        } catch (e) {
          setError(`Remote branch not deleted: ${String(e)}`);
        }
      }
      await invoke(opts.deleteLocal ? "delete_branch" : "detach_branch", { repo: p.path, branch });
      setBrReq(null);
    } catch (e) {
      setBrReq(null);
      setError(String(e));
    }
  }

  // --- session actions, reached from the History dropdown ---

  // Persist a session name (null clears it, reverting to the title). set_session_name
  // now emits sessions://changed, so the terminal tab + any other listener refresh
  // too; the explicit refreshSessions keeps this pane instant rather than waiting
  // for the round-trip.
  async function applySessionName(s: SessionMeta, name: string | null) {
    try {
      await invoke("set_session_name", { id: s.id, name: name?.trim() || null });
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  async function renameSession(s: SessionMeta) {
    const name = await askText("Rename session:", s.name ?? s.title);
    if (name === null) return; // cancelled
    await applySessionName(s, name);
  }

  async function deleteSession(s: SessionMeta) {
    if (isLocked(s.id)) return;
    // A session with no transcript is a different act wearing the same button:
    // its conversation lives wherever its agent keeps it, no protocol verb
    // removes one, and all that happens here is that Tori stops listing it.
    // Saying "its history is removed" there would promise something Tori cannot
    // do, and the promise would be believed.
    const hasTranscript = findAdapter(s.agent ?? "claude").parser_kind != null;
    const ok = await askConfirm({
      title: hasTranscript ? "Delete this session’s transcript?" : "Forget this session?",
      message: hasTranscript
        ? "Its history is removed and cannot be undone."
        : "Tori stops listing it. The agent keeps the conversation, and Tori cannot delete its copy.",
      confirmLabel: hasTranscript ? "Delete" : "Forget",
      danger: true,
    });
    if (!ok) return;
    try {
      // The child goes first, and it is what releases the ownership claim (see
      // `ChatHost::close`). Deleting the file under a live session would leave
      // it writing a transcript nothing lists and holding an id nothing can
      // reclaim - `chat_close` is a no-op for a session that is not live, so
      // this is safe for every session, chat or not.
      await invoke("chat_close", { sessionId: s.id, reason: "killed" }).catch(() => {});
      void invoke("autopilot_closed_by_hand", { session: s.id }).catch(() => {});
      // Any tab driving it closes too, rather than sitting on a transcript that
      // no longer exists.
      emitWith<SessionDeleted>(SESSION_DELETED, { sessionId: s.id });
      await invoke("delete_session", { path: s.path, agent: s.agent ?? "claude" });
      await invoke("checkpoint_prune", { repoPath: s.cwd, sessionId: s.id }).catch(() => {});
      await invoke("hooks_status_prune", { sessionId: s.id }).catch(() => {});
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  // --- per-node context menus ---

  // Which space this menu belongs to, in the space's own glyph and hue. The
  // strip is a row of near-identical tiles and the menu opens at the cursor, so
  // without the header the menu is four rows that never say what they act on.
  const spaceMenuHead = (g: Space) => (
    <span class={styles.spaceMenuHead} style={{ "--space-hue-rgb": spaceHueRgb(g.name, g.color) }}>
      <Show
        when={resolveIcon(g.icon)}
        fallback={<span class={styles.spaceMenuMark}>{spaceInitials(g.name)}</span>}
      >
        {(glyph) => <Icon icon={glyph()} />}
      </Show>
      <span class={styles.spaceMenuName}>{g.name}</span>
    </span>
  );

  // Three groups, in the order the rows are reached for: the two creation paths
  // together at the top, the space's own edit under them, and the destructive
  // row alone at the bottom rather than one row above a benign one.
  //
  // Both creation rows name their target, which is the whole of what "New…" and
  // "Add new space" failed to do while sitting next to each other: one of them
  // creates inside this space, the other creates a sibling of it, and the old
  // labels read as near-synonyms.
  const spaceMenu = (g: Space): MenuItem[] => [
    { heading: spaceMenuHead(g) },
    { separator: true },
    { label: `New in “${g.name}”`, onClick: () => openNewProject(g) },
    { label: "New space", onClick: () => addSpace() },
    { separator: true },
    { label: "Edit space", onClick: () => editSpace(g) },
    { separator: true },
    { label: "Delete space", danger: true, onClick: () => openDeleteSpace(g) },
  ];

  // A project with a working tree git can branch from: a plain repo or a
  // worktree container. Not a non-git folder, and not a bare stub, which has no
  // checkout to attempt anything against.
  const gitProject = (p: Project) => projectUnitKind(p) === "plain" || projectUnitKind(p) === "worktree";

  // What a project's menu is acting on: the icon its row wears, its name, and
  // its kind as a badge. The rows alone never said which of the three menus had
  // opened, nor which row it opened on.
  //
  // The project's own icon rather than a glyph for its kind: the badge already
  // carries the kind, and what the eye is matching against is the row it just
  // right-clicked. `ProjectIcon` resolves it the same way that row does, so the
  // two cannot show different things.
  const projectMenuHead = (p: Project) => {
    const kind = projectUnitKind(p);
    return (
      <span class={styles.projectMenuHead}>
        <ProjectIcon seed={p.path} icon={p.icon} iconFile={p.iconFile} favicon={p.favicon} />
        <span class={styles.projectMenuName}>{p.name}</span>
        <span class={styles.projectMenuBadge}>
          {kind === "plain-dir" ? "Folder" : kind === "plain" ? "Repo" : "Bare"}
        </span>
      </span>
    );
  };

  // Three groups under the header, in the order the rows are reached for: what
  // this kind of project can make, then what it can be pointed at and how it is
  // presented, then the destructive row alone at the bottom.
  //
  // **The destructive row is last, and it is this function that puts it there.**
  // It used to sit mid-list with `Agents…` and `Change icon…` under it, so a
  // click one row low hit delete. Each kind supplies its own removal as the
  // `remove` half of its rows rather than pushing it into the middle of them.
  const projectMenu = (g: Space, p: Project): MenuItem[] => {
    const kind = kindMenu(g, p);
    return [
      { heading: projectMenuHead(p) },
      { separator: true },
      ...kind.rows,
      // No leading separator on a menu whose kind contributed nothing.
      ...(kind.rows.length ? [{ separator: true } as MenuItem] : []),
      // Git kinds only, and one row for both jobs: setting a first origin and
      // replacing an existing one are the same command asking the same
      // question, so the label is all that differs. It keeps the warn
      // treatment it has always had: mutating, but recoverable, which is
      // neither an ordinary row nor the destructive one.
      ...(projectUnitKind(p) === "plain-dir"
        ? []
        : [
            {
              label: hasOrigin(p) ? "Change origin" : "Set origin",
              warn: true,
              onClick: () => void openOrigin(p),
            } as MenuItem,
          ]),
      ...(ruleRows(projectRows(p.path)).length > 1 || projectRows(p.path).length
        ? [{ label: "Agents", onClick: () => setAgentsReq(p) }]
        : []),
      { label: "Change icon", onClick: () => setIconReq({ p, busy: false }) },
      { separator: true },
      kind.remove,
    ];
  };

  // Keyed by git kind: a worktree container spawns worktrees, a plain-dir
  // initializes git, a plain repo branches. `remove` is handed back separately
  // rather than appended here, because `projectMenu` owns where it lands.
  const kindMenu = (g: Space, p: Project): { rows: MenuItem[]; remove: MenuItem } => {
    switch (projectUnitKind(p)) {
      case "worktree":
        return {
          rows: [
            { label: "Add worktree", onClick: () => void openBranchDialog(p, "worktree") },
            { label: "Fan out", onClick: () => fanOut(p) },
            // Beside Add worktree on purpose: the menu that makes worktrees is
            // where you say what they are made with.
            { label: "Worktree settings", onClick: () => openSharedFiles(p) },
            { label: "Prune worktrees", onClick: () => void pruneWorktrees(p) },
          ],
          remove: { label: "Remove project", danger: true, onClick: () => openRemoveProject(p) },
        };
      case "plain-dir": {
        // A non-git folder: it anchors sessions directly (no branch node), so its
        // menu carries the folder-level actions.
        const u = p.branchUnits[0];
        return {
          rows: [
            { label: "New session", onClick: () => startSession(g, p, u) },
            { separator: true },
            { label: "Initialize git", onClick: () => openInitGit(p) },
          ],
          remove: { label: "Remove folder", danger: true, onClick: () => openRemoveFolder(p) },
        };
      }
      case "plain":
        return {
          rows: [
            { label: "Add branch", onClick: () => void openBranchDialog(p, "branch") },
            { label: "Fan out", onClick: () => fanOut(p) },
          ],
          remove: { label: "Remove project", danger: true, onClick: () => openRemoveProject(p) },
        };
      case "incomplete":
        // A bare container with no worktrees (a killed bootstrap, or all worktrees
        // removed). It is still a valid `.bare`, so offer the worktree-container
        // actions to bring one back, plus stub removal.
        return {
          rows: [
            { label: "Add worktree", onClick: () => void openBranchDialog(p, "worktree") },
            { label: "Worktree settings", onClick: () => openSharedFiles(p) },
            { label: "Prune worktrees", onClick: () => void pruneWorktrees(p) },
          ],
          remove: {
            label: "Remove empty container",
            danger: true,
            onClick: () => cleanupStub(p.branchUnits[0]),
          },
        };
      default:
        return {
          rows: [],
          remove: { label: "Remove project", danger: true, onClick: () => openRemoveProject(p) },
        };
    }
  };

  const unitMenu = (g: Space, p: Project, u: BranchUnit): MenuItem[] => {
    // An incomplete stub (a .bare with no worktree): it can still spawn a worktree
    // (its branches live in .bare), so offer that as well as removal.
    if (u.kind === "incomplete") {
      return [
        { label: "Add worktree", onClick: () => void openBranchDialog(p, "worktree") },
        { separator: true },
        { label: "Remove empty container", danger: true, onClick: () => cleanupStub(u) },
      ];
    }
    const items: MenuItem[] = [
      { label: "New session", onClick: () => startSession(g, p, u) },
      { label: "Graph", onClick: () => openGraph(g, p, u) },
    ];
    // Only where the branch is the one checked out, since the reset moves HEAD.
    const checkedOut = u.kind === "worktree" || (u.kind === "plain" && u.isCurrent);
    if (checkedOut && syncFor(u.folderPath, u.branch)?.upstream.superseded) {
      items.push({
        label: "Reset to upstream",
        onClick: async () => {
          if (await resetToUpstream(u.folderPath)) await resyncRoot(u.folderPath);
        },
      });
    }
    if (u.kind === "worktree") {
      items.push({ separator: true });
      items.push({ label: "Remove worktree", warn: true, onClick: () => openRemoveWorktree(p, u) });
    }
    // Plain branch-unit: checkout always; detach/delete only off the current
    // checkout and only when the unit actually has a branch (never the folder fallback).
    if (u.kind === "plain" && u.branch != null) {
      items.push({ separator: true });
      items.push({ label: "Checkout", onClick: () => checkoutUnit(g, p, u) });
      if (!u.isCurrent) {
        items.push({ label: "Remove branch", warn: true, onClick: () => openRemoveBranch(p, u) });
      }
    }
    return items;
  };

  // An attempt's own menu. Deliberately short: an attempt exists to be worked in
  // and then either promoted or discarded with its group, so it carries neither
  // the worktree removal nor the checkout items an ordinary unit has.
  const attemptMenu = (g: Space, p: Project, u: BranchUnit, a: AttemptRecord): MenuItem[] => [
    { label: "New session", onClick: () => startSession(g, p, u) },
    { separator: true },
    { label: "Promote this attempt", warn: true, onClick: () => promoteAttempt(p, u, a) },
  ];

  function toggle(key: string) {
    const next = new Set(expanded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  }

  // The detached tier: every session a scan turned up that no live tab and no
  // chat is hosting. Without this a session started outside Tori stays invisible
  // until someone clicks its row, because nothing else ever probes it.
  function sweepDetached(scans: readonly FolderScan[]) {
    const hosted = new Set<string>(liveChatIds());
    // Only a live tab hosts anything. An inert tab naming a session would keep
    // this sweep from ever probing it, which is exactly the session the sweep
    // exists to find: one running with nothing in Tori driving it.
    for (const t of props.liveTabs ?? []) if (t.sessionId && t.state === "live") hosted.add(t.sessionId);
    const want: { id: string; agent: string }[] = [];
    const seen = new Set<string>();
    for (const { list } of scans) {
      for (const s of list) {
        if (hosted.has(s.id) || seen.has(s.id)) continue;
        seen.add(s.id);
        want.push({ id: s.id, agent: s.agent ?? "claude" });
      }
    }
    // One batched pgrep for the whole sweep. Probing per session would be a
    // subprocess per transcript on disk, paid again on every sessions://changed.
    if (want.length > 0) void probeBatch(want);
  }

  onCleanup(onFolderScan(sweepDetached));

  // What the store must cover, from two independent sources:
  //   * every branch-unit in the active space, so the data does not wait on the
  //     tree being expanded at the right node;
  //   * the folder of every live tab, whatever space it belongs to, because a
  //     tab survives a space switch and its needs-you pipeline must survive it
  //     too.
  // `on` runs its body untracked, which is what keeps reading the store inside
  // trackFolders from re-triggering this on its own write.
  createEffect(
    on(
      () => [activeSpace(), props.liveTabs] as const,
      ([space, tabs]) => {
        void trackFolders([
          ...(space?.projects ?? []).flatMap((p) => p.branchUnits.map((u) => u.folderPath)),
          ...(tabs ?? []).map((t) => t.workspace),
        ]);
      },
    ),
  );

  // The Historical section, its Adopt button and the verdict call that fed them
  // all live in the History dropdown now. The verdict writes to disk (it
  // auto-adopts), so it belongs to whichever surface actually renders that
  // section and to no other - the sidebar asking for it here would adopt
  // folders it no longer shows any ghosts for.

  const pkey = (g: Space, p: Project) => `p:${g.name}/${p.name}`;
  // "Show all branches" for one project, stored in the same expanded-set (and so
  // the same localStorage) as the project and group disclosures: opening a long
  // list is a deliberate act, and it should still be open next launch.
  const mkey = (g: Space, p: Project) => `m:${g.name}/${p.name}`;

  const unitLabel = (u: BranchUnit) => u.branch ?? u.label;
  const currentBranch = (p: Project) =>
    p.branchUnits.find((u) => u.isCurrent)?.branch ?? null;

  // Safe checkout guard (plain repos only). Opening/resuming a branch whose name
  // is not the current checkout would otherwise show the wrong files, so confirm,
  // `git checkout`, and re-discover. Worktrees own their dir and never checkout.
  // Returns false to abort (cancel or a failed/dirty checkout) so the caller
  // leaves the selection and tree untouched.
  async function ensureBranch(p: Project, u: BranchUnit, target: string | null): Promise<boolean> {
    if (u.kind !== "plain" || !target) return true;
    const cur = currentBranch(p);
    if (cur === null || cur === target) return true;
    // Plain-repo checkout is non-destructive to tabs: nothing is killed, but the
    // shared tree changes under any tab open here, so warn with the live count.
    const n = liveTabsUnder(p.path).length;
    const running =
      n > 0
        ? ` ${n} terminal tab${n === 1 ? " is" : "s are"} running here; their files will change to “${target}”.`
        : "";
    const ok = await askConfirm({
      title: `Switch ${p.name} to “${target}”?`,
      message: `This checks out "${target}" (currently "${cur}") and changes the shared working tree.${running}`,
      confirmLabel: "Switch",
    });
    if (!ok) return false;
    try {
      await invoke("git_checkout", { repoPath: p.path, branch: target });
    } catch (e) {
      setError(`Checkout failed: ${String(e)}`);
      return false;
    }
    setError("");
    await loadConfig(); // re-discover: isCurrent + mismatch badges refresh now
    return true;
  }

  async function selectUnit(g: Space, p: Project, u: BranchUnit): Promise<boolean> {
    // The span opens at the click, not at the flip: `ensureBranch` can run a
    // checkout first, and a switch the user waited through is a switch.
    traceSwitchStart("worktree", u.folderPath);
    if (!(await ensureBranch(p, u, u.branch))) return false;
    props.onSelect({
      kind: "unit",
      spaceName: g.name,
      projectName: p.name,
      projectPath: p.path,
      folderPath: u.folderPath,
      branch: unitLabel(u),
      projectKind: u.kind,
      // A unit with no session selected names no account: the profile arrives
      // with the session, since that is the thing an account belongs to.
      profile: null,
    });
    return true;
  }

  // "New session" menu action: select the unit (running the checkout guard), then
  // ask the terminal area to launch a fresh agent session in its folder. Merely
  // selecting the unit only enables the "+ Claude" button, which the label's
  // "New session" promise would not fulfil on its own.
  async function startSession(g: Space, p: Project, u: BranchUnit) {
    if (await selectUnit(g, p, u)) {
      emitWith<NewSession>(NEW_SESSION, { folderPath: u.folderPath, projectName: p.name });
    }
  }

  // "Graph" menu action: select the unit first, exactly as "New session" does.
  // The graph tab is workspace-scoped, and a tab opened into a workspace nobody
  // is looking at would be invisible until you happened to switch back.
  async function openGraph(g: Space, p: Project, u: BranchUnit) {
    if (await selectUnit(g, p, u)) {
      emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("graph", u.folderPath) });
    }
  }

  async function selectSession(g: Space, p: Project, u: BranchUnit, s: SessionMeta) {
    traceSwitchStart("worktree", u.folderPath);
    // A session wants its recorded branch checked out, when it recorded one.
    const target = s.branch || u.branch;
    if (!(await ensureBranch(p, u, target))) return;
    props.onSelect({
      kind: "unit",
      spaceName: g.name,
      projectName: p.name,
      projectPath: p.path,
      folderPath: u.folderPath,
      branch: unitLabel(u),
      projectKind: u.kind,
      agent: s.agent,
      // The index derived this from the root the transcript was found under, so
      // it is the account the session is actually in rather than a guess.
      // Through `asTabProfile`, because the index spells the default account
      // with its real id and a selection spells it `null`.
      profile: asTabProfile(s.profile),
      sessionId: s.id,
      sessionPath: s.path,
      sessionFile: s.path,
      sessionCwd: s.cwd,
      sessionTitle: s.title,
      sessionName: s.name,
    });
    // Probe on selection so the status reflects this session immediately, not
    // just on the next sessions://changed/window-focus trigger.
    void probeSession(s.id, s.agent ?? "claude");
  }

  // A branch-unit reads as selected when it is the direct selection OR when a
  // session under it is (its sessions carry the unit's folderPath + label), so
  // the branch stays highlighted as the context while a session is open.
  // A Topic is never a unit, even while its active member is this very
  // folder: the Topic row is its home, and the chip below points there.
  function unitSelected(u: BranchUnit) {
    const s = props.selected;
    return s != null && s.kind !== "topic" && s.folderPath === u.folderPath && s.branch === unitLabel(u);
  }

  // The Topics this folder is a member of, so a unit row can point back at
  // its other home. Kept here rather than lifted out of `TopicList` because
  // that list mounts only in Topics mode and this chip renders in Spaces.
  function topicsAt(folder: string): Topic[] {
    return topics().filter((f) => f.members.some((m) => !!m.worktreePath && sameCwd(m.worktreePath, folder)));
  }

  // Display only: the probe, forge polling and session homes still see every
  // unit. A selected one stays, for the same reason the branch cap keeps it.
  const inSpaces = (units: BranchUnit[]) =>
    appSettings.git.showTopicWorktrees
      ? units
      : units.filter((u) => unitSelected(u) || topicsAt(u.folderPath).length === 0);

  function selectTopic(f: Topic, preferredRoot: string | null) {
    // Keyed by the workspace key, not the bare id, so the legs the editor
    // reports (which key on the workspace) land on this span.
    traceSwitchStart("topic", topicKey(f.id));
    props.onSelect(topicSelection(f, preferredRoot));
  }

  const gkey = (g: Space, p: Project, groupId: string) => `a:${g.name}/${p.name}/${groupId}`;

  // One branch-unit node. A leaf since the session rows went: sessions are
  // reached from the terminal pane's History dropdown now, so a branch has
  // nothing left to expand and clicking it means one thing - select this unit.
  // Shared by the flat worktree/branch list and by the attempts inside a group,
  // which are the same node one indent deeper.
  function unitNode(g: Space, p: Project, u: BranchUnit, attempt?: AttemptRecord) {
    // One rollup for the row: the glyph's pulse and the status chip are two
    // readings of the same fact, and computing it twice is how they drift.
    const rollup = () => bubbleForUnits([u]);
    const sync = () => syncFor(u.folderPath, u.branch);
    // While an agent holds this row, the row is about the agent. Half of these
    // marks are being rewritten as you read them, since an executing agent is
    // writing files and may be committing, and "uncommitted changes" during an
    // agent run is a mark that is always true and therefore says nothing. The
    // quiet states keep theirs: `idle` and `running` ask nothing of you.
    const held = () => {
      const r = rollup();
      return r.waitingForApproval + r.waitingForAnswer + r.executing > 0;
    };
    // Whether this branch reports a pull request at all. Nothing is drawn in
    // the end cluster for the forge any more: a branch with a PR says so on
    // its second line, and a branch without one says so by not having the
    // line.
    //
    // Read off `chip().kind` rather than off "is there a PR in the store",
    // because that kind has already asked every question a row must ask before
    // it may report anything: the remote is one the API serves, the poller is
    // running, a tick has landed. Asking the store directly would put a line
    // on a row whose poller stopped an hour ago and let it age there in
    // silence, which is the trap `forgeChip` exists to close.
    const showPr = () => chip().kind === "pr";
    const status = () => unitStatus(p.path, u.branch);
    const relation = () => prRelation(u.folderPath, u.branch, status()?.pullRequest, sync());
    // Memoized, not a bare accessor: the row reads it several times and each
    // read would otherwise re-parse the origin URL.
    const chip = createMemo(() =>
      forgeChip({
        origin: origins()[p.path],
        hosts: forgeHosts(),
        branch: u.branch,
        paused: forgePause(p.path),
        status: status(),

        // Zero once answered, undefined until then: a row cannot be told apart
        // from "the base itself" any other way, and guessing zero would put a
        // "ready" mark on every branch for the instant before the batch lands.
        offBase: sync() ? (sync()!.base?.ahead ?? 0) : undefined,
        hasUpstream: sync()?.upstream.has_upstream,
        relation: relation(),
      }),
    );
    const finished = (): FinishedPr | null => {
      const pr = showPr() ? status()?.pullRequest : null;
      return pr && pr.state !== "open" ? { state: pr.state, relation: relation() } : null;
    };
    const marks = createMemo(() => (held() ? [] : syncMarks(sync(), finished())));
    // One hover target for the whole run rather than one per glyph: they are
    // 13px each, none of them is focusable, and the reader wants the branch's
    // standing in one place rather than four hovers to assemble it.
    // What the glyphs mean, and then what the row knows on top of that. The
    // second half was the same weight as the first, which is what made a
    // four-fact tooltip read as a dump.
    const storyLead = () => marks().map((m) => m.title);
    const storyRest = () => {
      const out: string[] = [];
      const at = sync()?.head_committed_at;
      if (at) out.push(`Last commit ${compactAgo(at)}`);
      out.push(...conflictLines(sync()?.base?.conflicts ?? []));
      return out;
    };
    return (
      <BranchRow
        label={unitLabel(u)}
        icon={<UnitIcon kind={u.kind} active={rollup().executing > 0} current={u.isCurrent} />}
        iconLabel={iconLabel(u)}
        selected={unitSelected(u)}
        nested={attempt != null}
        look={finishedLook(finished())}
        menu={attempt ? attemptMenu(g, p, u, attempt) : unitMenu(g, p, u)}
        onClick={() => selectUnit(g, p, u)}
        onDragStart={(e) => startAbsDrag(e, u.folderPath)}
        meta={
          showPr() || (sync()?.base?.stat?.files ?? 0) > 0
            ? <BranchLine status={showPr() ? status()! : null} base={sync()?.base} />
            : undefined
        }
        end={
          <>
            <Show when={u.issue}>
              {(issue) => (
                <Tooltip
                  as="button"
                  type="button"
                  class={rows.issueChip}
                  aria-label={`Open issue ${issue().display}`}
                  label={`${issue().display} ${issue().title}`}
                  data-issue-chip={issue().key}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    void invoke("plugin:opener|open_url", { url: issue().url }).catch(() => {});
                  }}
                >
                  {issue().display}
                </Tooltip>
              )}
            </Show>
            <SyncMarks
              marks={marks()}
              label={<TooltipLines lead={storyLead()} rest={storyRest()} />}
            />
            <For each={topicsAt(u.folderPath)}>
              {(f) => (
                <IconButton
                  size="xs"
                  class={rows.topicChip}
                  icon={<Icon icon={Tag} />}
                  aria-label={`Open Topic ${f.name}`}
                  tooltip={f.name}
                  data-topic-chip={f.id}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    selectTopic(f, u.folderPath);
                    setMode("topics");
                  }}
                />
              )}
            </For>
            {statusBubble(rollup)}
          </>
        }
      />
    );
  }

  // The truncation control at the foot of a long branch list: "N more branches"
  // while the list is cut, "Show less" once it is open.
  //
  // Rendered as a branch node rather than as a footer beside them, so the rail
  // runs through it and stops on it: it is an item in the list, not a caption
  // under one. Being a branch node it takes the rail, the hover pill and the
  // label x for free.
  //
  // `hidden` is an accessor, not an array: the row is created once and its label,
  // glyph and badge track the disclosure from the inside, so toggling never has
  // to recreate the node.
  function moreNode(g: Space, p: Project, hidden: () => BranchUnit[]) {
    const key = mkey(g, p);
    const open = () => expanded().has(key);
    // `end`: a hidden branch has no row of its own to report on, so this one
    // carries the rollup for all of them - the same rule that puts a collapsed
    // project's rollup on its project row. Without it a running agent on the
    // 20th branch would surface nowhere.
    return (
      <MoreRow
        count={hidden().length}
        open={open()}
        onClick={() => toggle(key)}
        end={statusBubble(() => (open() ? null : bubbleForUnits(hidden())))}
      />
    );
  }

  // The unit an attempt renders as. A worktree container already reports one
  // (git listed the worktree); a plain repo lists branches instead, so there the
  // record is all there is and the unit is built from it. `branch` stays null
  // rather than guessing: a name collision puts folder `<stem>-2` on branch
  // `<stem>`, and the folder is the half that is certain.
  function attemptUnit(m: { attempt: AttemptRecord; unit: BranchUnit | undefined }): BranchUnit {
    return (
      m.unit ?? {
        label: attemptFolderName(m.attempt.path),
        folderPath: m.attempt.path,
        branch: null,
        kind: "worktree",
        isCurrent: false,
      }
    );
  }

  // One fan-out group: the goal as the header, its attempts nested beneath.
  // Grouping is the whole point - three attempts at one question are one thing
  // in the tree, not three unrelated worktrees sitting next to `main`.
  function attemptGroupNode(g: Space, p: Project, grp: AttemptGroup<BranchUnit>) {
    const key = gkey(g, p, grp.groupId);
    const open = () => expanded().has(key);
    const units = () => grp.members.map(attemptUnit);
    // Same rollup rule as a project row: everything under a closed group, and
    // nothing under an open one, whose attempt rows each carry their own.
    return (
      <GroupRow
        goal={grp.goal}
        count={grp.members.length}
        open={open()}
        onClick={() => {
          toggle(key);
          // The attempts under it start collapsed, so nothing else would load
          // their sessions and the group would roll up an empty set.
          if (open()) for (const u of units()) void fetchSessions(u.folderPath);
        }}
        end={statusBubble(() => (open() ? null : bubbleForUnits(units())))}
      >
        <Show when={open()}>
          <For each={grp.members}>
            {(m) => unitNode(g, p, attemptUnit(m), m.attempt)}
          </For>
        </Show>
      </GroupRow>
    );
  }

  // --- filtering ---
  // Project names, and nothing else: with the session rows gone there is no
  // session for a match to reveal, and a filter that hid whole projects on the
  // strength of a title you could not then see would be worse than none.
  // Searching sessions is the History dropdown's own field.
  const q = () => query().trim().toLowerCase();
  function projectVisible(p: Project) {
    return !q() || p.name.toLowerCase().includes(q());
  }

  let unlistenConfig: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  let unlistenTrayFocus: UnlistenFn | undefined;
  let unlistenNavOpen: UnlistenFn | undefined;
  let unlistenTopics: UnlistenFn | undefined;
  let unlistenFetchDone: UnlistenFn | undefined;
  let unlistenFetchError: UnlistenFn | undefined;
  let offFocus: (() => void) | undefined;
  let offActivateSpace: (() => void) | undefined;
  onMount(async () => {
    offActivateSpace = onWith<ActivateSpace>(ACTIVATE_SPACE, ({ name }) => setActiveSpaceName(name));
    await invoke("config_watch_start").catch(() => {});
    await invoke("sessions_watch_start").catch(() => {});
    await loadConfig();
    void loadTopics();
    unlistenConfig = await listen("config://changed", () => {
      void loadConfig();
      void loadTopics();
    });
    unlistenTopics = await listen<Topic>("topics://changed", (e) => applyTopic(e.payload));
    unlistenSessions = await listen<SessionsChanged | null>("sessions://changed", (e) => {
      // No explicit tail re-read: the tail-state effect now triggers on the
      // store as well as on liveTabs, so a refresh that changed something
      // already drives one, and a refresh that changed nothing has nothing to
      // re-read - a tail only moves when its transcript does, which is what
      // raised this event.
      //
      // `folders` names what actually moved, so a heartbeat during one
      // streaming session re-lists that session's folder rather than every
      // folder the tree covers. A null payload still means all of them.
      void refreshSessions(e.payload?.folders ?? undefined);
      probeActive();
    });
    // Presence surfaces (phase 3): the tray's per-session menu entries and a
    // needs-you notification both focus the same way a sidebar row click does.
    unlistenTrayFocus = await listen<string>("tray://focus-session", (e) =>
      void selectSessionById(e.payload),
    );
    unlistenNavOpen = await listen<NavTarget>("nav://open", (e) => void navigateTo(e.payload));
    // Window refocus re-probes so a dot clears promptly after e.g. a Ctrl+C
    // exit-to-shell that happened while the window was unfocused (its own
    // transcript write, if any, may already have been debounced away).
    offFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      setWindowFocused(focused);
      if (focused) {
        probeActive();
        // The forge's own focus tick. `startForgePolling` also listens for the
        // DOM focus event; this is the signal the rest of the sidebar has always
        // trusted for a native refocus. Both go through `pollOnFocus`, so
        // whichever wins the race does the same thing, and the 30s per-project
        // gap absorbs the loser.
        void pollOnFocus();
      }
    });
    // Fold remote-only branches into the open add-branch dialog as they land.
    // Guarded on the request still being for this repo, so a late or duplicate
    // fetch-done after a cancel or a reopen cannot resurrect or double a list.
    unlistenFetchDone = await listen<{ repo: string; quiet?: boolean }>("git://fetch-done", async (e) => {
      const forThis = (fn: (r: NonNullable<ReturnType<typeof branchReq>>) => typeof r) =>
        setBranchReq((r) => (r && coversPicker(r, e.payload.repo) ? fn(r) : r));
      if (branchReq() && coversPicker(branchReq()!, e.payload.repo)) {
        const repo = branchReq()!.p.path;
        try {
          const remotes = await invoke<string[]>("list_remote_branches", { repo });
          forThis((r) => ({ ...r, remotes, fetching: false }));
        } catch {
          // Leave the local-only list usable; just stop claiming a fetch.
          forThis((r) => ({ ...r, fetching: false }));
        }
      }
      // Quiet or not: a fetch is the one thing that moves a branch's standing
      // without anybody here touching it, and this event already arrives once
      // per folder in the container.
      void resyncRoot(e.payload.repo);
      // A manual fetch is one repo you just acted on, so reloading the tree is
      // the point of it. The scheduled sweep is every repo at once, where the
      // same call would be one full rediscovery per container, on a timer.
      if (!e.payload.quiet) loadConfig();
    });
    unlistenFetchError = await listen<{ repo: string; error: string; quiet?: boolean }>(
      "git://fetch-error",
      (e) => {
        // A sweep fails on every repo behind a password prompt it refuses to
        // show. That is the expected resting state of those repos, not an error
        // line across the sidebar.
        if (e.payload.quiet) return;
        setError(e.payload.error || "Fetch failed");
        setBranchReq((r) => (r && coversPicker(r, e.payload.repo) ? { ...r, fetching: false } : r));
      },
    );
  });
  onCleanup(() => {
    unlistenConfig?.();
    unlistenTopics?.();
    unlistenSessions?.();
    unlistenTrayFocus?.();
    unlistenNavOpen?.();
    unlistenFetchDone?.();
    unlistenFetchError?.();
    offFocus?.();
    offActivateSpace?.();
  });

  // --- forge polling ---------------------------------------------------------

  // The kill switch, straight from Settings. Read through an effect rather than
  // at mount so switching it off stops the schedule on the click, not on the
  // next launch.
  createEffect(() => noteForgeEnabled(appSettings.forge?.enabled ?? true));

  const [expandedTopics, setExpandedTopics] = createSignal<string[]>([]);
  const watchedTopics = createMemo(() => {
    const open = props.selected?.kind === "topic" ? props.selected.topicId : null;
    const listed = mode() === "topics" ? expandedTopics() : [];
    return topics()
      .filter((t) => t.id === open || listed.includes(t.id))
      .map((topic) => ({ topic, visible: true }));
  });

  // Whether a reference's Topic branch exists, locally or on origin: until it
  // does there is no pull request to look for. Only a yes is kept, since a
  // promotion can make the branch at any time; a no is asked again whenever
  // the watched Topics change, which a promote or a demote always does.
  const [topicBranches, setTopicBranches] = createSignal<Record<string, true>>({});
  const probing = new Set<string>();
  createEffect(() => {
    for (const { topic } of watchedTopics()) {
      for (const m of topic.members.filter(isReference)) {
        const k = `${m.repoPath}\n${topic.branch}`;
        if (untrack(topicBranches)[k] || probing.has(k)) continue;
        probing.add(k);
        void invoke<{ local: boolean; remote: boolean }>("probe_topic_branch", { repoPath: m.repoPath, branch: topic.branch })
          .then((p) => p.local || p.remote)
          .catch(() => false)
          .then((known) => {
            probing.delete(k);
            if (known) setTopicBranches((prev) => ({ ...prev, [k]: true }));
          });
      }
    }
  });

  // What the poller watches, and which of it is on screen.
  //
  // **The active space only.** A tick costs one request per project, so watching
  // every space would multiply the hourly budget by the number of spaces in
  // order to keep chips fresh on rows that are not rendered anywhere. Projects
  // the API cannot serve are filtered out here rather than asked and refused:
  // a GitLab checkout would spend a request to be told `unsupportedRemote`,
  // every tick, forever.
  //
  // `visible` is the project's disclosure, not the row's exact presence. It only
  // orders the ask (the per-tick cap falls on the tail), so the cost of being
  // approximate is that a branch hidden behind "N more branches" is asked about
  // slightly earlier than it deserves - not that anything goes unasked.
  createEffect(() => {
    const g = activeSpace();
    const seen = origins();
    const hosts = forgeHosts();
    const spaces: WatchedProject[] = (g?.projects ?? [])
      .filter((p) => apiCanServe(seen[p.path] ?? null, hosts))
      .map((p) => {
        const open = expanded().has(pkey(g!, p));
        return {
          path: p.path,
          units: p.branchUnits
            .filter((u) => u.branch)
            .map((u) => ({ branch: u.branch, visible: open })),
        };
      });
    const watched = mergeWatched([
      spaces,
      topicProjects(watchedTopics(), (repo, branch) => !!topicBranches()[`${repo}\n${branch}`]).filter((p) =>
        apiCanServe(seen[p.path] ?? null, hosts),
      ),
    ]);
    noteWatchedProjects(watched);
    // The opening tick. `startForgePolling` deliberately does not fire one at
    // mount (nothing is watched yet), so the first ask is here, the moment there
    // is something to ask about. Re-running on every disclosure toggle is safe:
    // `mayPoll` holds each project to one tick per 30 seconds.
    //
    // `untrack` because polling *reads* the store it is scheduling against - the
    // backoff clocks, the auth state, the last-poll stamps. Tracked, this effect
    // would inherit the change rate of all of them and re-run on every failed
    // tick's backoff write, which is the exact shape
    // `lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads` names.
    if (watched.length) untrack(() => void pollNow("focus"));
  });

  onCleanup(startForgePolling());

  // The window's background wash follows the active space. Written as one
  // inline custom property on `<html>` (see utils/spaceTint.ts for why that is
  // safe alongside the theme resolver), and cleared when there is no active
  // space at all so the token layer keeps the last word on an untinted window.
  createEffect(() => {
    const g = activeSpace();
    applySpaceTint(g ? spaceHue(g.name, g.color) : null);
  });
  onCleanup(() => applySpaceTint(null));

  // ---- Each name's own width ----
  //
  // The lit tile does not decide whether it has room; it just takes what is
  // there and ellipsizes. What this measures is only the target its name
  // animates OUT to, one per name: a shared target makes a short name's box
  // reach full width early and then stall for the rest of the duration.
  const [nameW, setNameW] = createSignal<Record<string, number>>({});
  let probeEl: HTMLSpanElement | undefined;
  let probeNameEl: HTMLSpanElement | undefined;
  let probeTextEl: HTMLSpanElement | undefined;

  function measureNames() {
    if (!probeEl || !probeNameEl || !probeTextEl) return;
    const each: Record<string, number> = {};
    for (const name of [...visibleSpaces().map((g) => g.name), "Topics"]) {
      probeTextEl.textContent = name;
      // Rounded up, with a pixel to spare: a fractional target is a target the
      // text does not quite fit into, and the tile clips its own last letter.
      each[name] = Math.ceil(probeNameEl.getBoundingClientRect().width) + 1;
    }
    const prev = nameW();
    const same =
      Object.keys(each).length === Object.keys(prev).length &&
      Object.entries(each).every(([n, w]) => prev[n] === w);
    if (!same) setNameW(each);
  }

  /** The measured target for one tile's name, or nothing while unmeasured -
   *  the stylesheet's own cap stands in until the first pass lands. */
  const nameTarget = (name: string) => {
    const w = nameW()[name];
    return w ? `${w}px` : undefined;
  };

  // Inter is a webfont, so the first measurement can land in the fallback face
  // and report a narrower name than the one that ends up on screen - which the
  // tile then clips, because the target it was given is too small. `loadingdone`
  // as well as `ready`: the set resolves once, and a face can arrive later.
  onMount(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    void fonts.ready.then(() => measureNames());
    const remeasure = () => measureNames();
    fonts.addEventListener("loadingdone", remeasure);
    onCleanup(() => fonts.removeEventListener("loadingdone", remeasure));
  });

  // The other things that move a name's width without touching the names:
  // zoom, and in dev a stylesheet edit. Both show up as the probe's own box
  // changing size, since it keeps the last name it measured. The pass ends on
  // that same name, so the box it leaves is the box it found and the observer
  // does not fire again on its own work. Guarded because jsdom has no observer.
  onMount(() => {
    if (!probeNameEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureNames());
    ro.observe(probeNameEl);
    onCleanup(() => ro.disconnect());
  });

  // The set of names is the other input. After paint, or the probe has no box.
  createEffect(
    on(
      () => visibleSpaces().map((g) => g.name).join(" "),
      () => requestAnimationFrame(() => measureNames()),
    ),
  );

  // The strip's tile for one space. `SpaceTile` owns the shape; what is decided
  // here is the state it wears.
  const spaceTile = (g: Space) => {
    // Lit only while the tree is actually showing this space. In Topics the
    // strip has moved on, and a second lit tile would say the sidebar is
    // showing two things.
    const on = () => mode() === "spaces" && activeSpace()?.name === g.name;
    return (
      <SpaceTile
        name={g.name}
        icon={g.icon}
        color={g.color}
        nameWidth={nameTarget(g.name)}
        active={on()}
        rail={railed()}
        dragging={dragSpace() === g.name}
        dropBefore={dropHint()?.name === g.name && !dropHint()!.after}
        dropAfter={dropHint()?.name === g.name && dropHint()!.after}
        menu={spaceMenu(g)}
        rollup={spaceRollup(g)}
        onClick={() => openSpace(g)}
        onDragStart={(e) => {
          startAbsDrag(e, g.projects.map((p) => p.path));
          setDragSpace(g.name);
        }}
        onDragOver={(e) => onSpaceDragOver(e, g)}
        onDrop={(e) => onSpaceDrop(e, g)}
        onDragEnd={() => {
          setDragSpace(null);
          setDropHint(null);
        }}
      />
    );
  };

  const dockTabCount = () => (props.liveTabs ?? []).filter((t) => isShellsKey(t.workspace)).length;

  // Topics, as a tile in the same strip and on the same rules as a space.
  const modeTile = (m: SidebarMode, label: string, glyph: LucideIcon) => (
    <ModeTile
      label={label}
      glyph={glyph}
      nameWidth={nameTarget(label)}
      active={mode() === m}
      rail={railed()}
      onClick={() => switchMode(m)}
    />
  );

  // A space tile's own rollup: for the inactive spaces, their whole tree is
  // structurally hidden (Arc-style, only the active space renders), so every
  // one of their live sessions bubbles to the tile. For the active space, its
  // own rendered project rows already carry their own bubble when collapsed -
  // only a project the search filter hid entirely (never rendered, so no row
  // to bubble to) still needs to surface on the tile.
  function spaceRollup(g: Space) {
    // "Active" here means its tree is on screen. In Topics, or with the sidebar
    // down to its rail, nothing of it is rendered, so all of its sessions
    // bubble to the tile.
    const isActive = () =>
      mode() === "spaces" && !props.railOnly && activeSpace()?.name === g.name;
    return () =>
      isActive()
        ? bubbleFor((s) => {
            if (s.spaceName !== g.name) return false;
            const p = g.projects.find((p) => p.branchUnits.some((u) => u.folderPath === s.folderPath));
            return p != null && !projectVisible(p);
          })
        : bubbleFor((s) => s.spaceName === g.name);
  }

  return (
    <div
      class={`${styles.tree} ${rows.rowScope}`}
      classList={{ [styles.railed]: railed(), [styles.railOnly]: railed() && props.railOnly }}
    >
      <div
        class={styles.treeHead}
        // Focus gone from the head is the filter abandoned. Moving inside it
        // (to a tab) is not, which would otherwise close on the way past.
        onFocusOut={(e) => {
          if (!searching()) return;
          const next = e.relatedTarget as Node | null;
          if (next && e.currentTarget.contains(next)) return;
          closeSearch();
        }}
      >
        {/* A strut, zero wide: it holds the first line at the pane strips'
            height, so the field taking a second one grows the head downward
            instead of lifting the title. */}
        <span class={styles.headStrut} aria-hidden="true" />
        {/* The title, and in Spaces mode the space's own menu with it. Right-
            click anywhere on it is the same menu, which is why the handler sits
            on the group rather than on the name. Withheld until there is a
            space to name, or it would read "Spaces" at every cold start. */}
        <Show when={mode() !== "spaces" || activeSpace()}>
        <div
          class={styles.spaceHeader}
          onContextMenu={mode() === "spaces" ? onSpaceAreaMenu : undefined}
        >
          <span class={styles.spaceHeaderName}>{headingName()}</span>
          <Show when={mode() === "spaces"}>
            <span class={styles.spaceHeaderKind}>· Spaces</span>
          </Show>
          <Show when={mode() === "spaces" && activeSpace()}>
            {(g) => (
              <Dropdown
                as="span"
                wrapper
                class={styles.spaceHeaderMenu}
                items={spaceMenu(g())}
                placement="bottom-end"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  class={styles.spaceHeaderMenuBtn}
                  tooltip={`Actions for ${g().name}`}
                  icon={<Icon icon={Ellipsis} />}
                />
              </Dropdown>
            )}
          </Show>
        </div>
        </Show>
        <Show when={searching()}>
          <input
            ref={(el) => {
              searchEl = el;
              // Opened to be typed in. After paint, or the element is not
              // focusable yet.
              requestAnimationFrame(() => el.focus());
            }}
            class={styles.searchInput}
            // A placeholder is not a name: it goes the moment anything is
            // typed, and this field is now mounted only while it is in use.
            aria-label={`Filter ${filterNoun()}`}
            placeholder={`Filter ${filterNoun()} (⌘⇧E)`}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Escape" && closeSearch()}
          />
        </Show>
        {/* Before the filter, and only in the mode it means something in: a
            Topic is the one thing this column makes. It carries the row's
            auto margin so the pair sits together against the right edge. */}
        <Show when={mode() === "topics"}>
          <Button
            class={styles.headAdd}
            variant="ghost"
            size="md"
            aria-label="New Topic"
            tooltip="New Topic"
            icon={<Icon icon={Plus} />}
            onClick={() => emit(NEW_TOPIC)}
          />
        </Show>
        {/* Only while the field is shut: open, the field is the affordance and
            the icon would be a second one beside it, in the space it wants. */}
        <Show when={!searching() && hasProjects()}>
          <Button
            class={styles.searchToggle}
            variant="ghost"
            size="md"
            aria-label="Filter"
            tooltip="Filter (⌘⇧E)"
            icon={<Icon icon={Search} />}
            onClick={() => setSearching(true)}
          />
        </Show>
      </div>

      {/* Hidden rather than unmounted, unlike the Spaces tree: this list owns
          its records, so a remount refetches them and redraws every row. */}
      <TopicList
        hidden={mode() !== "topics"}
        class={styles.topicList}
        spaces={visibleSpaces()}
        query={query()}
        activeId={props.selected?.kind === "topic" ? props.selected.topicId : null}
        activeRoot={props.selected?.kind === "topic" ? (props.selected.activeRoot ?? null) : null}
        onOpenMember={(f, root) => selectTopic(f, root)}
        countRunning={countRunningAgents}
        onExpanded={setExpandedTopics}
        topicStatus={(f) => bubbleFor((s) => s.home?.topic === f.id)}
        onSelect={(f, moved) => {
          const current = props.selected?.topicId === f.id ? (props.selected.activeRoot ?? null) : null;
          selectTopic(f, moved && current === moved.from ? moved.to : current);
        }}
        onDeleted={(f) => {
          if (props.selected?.kind === "topic" && props.selected.topicId === f.id) props.onSelect(null);
        }}
      />

      <Show when={mode() === "spaces"}>
      <OverlayScroll class={styles.treeScroll} onContextMenu={onSpaceAreaMenu}>
        <For each={activeProjects()}>
          {(p) => {
            const g = activeSpace()!;
            const popen = () => expanded().has(pkey(g, p));
            // A non-git folder has no branch node, and now no session rows
            // either: its project row *is* the branch-unit, a leaf that selects
            // its single unit when clicked.
            const plainDir = () => projectUnitKind(p) === "plain-dir";
            const folderUnit = () => p.branchUnits[0];
            // The flat units and the fan-out groups. An attempt of a worktree
            // container arrives as an ordinary worktree unit, so it is lifted
            // out here rather than rendered twice.
            const split = () => groupAttempts(inSpaces(p.branchUnits), attempts()[p.path] ?? []);
            // A long branch list is cut to BRANCH_CAP with the rest behind a
            // "N more branches" row. The selected unit is always kept, IN ITS
            // OWN PLACE in the order: a highlight you cannot see is worse than
            // a longer list, and lifting it to the top would reorder the tree
            // under the user. Partitioned in one pass so the shown and hidden
            // halves are always two views of the same `split()`.
            const showAll = () => expanded().has(mkey(g, p));
            const shown = () => {
              const all = split().units;
              if (showAll() || all.length <= BRANCH_CAP) return { units: all, hidden: [] as BranchUnit[] };
              const units: BranchUnit[] = [];
              const hidden: BranchUnit[] = [];
              for (const [i, u] of all.entries()) {
                (i < BRANCH_CAP || unitSelected(u) ? units : hidden).push(u);
              }
              return { units, hidden };
            };
            // Show the control only when it has something to say. Open, that is
            // "the list is longer than the cap"; closed, "something is actually
            // hidden" - which a cap+1 list whose last unit is selected is not.
            const truncated = () =>
              showAll() ? split().units.length > BRANCH_CAP : shown().hidden.length > 0;
            // Everything under this project, groups included, for the rollup a
            // collapsed project row shows: on a plain repo an attempt is not a
            // branch-unit at all, so its running session would bubble nowhere.
            const allUnits = () => [
              ...inSpaces(p.branchUnits),
              ...split()
                .groups.flatMap((grp) => grp.members)
                .filter((m) => !m.unit)
                .map(attemptUnit),
            ];
            return (
              <ProjectRow
                name={p.name}
                icon={
                  <ProjectIcon
                    seed={p.path}
                    icon={p.icon}
                    iconFile={p.iconFile}
                    favicon={p.favicon}
                  />
                }
                disclosure={!plainDir()}
                open={popen()}
                menu={projectMenu(g, p)}
                onClick={() => {
                  if (plainDir()) selectUnit(g, p, folderUnit());
                  else toggle(pkey(g, p));
                }}
                onDragStart={(e) => startAbsDrag(e, p.path)}
                end={
                  <>
                    {/* Lit only when a worktree is missing a shared file, since
                        a healthy container has nothing to say. Doubles as the
                        one path to the page that is not a right-click. */}
                    <Show when={sharedGaps()[p.path]}>
                      {(n) => (
                        <IconButton
                          size="xs"
                          class={rows.driftMark}
                          icon={<Icon icon={Unlink} />}
                          aria-label={`${p.name}: shared files missing from a worktree`}
                          tooltip={`${n()} shared ${n() === 1 ? "file is" : "files are"} missing from a worktree`}
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation();
                            openSharedFiles(p);
                          }}
                        />
                      )}
                    </Show>
                    {forgeDoorNode(p)}
                    {statusBubble(() =>
                      plainDir()
                        ? bubbleForUnits([folderUnit()])
                        : !popen()
                          ? bubbleForUnits(allUnits())
                          : null,
                    )}
                  </>
                }
              >
                <Show when={popen() && !plainDir()}>
                  <For
                    each={shown().units}
                    fallback={
                      <Show when={split().groups.length === 0}>
                        <EmptyRow>no branches</EmptyRow>
                      </Show>
                    }
                  >
                    {(u) => unitNode(g, p, u)}
                  </For>
                  <Show when={truncated()}>{moreNode(g, p, () => shown().hidden)}</Show>
                  <For each={split().groups}>{(grp) => attemptGroupNode(g, p, grp)}</For>
                </Show>
              </ProjectRow>
            );
          }}
        </For>

        <Show when={(config()?.spaces ?? []).length > 0 && activeProjects().length === 0}>
          <Show
            when={!q() && activeSpace()}
            fallback={<EmptyRow>no matches in this space</EmptyRow>}
          >
            {(g) => (
              <div class="tree-empty">
                <p>This space has no projects yet. Press Add to create, clone or add one.</p>
                <Button icon={<Icon icon={Plus} />} onClick={() => openNewProject(g())}>
                  Add
                </Button>
              </div>
            )}
          </Show>
        </Show>
      </OverlayScroll>

      <Show when={activeSpace()}>
        {(g) => (
          <Dropdown
            open={spaceAnchor() != null}
            anchor={spaceAnchor() ?? { x: 0, y: 0 }}
            onOpenChange={(open) => !open && setSpaceAnchor(undefined)}
            items={spaceMenu(g())}
          />
        )}
      </Show>
      </Show>

      {/* Outside the mode gate: the strip is how you leave a mode, so it has to
          render in every one. Gated on spaces rather than on a root, because
          the strip IS the space tiles now that the gear beside them is gone:
          a configured root with nothing under it has nothing to draw, and that
          state sits behind the first-run modal regardless. */}
      <Show when={config() && hasSpaces()}>
        <div class={styles.spaceBar} classList={{ [styles.rail]: railed() }}>
          <TileProbe
            glyph={Tags}
            ref={(el) => (probeEl = el)}
            nameRef={(el) => (probeNameEl = el)}
            textRef={(el) => (probeTextEl = el)}
          />
          <div class={styles.stripNav}>
            <div class={styles.spaceScroll}>
              <For each={visibleSpaces()}>{(g) => spaceTile(g)}</For>
            </div>

            {/* The rail has the height to spare that the strip never had, so
                New space gets a tile there instead of hiding in a menu. */}
            <Show when={railed()}>
              <Tooltip
                as="button"
                type="button"
                class={`${styles.stripBtn} ${styles.addSpaceBtn}`}
                label="New space"
                placement="right"
                aria-label="New space"
                onClick={() => addSpace()}
              >
                <Icon icon={Plus} />
              </Tooltip>
            </Show>

            {/* Topics, past a rule so the strip reads as spaces first. Outside
                the scroller, so a long space list cannot carry off the way back
                out of a mode. */}
            <Show when={hasProjects()}>
              <div class={styles.spaceDivider} />
              {modeTile("topics", "Topics", Tags)}
            </Show>
          </div>

          <Tooltip
            as="button"
            type="button"
            class={`${styles.stripBtn} ${styles.dockBtn}`}
            classList={{ [styles.active]: dockOpen() }}
            label={dockOpen() ? "Hide the dock (⌘⌃J)" : "Show the dock (⌘⌃J)"}
            placement={railed() ? "right" : undefined}
            aria-label="Dock"
            aria-pressed={dockOpen()}
            onClick={() => emit(TOGGLE_DOCK)}
          >
            <Icon icon={SquareTerminal} />
            <Show when={!dockOpen() && dockTabCount() > 0}>
              <CountBubble>{dockTabCount()}</CountBubble>
            </Show>
          </Tooltip>
        </div>
      </Show>

      <Show when={promptReq()}>
        <PromptModal
          title={promptReq()!.title}
          initial={promptReq()!.initial}
          note={promptReq()!.note}
          onSubmit={(v) => resolvePrompt(v)}
          onCancel={() => resolvePrompt(null)}
        />
      </Show>

      <Show when={pickReq()}>
        <PickerModal
          title={pickReq()!.title}
          items={pickReq()!.items}
          placeholder="Type to filter…"
          onSubmit={(v) => resolvePick(v)}
          onCancel={() => resolvePick(null)}
        />
      </Show>

      <Show when={deleteReq()}>
        <ConfirmDeleteSpace
          spaceName={deleteReq()!.name}
          kind={deleteReq()!.mode}
          path={shortHome(deleteReq()!.path, home())}
          entries={deleteReq()!.entries}
          loading={deleteReq()!.loading}
          runningCount={deleteReq()!.runningCount}
          sizeBytes={deleteReq()!.sizeBytes}
          title={
            deleteReq()!.mode === "folder"
              ? `Remove folder “${deleteReq()!.name}”?`
              : deleteReq()!.mode === "project"
                ? `Remove project “${deleteReq()!.name}”?`
                : undefined
          }
          confirmLabel={
            deleteReq()!.mode === "folder"
              ? "Remove folder"
              : deleteReq()!.mode === "project"
                ? "Remove project"
                : undefined
          }
          onConfirm={() => confirmDeleteSpace()}
          onCancel={() => setDeleteReq(null)}
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

      <Show when={wtReq()}>
        <WorktreeRemoveDialog
          label={wtReq()!.u.label}
          path={wtReq()!.u.folderPath}
          branch={wtReq()!.u.branch}
          dirty={wtReq()!.dirty}
          unpushed={wtReq()!.unpushed}
          hasRemote={wtReq()!.hasRemote}
          runningCount={wtReq()!.runningCount}
          busy={wtReq()!.busy}
          onConfirm={(opts) => confirmRemoveWorktree(opts)}
          onCancel={() => setWtReq(null)}
        />
      </Show>

      <Show when={brReq()}>
        <BranchRemoveDialog
          branch={brReq()!.u.branch!}
          unpushed={brReq()!.unpushed}
          hasRemote={brReq()!.hasRemote}
          busy={brReq()!.busy}
          onConfirm={(opts) => confirmRemoveBranch(opts)}
          onCancel={() => setBrReq(null)}
        />
      </Show>

      <Show when={initReq()}>
        <InitGitDialog
          folderName={initReq()!.p.name}
          busy={initReq()!.busy}
          onConfirm={(opts) => confirmInitGit(opts)}
          onCancel={() => setInitReq(null)}
        />
      </Show>

      <Show when={branchReq()}>
        {(req) => (
          <AddBranchDialog
            mode={req().mode}
            projectName={req().p.name}
            projectPath={shortHome(req().p.path, home())}
            locals={req().locals}
            remotes={req().remotes}
            taken={req().taken}
            fetching={req().fetching}
            onFetch={hasOrigin(req().p) ? () => fetchForBranchDialog() : undefined}
            deleting={req().deleting}
            onDeleteAsk={(branch) => askDeleteBranchInPicker(branch)}
            onDeleteConfirm={() => void confirmDeleteBranchInPicker()}
            onDeleteCancel={() => setBranchReq((r) => (r ? { ...r, deleting: null } : r))}
            busy={req().busy}
            prefill={req().prefill}
            baseDefault={req().baseDefault}
            issues={req().issues ? issueSourceFor(req().p) : undefined}
            onConfirm={(pick) => void confirmAddBranch(pick)}
            onCancel={() => setBranchReq(null)}
          />
        )}
      </Show>

      <Show when={originReq()}>
        {(req) => (
          <ChangeOriginDialog
            projectName={req().p.name}
            current={req().current}
            busy={req().busy}
            onConfirm={(url) => void confirmOrigin(url)}
            onCancel={() => setOriginReq(null)}
          />
        )}
      </Show>

      <Show when={newReq()}>
        <NewProjectDialog
          spaceName={newReq()!.g.name}
          busy={newReq()!.busy}
          onConfirm={(opts) => confirmNewProject(opts)}
          onCancel={() => setNewReq(null)}
        />
      </Show>

      <Show when={iconReq()}>
        <ProjectIconDialog
          projectName={iconReq()!.p.name}
          seed={iconReq()!.p.path}
          icon={iconReq()!.p.icon ?? null}
          iconFile={iconReq()!.p.iconFile ?? null}
          favicon={iconReq()!.p.favicon ?? null}
          busy={iconReq()!.busy}
          onConfirm={(choice) => confirmProjectIcon(choice)}
          onPickFile={pickIconFile}
          onCancel={() => setIconReq(null)}
        />
      </Show>

      <Show when={agentsReq()}>
        {(p) => (
          <ProjectAgentsDialog
            projectName={p().name}
            rows={ruleRows(projectRows(p().path))}
            allowed={projectRows(p().path)}
            onConfirm={(rows) =>
              void setProjectRows(p().path, rows)
                .then(() => setAgentsReq(null))
                .catch((e) => setError(String(e)))
            }
            onCancel={() => setAgentsReq(null)}
          />
        )}
      </Show>

      <Show when={spaceReq()}>
        <SpaceDialog
          mode={spaceReq()!.mode}
          name={spaceReq()!.name}
          icon={spaceReq()!.icon}
          color={spaceReq()!.color}
          spaces={(config()?.spaces ?? []).map((s) => s.name)}
          busy={spaceReq()!.busy}
          onConfirm={(opts) => confirmSpace(opts)}
          onCancel={() => setSpaceReq(null)}
        />
      </Show>
    </div>
  );
}
