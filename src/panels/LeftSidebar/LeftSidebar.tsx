import { createSignal, For, Match, Show, Switch, onMount, onCleanup, createEffect, createMemo, on, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ContextMenu from "../../components/Menu/ContextMenu";
import Dropdown from "../../components/Menu/Dropdown";
import { type MenuItem } from "../../components/Menu/rows";
import PromptModal from "../../components/Dialogs/PromptModal";
import PickerModal from "../../components/Dialogs/PickerModal";
import ConfirmDeleteSpace, { type DeleteEntry } from "../../components/Dialogs/ConfirmDeleteSpace";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import WorktreeRemoveDialog from "../../components/Dialogs/WorktreeRemoveDialog";
import BranchRemoveDialog from "../../components/Dialogs/BranchRemoveDialog";
import InitGitDialog from "../../components/Dialogs/InitGitDialog";
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
  TOGGLE_SIDEBAR_MODE,
  NEW_TOPIC,
  SESSIONS_REFRESH,
  DRAG_ABS_PATH_MIME,
  OPEN_JOB,
  NEW_SESSION,
  NEW_CHAT_AT,
  PURGE_UNDER_PATH,
  TERMINAL_TAB_FOCUSED,
  REMOVE_BRANCH_UNIT,
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
  SET_RIGHT_MODE,
  type SetRightMode,
  TOGGLE_DOCK,
  OPEN_SETTINGS,
  type OpenSettings,
  ACTIVATE_SPACE,
  type ActivateSpace,
} from "../../utils/events";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import { projectUnitKind } from "../../utils/topicMembers";
import { traceSwitchStart } from "../../utils/perfTrace";
import { syntheticId } from "../../utils/syntheticTabs";
import { onNeedsYouNotificationClick } from "../../utils/presence";
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
  notePtyActivity,
  refreshTailStates,
  liveSessionStatuses,
} from "../../utils/sessionActivity";
import { belongsToUnit } from "../../utils/unitAttribution";
import { forgeChip } from "../../utils/forgeChip";
import ForgeChipView from "../../components/ForgeChip/ForgeChip";
import { forgeAccountName, forgeErrorMessage, needsAttention } from "../../utils/forgeTypes";
import { apiCanServe } from "../../utils/createPr";
import {
  forgeHosts,
  forgePause,
  forgeRepo,
  noteForgeEnabled,
  pickForgeAccount,
  noteWatchedProjects,
  pollNow,
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
import { rememberSelection, rememberedUnit, rememberedFeature } from "../../utils/selectionMemory";
import { forgetIntro } from "../../utils/firstRun";
import {
  FolderCog,
  FolderPlus,
  Pin,
  FolderOpen,
  RotateCcw,
  Folder,
  Layers,
  Ellipsis,
  Search,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Waypoints,
  type LucideIcon,
  Plus,
  ChevronsLeftRightEllipsis,
  MessageCircleQuestion,
  Check,
  CircleDashed,
  SquareTerminal,
  Unlink,
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
import { topicKey, topicSelection, isShellsKey, tabUnderFolder, type Topic } from "../../utils/topics";
import { dockOpen } from "../../layout/dockStore";
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
function UnitIcon(props: { kind: string | undefined; active: boolean }) {
  return (
    <Switch fallback={<Icon icon={Folder} />}>
      <Match when={props.kind === "worktree" || props.kind === "incomplete"}>
        <WorktreeMark active={props.active} />
      </Match>
      <Match when={props.kind === "plain"}>
        <BranchMark active={props.active} />
      </Match>
    </Switch>
  );
}

// Trailing disclosure chevron for sidebar rows: a Lucide chevron-down pinned to
// the row's right edge that flips to a chevron-up (rotate 180°) when expanded.
function RowChevron(props: { open: boolean }) {
  return (
    <span class={styles.rowChevron} classList={{ [styles.open]: props.open }}>
      <Icon icon={ChevronDown} />
    </span>
  );
}

// A project row's disclosure, drawn *in* the icon slot rather than beside it:
// at rest the row shows what the project is, and under the pointer it shows
// what clicking does. One slot, two jobs, and the row keeps a single glyph.
function IconChevron(props: { open: boolean }) {
  return (
    <span class={styles.iconChevron} aria-hidden="true">
      <Icon icon={props.open ? ChevronDown : ChevronRight} />
    </span>
  );
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
};
type Branch = { name: string; current: boolean };
// `icon`/`iconFile` are what the user chose (a Lucide name, or an image in the
// icon store); `favicon` is what discovery found inside the project. All three
// are optional and resolved in that order by ProjectIcon.
type Project = {
  name: string;
  path: string;
  branchUnits: BranchUnit[];
  external: boolean;
  icon?: string;
  iconFile?: string;
  favicon?: string;
};
type Space = {
  name: string;
  path: string;
  projects: Project[];
  external: boolean;
  icon?: string;
  // A swatch name; absent means the hue is derived from `name`.
  color?: string;
};
type ResolvedConfig = { path: string; roots: string[]; spaces: Space[] };

export type Selection = {
  // Absent means "unit": a selection persisted before Topics carried no kind.
  kind?: "unit" | "feature";
  featureId?: string;
  featureName?: string;
  // Present members' folders in order, and the one the editor, git and a spawn
  // run against. Null when no member is present; `folderPath` then mirrors "".
  roots?: string[];
  activeRoot?: string | null;
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
type SidebarMode = "spaces" | "features";
// The order the segments sit in, which is also the order the toggle steps through.
const MODE_VALUES: SidebarMode[] = ["spaces", "features"];

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
}) {
  // Seeded from the last load so the tree paints at once: a cold `get_config`
  // probes every project with git. The side effects in `loadConfig` run only on
  // the fresh result, never on this copy.
  const [config, setConfig] = createSignal<ResolvedConfig | null>(loadCachedConfig());
  // Every Topic record, for the "in <Topic>" chip on a member unit row.
  // Latest request wins, as in `TopicList`.
  const [topics, setTopics] = createSignal<Topic[]>([]);
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
  // Per-project origin URL, keyed by project path: gates whether Attach Existing
  // Branch fetches + folds in remote branches, and Add Origin vs Add/set remote.
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
  const filterNoun = () => (mode() === "features" ? "features" : "projects");
  /** What the tree's heading says, which is whatever the strip has lit. */
  const headingName = () => (mode() === "features" ? "Features" : (activeSpace()?.name ?? "Spaces"));
  createEffect(() => {
    try {
      localStorage.setItem(LS_MODE, chosenMode());
    } catch {
      // ignore quota
    }
  });
  const [gearOpen, setGearOpen] = createSignal(false);
  let searchEl: HTMLInputElement | undefined;
  let gearEl: HTMLDivElement | undefined;

  // Close the gear dropdown on any outside click. Bound only while it is open.
  function onDocClick(e: MouseEvent) {
    if (gearEl && !gearEl.contains(e.target as Node)) setGearOpen(false);
  }
  createEffect(() => {
    if (gearOpen()) document.addEventListener("mousedown", onDocClick);
    else document.removeEventListener("mousedown", onDocClick);
  });
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  // Run a gear-menu action then close the dropdown.
  function gearAction(fn: () => void) {
    setGearOpen(false);
    fn();
  }

  // Single-root model: a root is present when roots[0] exists.
  const hasRoot = () => (config()?.roots?.length ?? 0) > 0;

  // Spaces are "spaces" (Arc-style): shown as an icon strip at the bottom, one
  // active at a time, and the tree renders only the active space's projects.
  // Render order: root-discovered spaces first, pinned externals after. This is
  // the FULL list (never q-filtered) so the space strip is stable while filtering.
  const visibleSpaces = () => {
    const gs = config()?.spaces ?? [];
    return [...gs.filter((g) => !g.external), ...gs.filter((g) => g.external)];
  };
  // Split for the space bar: root-discovered spaces, then pinned ("Other")
  // spaces, with a divider rendered between the two groups when both exist.
  const rootSpaces = () => visibleSpaces().filter((g) => !g.external);
  const extSpaces = () => visibleSpaces().filter((g) => g.external);
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

  // What "Add" does in an empty space: the same action its own menu offers, so
  // a pinned space adds by pinning and a root space by creating or cloning.
  const addToSpace = (g: Space) => (g.external ? void pinFolder() : openNewProject(g));

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
    const back = rememberedFeature();
    const f = back?.featureId ? topics().find((f) => f.id === back.featureId) : null;
    if (!f) return false;
    if (props.selected?.kind === "feature" && props.selected.featureId === f.id) return true;
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
    if (next === "features") restoreTopic();
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
  // selected string or null on cancel.
  const [pickReq, setPickReq] = createSignal<{
    title: string;
    items: string[];
    creatable: boolean;
    reserve: boolean;
    resolve: (v: string | null) => void;
  } | null>(null);
  // `creatable`: let Ok/Enter commit a typed name that matches no listed item, so
  // the same dialog attaches a listed branch or creates a new one. `reserve`:
  // rows are still coming, so the list holds its full height from the start.
  function askPick(
    title: string,
    items: string[],
    creatable = false,
    reserve = false,
  ): Promise<string | null> {
    return new Promise((resolve) => setPickReq({ title, items, creatable, reserve, resolve }));
  }
  function resolvePick(v: string | null) {
    const req = pickReq();
    setPickReq(null);
    // The attach flow's picker closed (submit or cancel): stop any pending
    // background-fetch fold from touching a closed/next picker.
    attachCtx = null;
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

  // The "Initialize git…" dialog for a non-git folder (branch + optional origin +
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

  // Drag-to-reorder state for the root space tiles (pinned spaces don't reorder).
  // `dragSpace` is the name being dragged; `dropHint` marks the tile the drop
  // would land before/after, for the insertion indicator.
  const [dragSpace, setDragSpace] = createSignal<string | null>(null);
  const [dropHint, setDropHint] = createSignal<{ name: string; after: boolean } | null>(null);

  const [deleteReq, setDeleteReq] = createSignal<{
    mode: "space" | "folder" | "project";
    name: string;
    path: string;
    entries: DeleteEntry[];
    loading: boolean;
    runningCount: number;
    sizeBytes: number | null;
  } | null>(null);

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
  // listener. Everything downstream of it - what counts as attended, which
  // needs-you edge is worth a notification, the tray and the dock badge - lives
  // in `sessionActivity` now.
  const [windowFocused, setWindowFocused] = createSignal(true);
  createEffect(() => noteAttention(props.selected?.sessionId ?? null, windowFocused()));

  // Both halves of the join are triggers. The store used to fill only on an
  // expansion the user drove, so `liveTabs` alone was a workable stand-in for
  // "something changed"; now the store fills on its own, and a tab whose session
  // arrives after the tab did would never get its first tail read.
  createEffect(on(() => [props.liveTabs, sessions()] as const, () => void refreshTailStates()));

  // Turn-level checkpoints (Finding E): snapshot the working tree at each new
  // human prompt, live-tab sessions only, gated by the checkpoints setting.
  // Reuses the same live-tab x sessions() join as refreshTailStates above;
  // the actual rising-edge detection lives in checkpoints.ts so it can be
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

  // Does this live session belong to `u`? Keyed off the status list's own
  // recorded branch rather than off a per-row session array, so the rollup no
  // longer depends on the rows existing - which is what Phase 6 deletes. A
  // plain project's sibling branch units share one `folderPath` and are told
  // apart only by that branch, so `belongsToUnit` is the whole of the answer.
  function statusInUnit(s: LiveSessionStatus, p: Project, u: BranchUnit) {
    return (
      s.folderPath === u.folderPath &&
      belongsToUnit({ branch: s.recordedBranch }, u, p.branchUnits)
    );
  }

  // No session has a row of its own any more, so a rollup is never a second
  // report of something already on screen: the row that shows it is the only
  // place it appears. Whether to count at all is now purely a question of which
  // *rows* are rendered, which each call site knows.
  function bubbleForUnits(p: Project, us: readonly BranchUnit[]) {
    return bubbleFor((s) => us.some((u) => statusInUnit(s, p, u)));
  }

  // Rollup badge: Waiting first (it always wins the
  // row), then Executing, each with an xN count when more than one session
  // shares the state. Renders nothing when neither count is present.
  //
  // An approval and a question share the chip, since both say "this one is
  // waiting on you", and only the title tells them apart.
  function statusBubble(r: Rollup | null) {
    if (!r) return null;
    const waiting = () => r.waitingForApproval + r.waitingForAnswer;
    const waitingTitle = () =>
      r.waitingForApproval && r.waitingForAnswer
        ? "Waiting for you"
        : r.waitingForApproval
          ? "Waiting for approval"
          : "Waiting for an answer";
    if (!waiting() && !r.executing && !r.idle && !r.running) return null;
    return (
      <span class={styles.statusBubble}>
        <Show when={waiting()}>
          <span class={`${styles.statusBubbleItem} ${styles.waitingForApproval}`} title={waitingTitle()}>
            <Icon icon={MessageCircleQuestion} />
            <Show when={waiting() > 1}>{waiting()}</Show>
          </span>
        </Show>
        <Show when={r.executing}>
          <span class={`${styles.statusBubbleItem} ${styles.executing}`} title="Executing">
            <Icon icon={ChevronsLeftRightEllipsis} />
            <Show when={r.executing > 1}>{r.executing}</Show>
          </span>
        </Show>
        <Show when={r.idle}>
          <span class={`${styles.statusBubbleItem} ${styles.idle}`} title="Idle">
            <Icon icon={Check} />
            <Show when={r.idle > 1}>{r.idle}</Show>
          </span>
        </Show>
        <Show when={r.running}>
          <span class={`${styles.statusBubbleItem} ${styles.running}`} title="Running">
            <Icon icon={CircleDashed} />
            <Show when={r.running > 1}>{r.running}</Show>
          </span>
        </Show>
      </span>
    );
  }

  // The forge chip for one branch-unit: its PR, that PR's checks, and the
  // review verdict, or nothing at all.
  //
  // Every decision about *whether* to draw is `forgeChip`'s; what is left here
  // is glyphs and classes. The kinds that draw nothing (a remote the API cannot
  // serve, a paused poller, a unit no tick has reached) render no element at
  // all, so nothing in the tree can be clicked into a capability the repo does
  // not have - and, equally, so a sidebar full of GitLab checkouts stays as
  // quiet as it is today.
  function forgeChipNode(g: Space, p: Project, u: BranchUnit) {
    // Memoized, not a bare accessor: the component reads it several times per
    // render and each read would otherwise re-parse the origin URL.
    const chip = createMemo(() =>
      forgeChip({
        origin: origins()[p.path],
        hosts: forgeHosts(),
        branch: u.branch,
        firstUnit: u.branch === p.branchUnits.find((x) => x.branch)?.branch,
        paused: forgePause(p.path),
        status: unitStatus(p.path, u.branch),
      }),
    );
    // A control only when there is a pull request to open a panel *onto*, or a
    // host to add an account for. A branch with no PR yet renders the quiet
    // no-PR mark and stays inert: the panel lists what exists, and a button that
    // opens a list this branch is not in would be a control that does nothing.
    const opens = () => chip().kind === "pr";
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
      <Show
        when={chip().kind === "pickAccount"}
        fallback={
          <ForgeChipView
            chip={chip()}
            label={chip().connect?.title ?? `Pull requests for ${p.name}`}
            onActivate={
              chip().connect
                ? () => emitWith<OpenSettings>(OPEN_SETTINGS, { entry: "forge" })
                : opens()
                  ? () => void openPullRequests(g, p, u)
                  : undefined
            }
          />
        }
      >
        {/* The row selects its branch on click, which picking must not also do. */}
        <span onClick={(e) => e.stopPropagation()}>
          <Dropdown
            as="span"
            items={pickItems()}
            placement="bottom-end"
            aria-label={`Pick an account for ${p.name}`}
          >
            <ForgeChipView chip={chip()} />
          </Dropdown>
        </span>
      </Show>
    );
  }

  /// Select the branch-unit, then show the Pull Requests panel for its project.
  ///
  /// Selecting first, exactly as "New session" and "Commit log" do: the panel is
  /// workspace-scoped, so one opened into a workspace nobody is looking at would
  /// be invisible until you happened to switch back.
  async function openPullRequests(g: Space, p: Project, u: BranchUnit) {
    if (await selectUnit(g, p, u)) {
      emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "pulls" });
    }
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
    if (sel.kind === "feature") {
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

  // Pick a base folder and set it as THE single root (replacing any existing).
  // Cancel is a no-op, never a loop.
  // loadConfig() re-runs roots_watch_start, tearing down the old watch and
  // reinstalling it for the new root.
  async function addBaseFolder() {
    try {
      const path = await invoke<string | null>("pick_folder");
      if (!path) return;
      await invoke("set_root", { path });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Forget the root with zero on-disk deletion: returns to the first-run state.
  // loadConfig() reinstalls the (now empty) root watch.
  async function resetRoot() {
    const ok = await askConfirm({
      title: "Forget the base folder?",
      message: "Nothing on disk is deleted. Tori shows the intro and setup again.",
      confirmLabel: "Forget",
    });
    if (!ok) return;
    try {
      // Before the root goes: losing it opens the modal, which reads the flag
      // once as it mounts.
      await forgetIntro();
      await invoke("remove_root");
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Pin an out-of-root folder into the "Other" section. The backend refuses a
  // path inside the root (it already appears in the tree); the error surfaces.
  async function pinFolder() {
    try {
      const path = await invoke<string | null>("pick_folder");
      if (!path) return;
      await invoke("pin_path", { path });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Unpin an external project: removes it from discovery.paths, no disk deletion.
  async function unpinPath(p: Project) {
    try {
      await invoke("unpin_path", { path: p.path });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Open the create-space dialog (needs a root to mkdir under).
  function addSpace() {
    if (!(config()?.roots ?? []).length) return;
    setSpaceReq({ mode: "new", name: "", icon: null, color: null, busy: false });
  }

  // Open the edit-space dialog, prefilled. Keyed by name, so it works for a root
  // space and an external pin alike; only the icon is editable.
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
  // and `dragSpace` gates the in-bar reorder. Only root tiles participate, so a
  // pinned space is never a drag source or a drop target.
  function onSpaceDragOver(e: DragEvent, g: Space) {
    if (g.external || !dragSpace() || dragSpace() === g.name) return;
    e.preventDefault(); // mark this tile a valid drop target
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropHint({ name: g.name, after: e.clientX > r.left + r.width / 2 });
  }

  async function onSpaceDrop(e: DragEvent, g: Space) {
    const from = dragSpace();
    const hint = dropHint();
    setDragSpace(null);
    setDropHint(null);
    if (g.external || !from || from === g.name) return;
    e.preventDefault();
    const after = hint?.name === g.name ? hint.after : false;
    // Full new order of root-space names (persisted so the next reload keeps it).
    const next = rootSpaces()
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

  // Open the "Initialize git…" dialog for a non-git folder.
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

  async function addRemote(p: Project) {
    const url = await askText(`Remote URL (origin) for "${p.name}":`);
    if (!url?.trim()) return;
    try {
      await invoke("git_remote_add", { projectPath: p.path, url: url.trim() });
    } catch (e) {
      setError(String(e));
    }
  }

  // Change an existing origin's URL. Shows the current URL and seeds the input with
  // it (easy to edit, e.g. ssh↔https or a moved repo). git_remote_add does a
  // set-url when origin already exists, so the same backend handles it. A no-op or
  // empty entry cancels. Note: remote-tracking refs (refs/remotes/origin/*) keep
  // their old state until the next fetch; pointing at a *different* repo leaves
  // stale tracking branches (and any worktree upstreams) until you fetch.
  async function changeRemote(p: Project) {
    let current: string | null = null;
    try {
      current = await invoke<string | null>("git_origin", { projectPath: p.path });
    } catch {
      /* fall through with no current */
    }
    const url = await askText(
      `Change origin for "${p.name}":`,
      current ?? "",
      current ? `Current: ${current}` : undefined,
    );
    if (url === null) return; // cancelled
    const next = url.trim();
    if (!next || next === current) return; // empty or unchanged: no-op
    try {
      await invoke("git_remote_add", { projectPath: p.path, url: next });
    } catch (e) {
      setError(String(e));
    }
  }

  // --- plain-repo branch actions (attach/detach model) ---

  const hasOrigin = (p: Project) => (origins()[p.path] ?? null) !== null;

  // Repos already warned about a missing credential helper, so the notice fires
  // once per session, not on every fetch.
  const helperWarned = new Set<string>();

  // Kick a background fetch for an attach flow: a one-time (per session) warning
  // when no credential helper will cache the login, then the fetch itself. The
  // git://fetch-done handler folds any remote-only branches into the open picker.
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
    invoke("git_fetch", { repo }).catch((e) => setError(String(e)));
  }

  // Routing context for the in-progress Attach Existing Branch flow. The
  // label→{kind,branch} map is the single source of truth: kind is carried
  // out-of-band, never parsed from the display string, so a local branch named
  // `origin/x` still routes as local. `allLocals` (every local branch name) lets
  // the fetch-done fold compute remote-only branches; `baseTitle` is the
  // hint-free picker title restored once the background fetch resolves.
  type AttachEntry = { kind: "local" | "remote"; branch: string };
  let attachCtx: {
    repo: string;
    map: Map<string, AttachEntry>;
    allLocals: Set<string>;
    baseTitle: string;
  } | null = null;

  // Add a branch to a plain repo (one dialog replacing New Branch + Attach
  // Existing Branch): list attachable local branches immediately, fold in remote
  // branches after a background fetch (shared attachCtx + git://fetch-done). A
  // listed pick attaches (local → attach_branch, remote → tracking
  // attach_remote_branch); a typed name that matches nothing is created at HEAD
  // and checked out. An already-local name (listed or typed) just attaches.
  async function addBranch(p: Project) {
    let branches: Branch[];
    try {
      branches = await invoke<Branch[]>("list_branches", { path: p.path });
    } catch (e) {
      return setError(String(e));
    }
    const allLocals = new Set(branches.map((b) => b.name));
    const visible = new Set(
      p.branchUnits.filter((u) => u.kind === "plain" && u.branch).map((u) => u.branch),
    );
    const candidates = branches.map((b) => b.name).filter((n) => !visible.has(n));

    // The routing map (label → {kind,branch}) is the source of truth; a returned
    // value absent from it is a new branch name to create.
    const map = new Map<string, AttachEntry>();
    for (const n of candidates) map.set(n, { kind: "local", branch: n });
    const baseTitle = "Branch Name";
    attachCtx = { repo: p.path, map, allLocals, baseTitle };

    const pick = askPick(
      hasOrigin(p) ? `${baseTitle} · fetching…` : baseTitle,
      candidates,
      true,
      hasOrigin(p),
    );
    if (hasOrigin(p)) beginBackgroundFetch(p.path);

    const value = await pick;
    if (!value) return; // cancelled
    const entry = map.get(value);
    let created: string | null = null;
    try {
      if (entry?.kind === "remote") {
        await invoke("attach_remote_branch", { repo: p.path, branch: entry.branch });
      } else if (entry?.kind === "local" || allLocals.has(value)) {
        await invoke("attach_branch", { repo: p.path, branch: entry?.branch ?? value });
      } else {
        // Matches nothing: create the branch at HEAD and switch to it.
        await invoke("new_branch", { repo: p.path, branch: value });
        await invoke("git_checkout", { repoPath: p.path, branch: value });
        created = value;
      }
      await loadConfig();
      // Naming a branch that did not exist is asking to work on it, and git is
      // already on it: land the selection there too. Attaching an existing
      // branch is not, and selecting it would raise the checkout confirm.
      if (created) selectUnitIn(p, (u) => u.branch === created);
    } catch (e) {
      setError(String(e));
    }
  }

  // Add a worktree to a bare container (one dialog replacing New worktree… +
  // Attach worktree…): list branches without a worktree (local, plus remotes
  // folded in after a background fetch), then create a worktree for the pick or
  // the typed name. create_worktree DWIMs the target: an existing local checks
  // out, a remote-only name (origin/<name>) is tracked, a brand-new name starts a
  // branch off origin's default.
  /** The container's Shared in worktrees page, as an editor tab. The container
   *  the tab's id, so the page reads the right one wherever the tab lands. */
  function openSharedFiles(p: Project) {
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("shared", p.path) });
  }

  async function addWorktree(p: Project) {
    let branches: Branch[];
    try {
      branches = await invoke<Branch[]>("list_branches", { path: p.path });
    } catch (e) {
      return setError(String(e));
    }
    const allLocals = new Set(branches.map((b) => b.name));
    // A worktree container's branch-units are its worktrees: hide any branch that
    // already has one.
    const visible = new Set(
      p.branchUnits.filter((u) => u.kind === "worktree" && u.branch).map((u) => u.branch),
    );
    const candidates = branches.map((b) => b.name).filter((n) => !visible.has(n));

    const map = new Map<string, AttachEntry>();
    for (const n of candidates) map.set(n, { kind: "local", branch: n });
    const baseTitle = "Branch Name";
    attachCtx = { repo: p.path, map, allLocals, baseTitle };

    const pick = askPick(
      hasOrigin(p) ? `${baseTitle} · fetching…` : baseTitle,
      candidates,
      true,
      hasOrigin(p),
    );
    if (hasOrigin(p)) beginBackgroundFetch(p.path);

    const value = await pick;
    if (!value) return; // cancelled
    // A remote row's label is `origin/<name>`; the map carries the bare branch.
    const branch = map.get(value)?.branch ?? value;
    try {
      // The command answers the folder it made (or reused), which is the only
      // thing that tells one worktree row from another: the selection lands on
      // that unit, the way clicking its row would.
      const folder = await invoke<string>("create_worktree", { repoPath: p.path, branch });
      await loadConfig();
      const unit = selectUnitIn(p, (u) => samePath(u.folderPath, folder));
      if (unit) emitWith<NewChatAt>(NEW_CHAT_AT, { folderPath: unit.folderPath, projectName: p.name });
    } catch (e) {
      setError(String(e));
    }
  }

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
      await invoke("chat_close", { sessionId: s.id }).catch(() => {});
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

  // Create/clone/bootstrap target the root tree; an external ("Other") space is
  // just a pin's parent dir, so it gets no create/delete actions (unpin is per
  // project, in projectMenu). Both kinds can edit their icon (keyed by name).
  const spaceMenu = (g: Space): MenuItem[] =>
    g.external
      ? [{ label: "Edit space…", onClick: () => editSpace(g) }]
      : [
          { label: "New…", onClick: () => openNewProject(g) },
          { separator: true },
          { label: "Edit space…", onClick: () => editSpace(g) },
          { label: "Delete space", danger: true, onClick: () => openDeleteSpace(g) },
        ];

  // A project with a working tree git can branch from: a plain repo or a
  // worktree container. Not a non-git folder, and not a bare stub, which has no
  // checkout to attempt anything against.
  const gitProject = (p: Project) => projectUnitKind(p) === "plain" || projectUnitKind(p) === "worktree";

  // "Change icon…" is appended to every project menu, external and every git
  // kind alike: the icon is a property of the row, not of what git is doing
  // underneath it, so a pinned folder and a worktree container get it equally.
  // Placed last, after its own separator, so it sits below the kind-specific
  // git actions and above nothing destructive.
  const projectMenu = (g: Space, p: Project): MenuItem[] => {
    const kind = kindMenu(g, p);
    return [
      ...kind,
      // No leading separator on a menu whose kind contributed nothing.
      ...(kind.length ? [{ separator: true } as MenuItem] : []),
      ...(ruleRows(projectRows(p.path)).length > 1 || projectRows(p.path).length
        ? [{ label: "Agents\u2026", onClick: () => setAgentsReq(p) }]
        : []),
      { label: "Change icon…", onClick: () => setIconReq({ p, busy: false }) },
    ];
  };

  // External (pinned) projects can be unpinned. Otherwise the menu is keyed by
  // git kind: a worktree container spawns worktrees, a plain-dir initializes git,
  // a plain repo commits / sets a remote / pushes.
  const kindMenu = (g: Space, p: Project): MenuItem[] => {
    if (p.external) return [{ label: "Unpin", onClick: () => unpinPath(p) }];
    switch (projectUnitKind(p)) {
      case "worktree":
        return [
          { label: "Add Worktree", onClick: () => addWorktree(p) },
          // Beside Add Worktree on purpose: the menu that makes worktrees is
          // where you say what they are made with.
          { label: "Shared in worktrees…", onClick: () => openSharedFiles(p) },
          { label: "Fan out…", onClick: () => fanOut(p) },
          ...(hasOrigin(p)
            ? [{ separator: true } as MenuItem, { label: "Change origin…", warn: true, onClick: () => changeRemote(p) }]
            : [{ separator: true } as MenuItem, { label: "Add Origin", onClick: () => addRemote(p) }]),
          { separator: true },
          { label: "Remove project", danger: true, onClick: () => openRemoveProject(p) },
        ];
      case "plain-dir": {
        // A non-git folder: it anchors sessions directly (no branch node), so its
        // menu carries the folder-level actions.
        const u = p.branchUnits[0];
        return [
          { label: "New session", onClick: () => startSession(g, p, u) },
          { separator: true },
          { label: "Initialize git…", onClick: () => openInitGit(p) },
          { separator: true },
          { label: "Remove folder", danger: true, onClick: () => openRemoveFolder(p) },
        ];
      }
      case "plain": {
        const items: MenuItem[] = [
          { label: "Add Branch", onClick: () => addBranch(p) },
          { label: "Fan out…", onClick: () => fanOut(p) },
        ];
        items.push({ separator: true });
        if (hasOrigin(p)) {
          items.push({ label: "Change origin…", warn: true, onClick: () => changeRemote(p) });
        } else {
          items.push({ label: "Add / set remote…", onClick: () => addRemote(p) });
        }
        items.push({ separator: true });
        items.push({ label: "Remove project", danger: true, onClick: () => openRemoveProject(p) });
        return items;
      }
      case "incomplete":
        // A bare container with no worktrees (a killed bootstrap, or all worktrees
        // removed). It is still a valid `.bare`, so offer the worktree-container
        // actions to bring one back, plus stub removal.
        return [
          { label: "Add Worktree", onClick: () => addWorktree(p) },
          { label: "Shared in worktrees…", onClick: () => openSharedFiles(p) },
          ...(hasOrigin(p)
            ? [{ separator: true } as MenuItem, { label: "Change origin…", warn: true, onClick: () => changeRemote(p) }]
            : [{ separator: true } as MenuItem, { label: "Add Origin", onClick: () => addRemote(p) }]),
          { separator: true },
          { label: "Remove empty container", danger: true, onClick: () => cleanupStub(p.branchUnits[0]) },
        ];
      default:
        return [];
    }
  };

  const unitMenu = (g: Space, p: Project, u: BranchUnit): MenuItem[] => {
    // An incomplete stub (a .bare with no worktree): it can still spawn a worktree
    // (its branches live in .bare), so offer that as well as removal.
    if (u.kind === "incomplete") {
      return [
        { label: "Add Worktree", onClick: () => addWorktree(p) },
        { separator: true },
        { label: "Remove empty container", danger: true, onClick: () => cleanupStub(u) },
      ];
    }
    const items: MenuItem[] = [
      { label: "New session", onClick: () => startSession(g, p, u) },
      { label: "Commit log", onClick: () => openCommitLog(g, p, u) },
    ];
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

  // "Commit log" menu action: select the unit first, exactly as "New session"
  // does. The log tab is workspace-scoped, and a tab opened into a workspace
  // nobody is looking at would be invisible until you happened to switch back.
  async function openCommitLog(g: Space, p: Project, u: BranchUnit) {
    if (await selectUnit(g, p, u)) {
      emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("log", u.folderPath) });
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
    return s != null && s.kind !== "feature" && s.folderPath === u.folderPath && s.branch === unitLabel(u);
  }

  // The Topics this folder is a member of, so a unit row can point back at
  // its other home. Kept here rather than lifted out of `TopicList` because
  // that list mounts only in Topics mode and this chip renders in Spaces.
  function topicsAt(folder: string): Topic[] {
    return topics().filter((f) => f.members.some((m) => !!m.worktreePath && sameCwd(m.worktreePath, folder)));
  }

  function selectTopic(f: Topic, preferredRoot: string | null) {
    // Keyed by the workspace key, not the bare id, so the legs the editor
    // reports (which key on the workspace) land on this span.
    traceSwitchStart("feature", topicKey(f.id));
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
    const rollup = () => bubbleForUnits(p, [u]);
    return (
      <div
        class={`node ${styles.branchNode}`}
        classList={{
          [styles.attemptNode]: attempt != null,
        }}
      >
        <ContextMenu
          class={`${styles.row} ${styles.branch} ${styles.sub1} ${unitSelected(u) ? styles.sel : ""}`}
          onClick={() => selectUnit(g, p, u)}
          items={attempt ? attemptMenu(g, p, u, attempt) : unitMenu(g, p, u)}
          draggable={true}
          onDragStart={(e) => startAbsDrag(e, u.folderPath)}
          aria-current={unitSelected(u) ? "true" : undefined}
        >
          <span class={styles.rowIcon}><UnitIcon kind={u.kind} active={rollup().executing > 0} /></span>
          <span class={styles.label}>{unitLabel(u)}</span>
          <For each={topicsAt(u.folderPath)}>
            {(f) => (
              <button
                type="button"
                class={`${styles.badge} ${styles.topicChip}`}
                aria-label={`Open Feature ${f.name}`}
                data-topic-chip={f.id}
                onClick={(e) => {
                  e.stopPropagation();
                  selectTopic(f, u.folderPath);
                }}
              >
                in {f.name}
              </button>
            )}
          </For>
          <Show when={u.kind === "incomplete"}>
            <span class={`${styles.badge} ${styles.hint}`} title="A .bare with no worktrees (right-click to add one or remove it)">stub</span>
          </Show>
          <Show when={u.isCurrent}>
            <span class={styles.dot} title="current checkout">●</span>
          </Show>
          {forgeChipNode(g, p, u)}
          {statusBubble(rollup())}
        </ContextMenu>
      </div>
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
    return (
      <div class={`node ${styles.branchNode}`}>
        <div
          class={`${styles.row} ${styles.branch} ${styles.sub1} ${styles.moreRow}`}
          onClick={() => toggle(key)}
        >
          <span class={styles.rowIcon}>
            <Icon icon={open() ? ChevronUp : Ellipsis} />
          </span>
          <span class={styles.label}>
            {open()
              ? "Show less"
              : `${hidden().length} more branch${hidden().length === 1 ? "" : "es"}`}
          </span>
          {/* A hidden branch has no row of its own to report on, so this one
              carries the rollup for all of them - the same rule that puts a
              collapsed project's rollup on its project row. Without it a
              running agent on the 20th branch would surface nowhere. */}
          {statusBubble(open() ? null : bubbleForUnits(p, hidden()))}
        </div>
      </div>
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
      <div class={`node ${styles.branchNode}`}>
        <div
          class={`${styles.row} ${styles.branch} ${styles.sub1}`}
          onClick={() => {
            toggle(key);
            // The attempts under it start collapsed, so nothing else would load
            // their sessions and the group would roll up an empty set.
            if (open()) for (const u of units()) void fetchSessions(u.folderPath);
          }}
          title={grp.goal}
        >
          {/* Layers, not a fork: the row names the shared goal, and the forks
              are the attempt rows nested under it. It carries an icon at all so
              every branch-level row lines its label up on the same x. */}
          <span class={styles.rowIcon}><Icon icon={Layers} /></span>
          <span class={styles.label}>{grp.goal}</span>
          <span
            class={`${styles.badge} ${styles.hint}`}
            title="Independent attempts at one task. Promote one and the rest are discarded."
          >
            {grp.members.length === 1 ? "1 attempt" : `${grp.members.length} attempts`}
          </span>
          {statusBubble(open() ? null : bubbleForUnits(p, units()))}
          <RowChevron open={open()} />
        </div>
        <Show when={open()}>
          <For each={grp.members}>
            {(m) => unitNode(g, p, attemptUnit(m), m.attempt)}
          </For>
        </Show>
      </div>
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
  let unlistenActivity: UnlistenFn | undefined;
  let unlistenTrayFocus: UnlistenFn | undefined;
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
    unlistenActivity = await listen<{ id: string; state: "active" | "quiet" }>(
      "pty://activity",
      (e) => notePtyActivity(e.payload.id, e.payload.state),
    );
    // Presence surfaces (phase 3): the tray's per-session menu entries and a
    // needs-you notification both focus the same way a sidebar row click does.
    unlistenTrayFocus = await listen<string>("tray://focus-session", (e) =>
      void selectSessionById(e.payload),
    );
    onNeedsYouNotificationClick((sessionId) => void selectSessionById(sessionId));
    // Window refocus re-probes so a dot clears promptly after e.g. a Ctrl+C
    // exit-to-shell that happened while the window was unfocused (its own
    // transcript write, if any, may already have been debounced away).
    offFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      setWindowFocused(focused);
      if (focused) {
        probeActive();
        // Re-read tail state too, not just liveness: a finished session emits no
        // more transcript writes or PTY edges, so a stale `blocked-candidate`
        // (e.g. a frozen hook Notification) would otherwise never be re-queried.
        // Refocusing the window re-syncs it, clearing a wrongly-pinned amber dot.
        void refreshTailStates();
        // The forge's own focus tick. `startForgePolling` also listens for the
        // DOM focus event; this is the signal the rest of the sidebar has always
        // trusted for a native refocus. Both go through `pollOnFocus`, so
        // whichever wins the race does the same thing, and the 30s per-project
        // gap absorbs the loser.
        void pollOnFocus();
      }
    });
    // Attach-flow background fetch: fold remote-only branches into the open
    // picker live. Guarded by attachCtx (right repo) AND an open picker, so a
    // late/duplicate fetch-done after cancel or reopen can't resurrect or double.
    unlistenFetchDone = await listen<{ repo: string }>("git://fetch-done", async (e) => {
      const ctx = attachCtx;
      if (ctx && ctx.repo === e.payload.repo && pickReq()) {
        try {
          const remotes = await invoke<string[]>("list_remote_branches", { repo: ctx.repo });
          const extra: string[] = [];
          for (const name of remotes) {
            if (ctx.allLocals.has(name)) continue; // a local branch already covers it
            const label = `origin/${name}`;
            if (ctx.map.has(label)) continue; // dedupe (local wins)
            ctx.map.set(label, { kind: "remote", branch: name });
            extra.push(label);
          }
          // Drop the "fetching…" hint and append any new remote-only entries.
          setPickReq((prev) =>
            prev ? { ...prev, title: ctx.baseTitle, items: [...prev.items, ...extra] } : prev,
          );
        } catch {
          // Leave the local-only picker usable; just clear the hint.
          setPickReq((prev) => (prev ? { ...prev, title: ctx.baseTitle } : prev));
        }
      }
      loadConfig();
    });
    unlistenFetchError = await listen<{ repo: string; error: string }>(
      "git://fetch-error",
      (e) => {
        setError(e.payload.error || "Fetch failed");
        const ctx = attachCtx;
        if (ctx && ctx.repo === e.payload.repo) {
          setPickReq((prev) => (prev ? { ...prev, title: ctx.baseTitle } : prev));
          attachCtx = null;
        }
      },
    );
  });
  onCleanup(() => {
    unlistenConfig?.();
    unlistenTopics?.();
    unlistenSessions?.();
    unlistenActivity?.();
    unlistenTrayFocus?.();
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
    const watched: WatchedProject[] = (g?.projects ?? [])
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
    for (const name of [...visibleSpaces().map((g) => g.name), "Features"]) {
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

  // The set of names is the other input. After paint, or the probe has no box.
  createEffect(
    on(
      () => visibleSpaces().map((g) => g.name).join(" "),
      () => requestAnimationFrame(() => measureNames()),
    ),
  );

  // One space tile for the bottom bar: its icon when set, else the name's
  // initial; active-marked, with its context menu and drag payload (all of the
  // space's project paths). It carries its own hue too, so the whole set of
  // spaces is legible at once rather than one switch at a time.
  //
  // The one row whose menu trigger cannot be the row itself. `Tooltip` and
  // `ContextMenu` both render *as* their control - each puts its handlers on the
  // element, and neither can inject them into an already-built JSX child - so
  // the tile can only be one of them. It stays the Tooltip's, and the menu takes
  // a `display: contents` wrapper: layout-neutral, and it still receives the
  // right-click on its way up. Nothing is lost positionally either, since a
  // context menu anchors on the cursor and never on its trigger's box.
  const spaceTile = (g: Space) => {
    // Lit only while the tree is actually showing this space. In Topics the
    // strip has moved on, and a second lit tile would say the sidebar is
    // showing two things.
    const on = () => mode() === "spaces" && activeSpace()?.name === g.name;
    return (
    <ContextMenu class={styles.spaceMenu} items={spaceMenu(g)}>
      <Tooltip
        as="button"
        type="button"
        class={styles.space}
        style={{ "--space-hue-rgb": spaceHueRgb(g.name, g.color), "--name-w": nameTarget(g.name) }}
        classList={{
          [styles.active]: on(),
          [styles.titled]: on(),
          [styles.dragging]: dragSpace() === g.name,
          [styles.dropBefore]: dropHint()?.name === g.name && !dropHint()!.after,
          [styles.dropAfter]: dropHint()?.name === g.name && dropHint()!.after,
        }}
        label={g.external ? `${g.name} (pinned)` : g.name}
        aria-label={g.external ? `${g.name} (pinned)` : g.name}
        aria-pressed={on()}
        onClick={() => openSpace(g)}
        draggable={true}
        onDragStart={(e) => {
          startAbsDrag(e, g.projects.map((p) => p.path));
          if (!g.external) setDragSpace(g.name);
        }}
        onDragOver={(e) => onSpaceDragOver(e, g)}
        onDrop={(e) => onSpaceDrop(e, g)}
        onDragEnd={() => {
          setDragSpace(null);
          setDropHint(null);
        }}
      >
        <Show when={resolveIcon(g.icon)} fallback={g.name.trim().charAt(0).toUpperCase() || "?"}>
          {(glyph) => <Icon icon={glyph()} />}
        </Show>
        {/* Always mounted; the 0fr track hides it. See .tileName. */}
        <span class={styles.tileName}><span class={styles.tileNameText}>{g.name}</span></span>
        {spaceBubble(g)}
      </Tooltip>
    </ContextMenu>
    );
  };

  const dockTabCount = () => (props.liveTabs ?? []).filter((t) => isShellsKey(t.workspace)).length;

  // Topics, as a tile in the same strip and on the same rules as a space: bare
  // glyph at rest, name and pill when the tree is showing it.
  const modeTile = (m: SidebarMode, label: string, glyph: LucideIcon) => {
    const on = () => mode() === m;
    return (
      <Tooltip
        as="button"
        type="button"
        class={`${styles.space} ${styles.modeTile}`}
        style={{ "--name-w": nameTarget(label) }}
        classList={{ [styles.active]: on(), [styles.titled]: on() }}
        label={label}
        aria-label={label}
        aria-pressed={on()}
        onClick={() => switchMode(m)}
      >
        <Icon icon={glyph} />
        <span class={styles.tileName}><span class={styles.tileNameText}>{label}</span></span>
      </Tooltip>
    );
  };

  // A space tile's own rollup badge: for the inactive spaces, their whole tree
  // is structurally hidden (Arc-style, only the active space renders), so
  // every one of their live sessions bubbles here. For the active space, its
  // own rendered project rows already carry their own bubble when collapsed -
  // only a project the search filter hid entirely (never rendered, so no row
  // to bubble to) still needs to surface on the tile.
  function spaceBubble(g: Space) {
    // "Active" here means its tree is on screen. In Topics nothing of it is
    // rendered, so all of its sessions bubble to the tile.
    const isActive = mode() === "spaces" && activeSpace()?.name === g.name;
    const r = isActive
      ? bubbleFor((s) => {
          if (s.spaceName !== g.name) return false;
          const p = g.projects.find((p) => p.branchUnits.some((u) => u.folderPath === s.folderPath));
          return p != null && !projectVisible(p);
        })
      : bubbleFor((s) => s.spaceName === g.name);
    const badge = statusBubble(r);
    if (!badge) return null;
    return <span class={styles.spaceBubble}>{badge}</span>;
  }

  return (
    <div class={styles.tree}>
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
        <Show when={mode() === "features"}>
          <Button
            class={styles.headAdd}
            variant="ghost"
            size="md"
            aria-label="New Feature"
            tooltip="New Feature"
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

      <Show when={mode() === "features"}>
        <TopicList
          class={styles.topicList}
          spaces={visibleSpaces()}
          query={query()}
          activeId={props.selected?.kind === "feature" ? props.selected.featureId : null}
          countRunning={countRunningAgents}
          onSelect={(f) => selectTopic(f, props.selected?.featureId === f.id ? (props.selected.activeRoot ?? null) : null)}
          onDeleted={(f) => {
            if (props.selected?.kind === "feature" && props.selected.featureId === f.id) props.onSelect(null);
          }}
        />
      </Show>

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
            const split = () => groupAttempts(p.branchUnits, attempts()[p.path] ?? []);
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
              ...p.branchUnits,
              ...split()
                .groups.flatMap((grp) => grp.members)
                .filter((m) => !m.unit)
                .map(attemptUnit),
            ];
            // Rows are clickable `div`s, which window drag cannot tell from
            // chrome by selector, so the card opts its whole subtree out of it
            // (utils/windowDrag).
            return (
              <div class={`node ${styles.projectCard}`} data-no-window-drag>
                <ContextMenu
                  class={`${styles.row} ${styles.project}`}
                  onClick={() => {
                    if (plainDir()) selectUnit(g, p, folderUnit());
                    else toggle(pkey(g, p));
                  }}
                  items={projectMenu(g, p)}
                  draggable={true}
                  onDragStart={(e) => startAbsDrag(e, p.path)}
                >
                  <span class={`${styles.rowIcon} ${styles.projectIcon}`}>
                    <span class={styles.projectIconArt}>
                      <ProjectIcon
                        seed={p.path}
                        icon={p.icon}
                        iconFile={p.iconFile}
                        favicon={p.favicon}
                      />
                    </span>
                    {/* The disclosure takes over this slot on hover. A folder
                        with no branches under it has nothing to disclose, so
                        it keeps its icon throughout. */}
                    <Show when={!plainDir()}>
                      <IconChevron open={popen()} />
                    </Show>
                  </span>
                  <span class={styles.label}>{p.name}</span>
                  {/* Lit only when a worktree is missing a shared file, since a
                      healthy container has nothing to say. Doubles as the one
                      path to the page that is not a right-click. */}
                  <Show when={sharedGaps()[p.path]}>
                    {(n) => (
                      <IconButton
                        size="xs"
                        class={styles.driftMark}
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
                  {statusBubble(
                    plainDir()
                      ? bubbleForUnits(p, [folderUnit()])
                      : !popen()
                        ? bubbleForUnits(p, allUnits())
                        : null,
                  )}
                </ContextMenu>
                <Show when={popen() && !plainDir()}>
                  <For
                    each={shown().units}
                    fallback={
                      <Show when={split().groups.length === 0}>
                        <div class={`${styles.row} ${styles.dim} ${styles.sub1}`}>no branches</div>
                      </Show>
                    }
                  >
                    {(u) => unitNode(g, p, u)}
                  </For>
                  <Show when={truncated()}>{moreNode(g, p, () => shown().hidden)}</Show>
                  <For each={split().groups}>{(grp) => attemptGroupNode(g, p, grp)}</For>
                </Show>
              </div>
            );
          }}
        </For>

        <Show when={(config()?.spaces ?? []).length > 0 && activeProjects().length === 0}>
          <Show
            when={!q() && activeSpace()}
            fallback={<div class={`${styles.row} ${styles.dim} ${styles.sub1}`}>no matches in this space</div>}
          >
            {(g) => (
              <div class="tree-empty">
                <p>
                  {g().external
                    ? "Nothing is pinned here yet. Press Add to pin a folder to this space."
                    : "This space has no projects yet. Press Add to create, clone or add one."}
                </p>
                <Button icon={<Icon icon={Plus} />} onClick={() => addToSpace(g())}>
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
          render in every one. */}
      <Show when={config() && (hasRoot() || hasSpaces())}>
        <div class={styles.spaceBar}>
          {/* Out of flow and never seen: the ruler `measureNames` runs each
              candidate name through, wearing the real lit-tile CSS so what it
              reports is what the row would actually take. */}
          <span class={`${styles.space} ${styles.titled} ${styles.tileProbe}`} aria-hidden="true" ref={probeEl}>
            <Icon icon={Waypoints} />
            <span class={styles.tileName} ref={probeNameEl}><span class={styles.tileNameText} ref={probeTextEl} /></span>
          </span>
          <div class={styles.gearWrap} ref={gearEl}>
            <Tooltip
              as="button"
              type="button"
              class={styles.stripBtn}
              classList={{ [styles.active]: gearOpen() }}
              label="Sidebar actions"
              aria-label="Sidebar actions"
              onClick={() => setGearOpen(!gearOpen())}
            >
              <Icon icon={FolderCog} />
            </Tooltip>
            <Show when={gearOpen()}>
              <div class={styles.gearMenu} data-no-window-drag>
                <Show when={hasRoot()}>
                  <div class={styles.gearItem} onClick={() => gearAction(addSpace)}>
                    <Icon icon={FolderPlus} />New space
                  </div>
                </Show>
                <div class={styles.gearItem} onClick={() => gearAction(pinFolder)}>
                  <Icon icon={Pin} />Pin folder to "Other"
                </div>
                <div class={styles.gearDivider} />
                <div class={styles.gearItem} onClick={() => gearAction(addBaseFolder)}>
                  <Icon icon={FolderOpen} />Add/Update root
                </div>
                <Show when={hasRoot()}>
                  <div class={`${styles.gearItem} ${styles.danger}`} onClick={() => gearAction(resetRoot)}>
                    <Icon icon={RotateCcw} />Reset root (forget only)
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          <div class={styles.stripNav}>
            <div class={styles.spaceScroll}>
              <For each={rootSpaces()}>{(g) => spaceTile(g)}</For>
              <Show when={rootSpaces().length > 0 && extSpaces().length > 0}>
                <div class={styles.spaceDivider} />
              </Show>
              <For each={extSpaces()}>{(g) => spaceTile(g)}</For>
            </div>

            {/* Topics, past a rule so the strip reads as spaces first. Outside
                the scroller, so a long space list cannot carry off the way back
                out of a mode. */}
            <Show when={hasProjects()}>
              <div class={styles.spaceDivider} />
              {modeTile("features", "Features", Waypoints)}
            </Show>
          </div>

          <Show when={hasSpaces()}>
          <Tooltip
            as="button"
            type="button"
            class={`${styles.stripBtn} ${styles.dockBtn}`}
            classList={{ [styles.active]: dockOpen() }}
            label={dockOpen() ? "Hide the dock (⌘⌃J)" : "Show the dock (⌘⌃J)"}
            aria-label="Dock"
            aria-pressed={dockOpen()}
            onClick={() => emit(TOGGLE_DOCK)}
          >
            <Icon icon={SquareTerminal} />
            <Show when={!dockOpen() && dockTabCount() > 0}>
              <span class={styles.spaceBubble}>
                <span class={styles.tileCount}>{dockTabCount()}</span>
              </span>
            </Show>
          </Tooltip>
          </Show>
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
          creatable={pickReq()!.creatable}
          reserve={pickReq()!.reserve}
          placeholder="Type to filter or name a new branch…"
          onSubmit={(v) => resolvePick(v)}
          onCancel={() => resolvePick(null)}
        />
      </Show>

      <Show when={deleteReq()}>
        <ConfirmDeleteSpace
          spaceName={deleteReq()!.name}
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
          busy={spaceReq()!.busy}
          onConfirm={(opts) => confirmSpace(opts)}
          onCancel={() => setSpaceReq(null)}
        />
      </Show>
    </div>
  );
}
