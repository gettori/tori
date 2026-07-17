import { createSignal, For, Show, onMount, onCleanup, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ContextMenu, { type MenuItem, type MenuState } from "../../components/ContextMenu/ContextMenu";
import PromptModal from "../../components/Dialogs/PromptModal";
import PickerModal from "../../components/Dialogs/PickerModal";
import ConfirmDeleteSpace, { type DeleteEntry } from "../../components/Dialogs/ConfirmDeleteSpace";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import WorktreeRemoveDialog from "../../components/Dialogs/WorktreeRemoveDialog";
import BranchRemoveDialog from "../../components/Dialogs/BranchRemoveDialog";
import InitGitDialog from "../../components/Dialogs/InitGitDialog";
import NewProjectDialog, { type NewProjectMode } from "../../components/Dialogs/NewProjectDialog";
import SpaceDialog, { type SpaceDialogMode } from "../../components/Dialogs/SpaceDialog";
import Toasts, { type Toast } from "../../components/Toasts/Toasts";
import Button from "../../components/Button/Button";
import {
  on as onEvent,
  onWith,
  emitWith,
  FOCUS_SEARCH,
  SESSIONS_REFRESH,
  DRAG_ABS_PATH_MIME,
  OPEN_TERMINAL,
  NEW_SESSION,
  PURGE_UNDER_PATH,
  TOAST,
  type OpenTerminal,
  type NewSession,
  type PurgeUnderPath,
  type ToastEvent,
  type LiveTab,
} from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import ClaudeIcon from "../../seti/ClaudeIcon";
import PiIcon from "../../seti/PiIcon";
import Chevron from "../../components/Chevron/Chevron";
import Icon from "../../components/Icon/Icon";
import { resolveIcon } from "../../components/Icon/iconRegistry";
import {
  Settings,
  FolderPlus,
  Pin,
  FolderOpen,
  RotateCcw,
  Folder,
  GitBranch,
  GitFork,
  ChevronDown,
  Plus,
} from "lucide-solid";
import type { LucideIcon } from "lucide-solid";
import styles from "./LeftSidebar.module.css";

// Lucide glyph for a project row, keyed by its git kind: a worktree container
// (or an empty .bare stub) reads as a fork, a plain repo as a branch, and a
// non-git folder as a plain folder (matching a space's folder mark).
function projectIcon(kind: string | undefined): LucideIcon {
  switch (kind) {
    case "worktree":
    case "incomplete":
      return GitFork;
    case "plain":
      return GitBranch;
    default:
      return Folder;
  }
}

// Trailing disclosure chevron for sidebar rows: a Lucide chevron-down pinned to
// the row's right edge that flips to a chevron-up (rotate 180°) when expanded.
function RowChevron(props: { open: boolean }) {
  return (
    <span class={styles.rowChevron} classList={{ [styles.open]: props.open }}>
      <Icon icon={ChevronDown} size={14} />
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

// Bare + worktree bootstrap, run as one `set -e` pipeline in a terminal tab.
// $1 = repo URL, $2 = project folder (passed as args, never interpolated). The
// trailing `|| rm -rf` cleans up a half-built project on any failure; a killed
// run leaves a `.bare`-only stub, which discovery flags as `incomplete`.
const BOOTSTRAP_SCRIPT = `set -e
url="$1"; proj="$2"
(
  set -e
  git clone --bare "$url" "$proj/.bare"
  printf 'gitdir: ./.bare\\n' > "$proj/.git"
  git -C "$proj/.bare" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  git -C "$proj" fetch origin
  def="$(git -C "$proj/.bare" symbolic-ref --short HEAD)"
  git -C "$proj" worktree add "$def" "$def"
  echo; echo "Done: '$proj' ready on branch '$def'."
) || { echo; echo "Bootstrap failed; cleaning up $proj"; rm -rf "$proj"; exit 1; }`;

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
type Project = { name: string; path: string; branchUnits: BranchUnit[]; external: boolean };
type Space = { name: string; path: string; projects: Project[]; external: boolean; icon?: string };
type ResolvedConfig = { path: string; roots: string[]; spaces: Space[] };
type SessionMeta = {
  id: string;
  path: string;
  cwd: string;
  branch: string;
  title: string;
  last_active: number;
  name: string | null;
  archived: boolean;
  agent?: string;
};

export type Selection = {
  spaceName: string;
  projectName: string;
  projectPath: string;
  // The branch-unit's working folder: the anchor every path consumer uses.
  folderPath: string;
  branch: string;
  projectKind: string;
  // The session's own recorded branch (Claude) for the mismatch badge.
  recordedBranch?: string;
  agent?: string;
  sessionId?: string;
  sessionPath?: string;
  // What pi resumes with (`pi --session <file>`); equals sessionPath.
  sessionFile?: string;
  // The session's recorded cwd: where a resume should spawn (Phase 4).
  sessionCwd?: string;
  sessionTitle?: string;
  sessionName?: string | null;
  sessionArchived?: boolean;
};

const LS_EXPANDED = "sway.expanded.v1";
const LS_ACTIVE_SPACE = "sway.active-space.v1";

function loadActiveSpace(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE_SPACE);
  } catch {
    return null;
  }
}

function ago(epochSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_EXPANDED);
    if (raw) return new Set<string>(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set<string>();
}

export default function LeftSidebar(props: {
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
  liveTabs?: LiveTab[];
}) {
  const [config, setConfig] = createSignal<ResolvedConfig | null>(null);

  // Errors surface as auto-dismissing toasts (bottom-right) rather than a banner
  // pinned above the tree. setError keeps its old signature so all call sites are
  // unchanged; an empty string (the old "clear the banner" idiom) is a no-op.
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let toastSeq = 0;
  function dismissToast(id: number) {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }
  function setError(msg: string, kind: "error" | "info" = "error") {
    const message = String(msg ?? "").trim();
    if (!message) return;
    setToasts((ts) => [...ts, { id: ++toastSeq, message, kind }]);
  }
  const [expanded, setExpanded] = createSignal<Set<string>>(loadExpanded());
  // Sessions keyed by branch-unit folderPath (the cwd anchor).
  const [sessions, setSessions] = createSignal<Record<string, SessionMeta[]>>({});
  // Per-folder "historical" flag: sessions predating a recreated folder, hidden
  // under a collapsed "Historical" section until adopted.
  const [historical, setHistorical] = createSignal<Record<string, boolean>>({});
  // Per-project "has an origin remote" flag: gates whether Attach Existing
  // Branch fetches + folds in remote branches, and Add Origin vs Add/set remote.
  // Keyed by project path.
  const [origins, setOrigins] = createSignal<Record<string, boolean>>({});
  const [query, setQuery] = createSignal("");
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

  // Per-node right-click menu. Set on `contextmenu`, cleared on close.
  const [menu, setMenu] = createSignal<MenuState | null>(null);

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
    resolve: (v: string | null) => void;
  } | null>(null);
  // `creatable`: let Ok/Enter commit a typed name that matches no listed item, so
  // the same dialog attaches a listed branch or creates a new one.
  function askPick(title: string, items: string[], creatable = false): Promise<string | null> {
    return new Promise((resolve) => setPickReq({ title, items, creatable, resolve }));
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
    busy: boolean;
  } | null>(null);

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

  // Live shell/agent tabs grouped under a folder (prefix match on the tab's
  // workspace). Command tabs (clone/bootstrap) are transient, so they don't count.
  function liveTabsUnder(path: string): LiveTab[] {
    return (props.liveTabs ?? []).filter(
      (t) => t.kind !== "command" && isUnderPath(t.workspace, path),
    );
  }

  // How many things are running under `path`: every live shell/agent tab there,
  // plus any pgrep-matched session that no live tab already represents (dedup by
  // the tab's soft sessionId). Live tabs catch shell + fresh-agent tabs that pgrep
  // can't see; the pgrep pass still catches a detached resumed session with no tab.
  async function countRunningAgents(path: string): Promise<number> {
    const tabs = liveTabsUnder(path);
    const tabSessions = new Set(tabs.map((t) => t.sessionId).filter((x): x is string => !!x));
    const nested = await invoke<SessionMeta[]>("list_sessions", { folder: path }).catch(
      () => [] as SessionMeta[],
    );
    let detached = 0;
    await Promise.all(
      nested.map(async (s) => {
        if (tabSessions.has(s.id) || !isUnderPath(s.cwd, path)) return;
        if (await invoke<boolean>("session_running", { id: s.id }).catch(() => false)) detached++;
      }),
    );
    return tabs.length + detached;
  }

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
      const sel = props.selected;
      if (sel && isUnderPath(sel.folderPath, req.path)) props.onSelect(null);
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  function openMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return; // a node with no actions yet opens nothing
    setMenu({ x: e.clientX, y: e.clientY, items });
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
      // Populate the per-project origin flag (fire-and-forget) so the remote menu
      // items resolve to the right variant by the time a menu is opened.
      void (async () => {
        const map: Record<string, boolean> = {};
        await Promise.all(
          cfg.spaces
            .flatMap((g) => g.projects)
            .filter((p) => {
              const k = p.branchUnits[0]?.kind;
              return k === "plain" || k === "worktree" || k === "incomplete";
            })
            .map(async (p) => {
              try {
                map[p.path] = (await invoke<string | null>("git_origin", { projectPath: p.path })) != null;
              } catch {
                map[p.path] = false;
              }
            }),
        );
        setOrigins(map);
      })();
    } catch (e) {
      setError(String(e));
    }
  }

  // Pick a base folder and set it as THE single root (replacing any existing).
  // Cancel is a no-op (the empty state with this action stays put), never a loop.
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
      message: "Nothing on disk is deleted; the tree returns to its first-run state.",
      confirmLabel: "Forget",
    });
    if (!ok) return;
    try {
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
    setSpaceReq({ mode: "new", name: "", icon: null, busy: false });
  }

  // Open the edit-space dialog, prefilled. Keyed by name, so it works for a root
  // space and an external pin alike; only the icon is editable.
  function editSpace(g: Space) {
    setSpaceReq({ mode: "edit", name: g.name, icon: g.icon ?? null, busy: false });
  }

  // Confirmed: create runs the single `add_space` command (mkdir + icon write +
  // one emit); edit runs `set_space_meta`. Each command emits `config://changed`,
  // which drives the reload, so there is no manual loadConfig here. On failure,
  // surface the error and leave the dialog open.
  async function confirmSpace(opts: { name: string; icon: string | null }) {
    const req = spaceReq();
    if (!req) return;
    setSpaceReq({ ...req, busy: true });
    try {
      if (req.mode === "new") {
        const roots = config()?.roots ?? [];
        if (!roots.length) throw new Error("No base folder configured");
        await invoke("add_space", { root: roots[0], name: opts.name, icon: opts.icon });
      } else {
        await invoke("set_space_meta", { name: req.name, icon: opts.icon });
      }
      setSpaceReq(null);
    } catch (e) {
      setError(String(e));
      setSpaceReq({ ...req, busy: false });
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

  function badName(name: string): string | null {
    const n = name.trim();
    if (!n) return "Name is empty";
    if (n.includes("/") || n.includes("\\")) return "Name cannot contain a slash";
    if (n.startsWith(".")) return "Name cannot start with a dot";
    return null;
  }

  // Pre-check the target dir is free, then run the command in a terminal tab
  // (native git progress + ambient auth, no in-app credentials). The terminal
  // area re-discovers when the tab exits.
  async function runInTab(g: Space, name: string, kind: string, program: string, args: string[]) {
    const bad = badName(name);
    if (bad) return setError(bad);
    const target = `${g.path}/${name.trim()}`;
    if (await invoke<boolean>("file_exists", { path: target })) {
      return setError(`"${name.trim()}" already exists`);
    }
    setError("");
    // Sway is creating this folder: adopt the target path so a clone/bootstrap
    // onto a path that once held sessions is not flagged historical.
    invoke("adopt_path", { path: target }).catch(() => {});
    emitWith<OpenTerminal>(OPEN_TERMINAL, {
      id: `${kind}:${target}:${Date.now()}`,
      title: `${kind} ${name.trim()}`,
      cwd: g.path,
      program,
      args,
      rediscoverOnExit: true,
    });
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
    if (opts.mode === "clone") {
      await runInTab(g, opts.name, "clone", "git", ["clone", opts.url, opts.name]);
    } else {
      await runInTab(g, opts.name, "bootstrap", "sh", ["-c", BOOTSTRAP_SCRIPT, "sway", opts.url, opts.name]);
    }
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
      const sel = props.selected;
      if (sel && isUnderPath(sel.folderPath, u.folderPath)) props.onSelect(null);
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

  const hasOrigin = (p: Project) => origins()[p.path] === true;

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

    const pick = askPick(hasOrigin(p) ? `${baseTitle} · fetching…` : baseTitle, candidates, true);
    if (hasOrigin(p)) beginBackgroundFetch(p.path);

    const value = await pick;
    if (!value) return; // cancelled
    const entry = map.get(value);
    try {
      if (entry?.kind === "remote") {
        await invoke("attach_remote_branch", { repo: p.path, branch: entry.branch });
      } else if (entry?.kind === "local" || allLocals.has(value)) {
        await invoke("attach_branch", { repo: p.path, branch: entry?.branch ?? value });
      } else {
        // Matches nothing: create the branch at HEAD and switch to it.
        await invoke("new_branch", { repo: p.path, branch: value });
        await invoke("git_checkout", { repoPath: p.path, branch: value });
      }
      await loadConfig();
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

    const pick = askPick(hasOrigin(p) ? `${baseTitle} · fetching…` : baseTitle, candidates, true);
    if (hasOrigin(p)) beginBackgroundFetch(p.path);

    const value = await pick;
    if (!value) return; // cancelled
    // A remote row's label is `origin/<name>`; the map carries the bare branch.
    const branch = map.get(value)?.branch ?? value;
    try {
      await invoke("create_worktree", { repoPath: p.path, branch });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Switch the shared working tree to this branch (runs the checkout guard).
  async function checkoutUnit(g: Space, p: Project, u: BranchUnit) {
    await selectUnit(g, p, u);
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
  // store) or, when local is unchecked, just detach it (drop it from Sway's list,
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

  // --- session overlay actions (rename/archive/delete) ---

  async function renameSession(s: SessionMeta) {
    const name = await askText("Rename session:", s.name ?? s.title);
    if (name === null) return; // cancelled
    try {
      // Empty clears the name (Rust folds "" → None, reverting to the title).
      await invoke("set_session_name", { id: s.id, name: name.trim() || null });
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  async function archiveSession(s: SessionMeta) {
    try {
      await invoke("set_session_archived", { id: s.id, archived: !s.archived });
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteSession(s: SessionMeta) {
    const ok = await askConfirm({
      title: "Delete this session’s transcript?",
      message: "Its history is removed and cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("delete_session", { path: s.path });
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

  // A project's git kind comes from its branch-units (all share one kind).
  const projectKind = (p: Project) => p.branchUnits[0]?.kind;

  // External (pinned) projects can be unpinned. Otherwise the menu is keyed by
  // git kind: a worktree container spawns worktrees, a plain-dir initializes git,
  // a plain repo commits / sets a remote / pushes.
  const projectMenu = (g: Space, p: Project): MenuItem[] => {
    if (p.external) return [{ label: "Unpin", onClick: () => unpinPath(p) }];
    switch (projectKind(p)) {
      case "worktree":
        return [
          { label: "Add Worktree", onClick: () => addWorktree(p) },
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
    const items: MenuItem[] = [{ label: "New session", onClick: () => startSession(g, p, u) }];
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

  const sessionMenu = (g: Space, p: Project, u: BranchUnit, s: SessionMeta): MenuItem[] => [
    { label: "New session", onClick: () => startSession(g, p, u) },
    { separator: true },
    { label: "Rename…", onClick: () => renameSession(s) },
    { label: s.archived ? "Unarchive" : "Archive", onClick: () => archiveSession(s) },
    { label: "Delete", danger: true, onClick: () => deleteSession(s) },
  ];

  function toggle(key: string) {
    const next = new Set(expanded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  }

  async function fetchSessions(folderPath: string) {
    try {
      const s = await invoke<SessionMeta[]>("list_sessions", { folder: folderPath });
      setSessions({ ...sessions(), [folderPath]: s });
      // Flag a recreated folder whose sessions predate it (auto-adopts otherwise).
      const hist = await invoke<boolean>("folder_historical", { folder: folderPath });
      setHistorical({ ...historical(), [folderPath]: hist });
    } catch {
      setSessions({ ...sessions(), [folderPath]: [] });
    }
  }

  // Adopt a historical folder's sessions: they move to the normal listing and the
  // choice persists across restarts.
  async function adoptFolder(u: BranchUnit) {
    try {
      await invoke("adopt_path", { path: u.folderPath });
      setHistorical({ ...historical(), [u.folderPath]: false });
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshSessions() {
    const updated: Record<string, SessionMeta[]> = { ...sessions() };
    for (const folder of Object.keys(updated)) {
      try {
        updated[folder] = await invoke<SessionMeta[]>("list_sessions", { folder });
      } catch {
        /* keep stale */
      }
    }
    setSessions(updated);
  }

  // After config loads, re-hydrate sessions for restored-open branch-units.
  async function restoreOpen(cfg: ResolvedConfig) {
    for (const g of cfg.spaces) {
      for (const p of g.projects) {
        // A non-git folder anchors sessions on the project row (pkey), not a branch
        // node (ukey), so re-hydrate it when the project itself is open.
        if (projectKind(p) === "plain-dir") {
          if (expanded().has(pkey(g, p)) && p.branchUnits[0]) {
            await fetchSessions(p.branchUnits[0].folderPath);
          }
          continue;
        }
        for (const u of p.branchUnits) {
          if (expanded().has(ukey(g, p, u))) await fetchSessions(u.folderPath);
        }
      }
    }
  }

  const pkey = (g: Space, p: Project) => `p:${g.name}/${p.name}`;
  const ukey = (g: Space, p: Project, u: BranchUnit) => `u:${g.name}/${p.name}/${u.label}`;
  const hkey = (u: BranchUnit) => `h:${u.folderPath}`; // "Historical" sub-section
  const isHistorical = (u: BranchUnit) => historical()[u.folderPath] === true;

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
    if (!(await ensureBranch(p, u, u.branch))) return false;
    props.onSelect({
      spaceName: g.name,
      projectName: p.name,
      projectPath: p.path,
      folderPath: u.folderPath,
      branch: unitLabel(u),
      projectKind: u.kind,
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

  async function selectSession(g: Space, p: Project, u: BranchUnit, s: SessionMeta) {
    // A Claude session wants its recorded branch checked out; pi has no branch.
    const target = s.agent === "pi" ? null : s.branch || u.branch;
    if (!(await ensureBranch(p, u, target))) return;
    props.onSelect({
      spaceName: g.name,
      projectName: p.name,
      projectPath: p.path,
      folderPath: u.folderPath,
      branch: unitLabel(u),
      projectKind: u.kind,
      recordedBranch: s.branch || undefined,
      agent: s.agent,
      sessionId: s.id,
      sessionPath: s.path,
      sessionFile: s.path,
      sessionCwd: s.cwd,
      sessionTitle: s.title,
      sessionName: s.name,
      sessionArchived: s.archived,
    });
  }

  // A branch-unit reads as selected when it is the direct selection OR when a
  // session under it is (its sessions carry the unit's folderPath + label), so
  // the branch stays highlighted as the context while a session is open.
  function unitSelected(u: BranchUnit) {
    const s = props.selected;
    return s != null && s.folderPath === u.folderPath && s.branch === unitLabel(u);
  }

  // The session listing for one branch-unit (an optional "Historical" sub-section +
  // the session rows). Extracted so it renders both under a branch node (sub2) and
  // directly under a non-git folder that has no branch node (sub1). `sub` is the
  // session rows' indent class; the historical header sits at the same level.
  function sessionRows(g: Space, p: Project, u: BranchUnit, sub: "sub1" | "sub2") {
    const histSub = sub;
    return (
      <>
        <Show when={isHistorical(u)}>
          <div
            class={`${styles.row} ${styles.dim} ${styles[histSub]} ${styles.historical}`}
            onClick={() => toggle(hkey(u))}
            title="Sessions predating this recreated folder"
          >
            <Chevron open={expanded().has(hkey(u))} />
            <span class={styles.label}>Historical ({unitSessions(p, u).length})</span>
            <Button
              variant="ghost"
              size="xs"
              style={{ "margin-left": "auto" }}
              title="Adopt these sessions into the normal listing"
              onClick={(e) => {
                e.stopPropagation();
                adoptFolder(u);
              }}
            >
              Adopt
            </Button>
          </div>
        </Show>
        <Show when={!isHistorical(u) || expanded().has(hkey(u))}>
          <For each={unitSessions(p, u)} fallback={<div class={`${styles.row} ${styles.dim} ${styles[sub]}`}>no sessions</div>}>
            {(s) => {
              const badge = sessionBadge(p, u, s);
              return (
                <div
                  class={`${styles.row} ${styles.session} ${styles[sub]} ${props.selected?.sessionId === s.id ? styles.sel : ""}`}
                  onClick={() => selectSession(g, p, u, s)}
                  onContextMenu={(e) => openMenu(e, sessionMenu(g, p, u, s))}
                  title={s.name || s.title}
                  draggable={true}
                  onDragStart={(e) => startAbsDrag(e, s.path)}
                >
                  <Show when={s.agent === "pi"} fallback={<ClaudeIcon />}>
                    <PiIcon />
                  </Show>
                  <span class={styles.label}>{s.name || s.title}</span>
                  <Show when={badge}>
                    <span
                      class={`${styles.badge} ${badge!.hint ? styles.hint : ""}`}
                      title={
                        badge!.hint
                          ? "Branchless session: files reflect the current checkout"
                          : "Recorded on a branch other than the current checkout"
                      }
                    >
                      {badge!.text}
                    </span>
                  </Show>
                  <span class={styles.when}>{ago(s.last_active)}</span>
                </div>
              );
            }}
          </For>
        </Show>
      </>
    );
  }

  // The plain unit that owns re-homed sessions: the current checkout, else the
  // branchless folder fallback (detached/unborn HEAD), else the first plain unit.
  // A key (branch, or a sentinel for the branchless unit) identifies it uniquely,
  // since a plain project's units share one folder and differ only by branch.
  const plainUnitKey = (u: BranchUnit) => u.branch ?? "\0folder";
  function fallbackHome(p: Project): BranchUnit | null {
    const plain = p.branchUnits.filter((u) => u.kind === "plain");
    return (
      plain.find((u) => u.isCurrent) ??
      plain.find((u) => u.branch == null) ??
      plain[0] ??
      null
    );
  }

  // Attach a folder's sessions to the most-specific branch-unit. Worktree /
  // plain-dir / incomplete units own a distinct folder, so all of it is theirs.
  // Plain units share one repo folder, so split Claude sessions by recorded
  // branch. A session whose recorded branch has no visible unit (detached or
  // deleted) is an orphan: it re-homes onto the fallback unit so history is never
  // lost. Branchless (pi) sessions likewise park on the fallback (the checkout).
  function unitSessions(p: Project, u: BranchUnit): SessionMeta[] {
    const all = (sessions()[u.folderPath] ?? [])
      .filter((s) => !s.archived)
      .filter(sessionVisible);
    if (u.kind !== "plain") return all;
    const visible = new Set(
      p.branchUnits.filter((x) => x.kind === "plain" && x.branch).map((x) => x.branch),
    );
    const home = fallbackHome(p);
    const isHome = home != null && plainUnitKey(u) === plainUnitKey(home);
    return all.filter((s) => {
      if (s.agent === "pi") return isHome;
      const b = s.branch || "";
      if (b && visible.has(b)) return (u.branch || "") === b;
      return isHome; // orphaned recorded branch (or branchless claude): re-home
    });
  }

  // Per-session flag: a Claude session recorded on a branch other than the
  // current checkout, or a branchless (pi) session whose files are the checkout.
  function sessionBadge(p: Project, u: BranchUnit, s: SessionMeta): { text: string; hint: boolean } | null {
    if (u.kind !== "plain") return null;
    if (s.agent === "pi") return { text: "≈ checkout", hint: true };
    const cur = currentBranch(p);
    if (s.branch && cur && s.branch !== cur) return { text: `≠ ${s.branch}`, hint: false };
    return null;
  }

  // --- filtering ---
  const q = () => query().trim().toLowerCase();
  function sessionText(s: SessionMeta) {
    return (s.name || s.title).toLowerCase();
  }
  function sessionsMatch(p: Project) {
    if (!q()) return false;
    return p.branchUnits.some((u) =>
      (sessions()[u.folderPath] ?? []).some((s) => sessionText(s).includes(q())),
    );
  }
  function projectVisible(p: Project) {
    if (!q()) return true;
    return p.name.toLowerCase().includes(q()) || sessionsMatch(p);
  }
  function sessionVisible(s: SessionMeta) {
    return !q() || sessionText(s).includes(q());
  }

  let unlistenConfig: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  let unlistenFetchDone: UnlistenFn | undefined;
  let unlistenFetchError: UnlistenFn | undefined;
  let offSearch: (() => void) | undefined;
  let offRefresh: (() => void) | undefined;
  let offToast: (() => void) | undefined;
  onMount(async () => {
    await invoke("config_watch_start").catch(() => {});
    await invoke("sessions_watch_start").catch(() => {});
    await loadConfig();
    const cfg = config();
    if (cfg) await restoreOpen(cfg);
    unlistenConfig = await listen("config://changed", () => loadConfig());
    unlistenSessions = await listen("sessions://changed", () => refreshSessions());
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
    offSearch = onEvent(FOCUS_SEARCH, () => searchEl?.focus());
    offRefresh = onEvent(SESSIONS_REFRESH, () => refreshSessions());
    offToast = onWith<ToastEvent>(TOAST, (d) => setError(d.message, d.kind ?? "error"));
  });
  onCleanup(() => {
    unlistenConfig?.();
    unlistenSessions?.();
    unlistenFetchDone?.();
    unlistenFetchError?.();
    offSearch?.();
    offRefresh?.();
    offToast?.();
  });

  // One space tile for the bottom bar: its icon when set, else the name's
  // initial; active-marked, with its context menu and drag payload (all of the
  // space's project paths).
  const spaceTile = (g: Space) => (
    <button
      class={styles.space}
      classList={{
        [styles.active]: activeSpace()?.name === g.name,
        [styles.dragging]: dragSpace() === g.name,
        [styles.dropBefore]: dropHint()?.name === g.name && !dropHint()!.after,
        [styles.dropAfter]: dropHint()?.name === g.name && dropHint()!.after,
      }}
      title={g.external ? `${g.name} (pinned)` : g.name}
      onClick={() => setActiveSpaceName(g.name)}
      onContextMenu={(e) => openMenu(e, spaceMenu(g))}
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
        {(glyph) => <Icon icon={glyph()} size={18} />}
      </Show>
    </button>
  );

  return (
    <div class={styles.tree}>
      <div class={styles.treeSearch}>
        <input
          ref={searchEl}
          class={styles.searchInput}
          placeholder="Filter projects / sessions (⌘P)"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
      </div>

      <div class={styles.treeScroll}>
        <For each={activeProjects()}>
          {(p) => {
            const g = activeSpace()!;
            const popen = () => expanded().has(pkey(g, p));
            // A non-git folder has no branch node: the project row is the
            // session anchor, so clicking it selects the single unit and its
            // sessions render directly beneath (nothing but its own sessions,
            // never a same-named branch stub).
            const plainDir = () => projectKind(p) === "plain-dir";
            const folderUnit = () => p.branchUnits[0];
            return (
              <div class="node">
                <div
                  class={`${styles.row} ${styles.project}`}
                  onClick={() => {
                    toggle(pkey(g, p));
                    if (plainDir() && folderUnit()) {
                      fetchSessions(folderUnit().folderPath);
                      selectUnit(g, p, folderUnit());
                    }
                  }}
                  onContextMenu={(e) => openMenu(e, projectMenu(g, p))}
                  draggable={true}
                  onDragStart={(e) => startAbsDrag(e, p.path)}
                >
                  <span class={styles.rowIcon}><Icon icon={projectIcon(projectKind(p))} size={14} /></span>
                  <span class={styles.label}>{p.name}</span>
                  <RowChevron open={popen()} />
                </div>
                <Show when={popen()}>
                  <Show
                    when={!plainDir()}
                    fallback={
                      <Show when={folderUnit()}>
                        {sessionRows(g, p, folderUnit(), "sub1")}
                      </Show>
                    }
                  >
                  <For
                    each={p.branchUnits}
                    fallback={<div class={`${styles.row} ${styles.dim} ${styles.sub1}`}>no branches</div>}
                  >
                    {(u) => {
                      const uopen = () => expanded().has(ukey(g, p, u));
                      return (
                        <div class={`node ${styles.branchNode}`}>
                          <div
                            class={`${styles.row} ${styles.branch} ${styles.sub1} ${unitSelected(u) ? styles.sel : ""}`}
                            onClick={() => {
                              toggle(ukey(g, p, u));
                              fetchSessions(u.folderPath);
                              selectUnit(g, p, u);
                            }}
                            onContextMenu={(e) => openMenu(e, unitMenu(g, p, u))}
                            draggable={true}
                            onDragStart={(e) => startAbsDrag(e, u.folderPath)}
                          >
                            <span class={styles.label}>{unitLabel(u)}</span>
                            <Show when={u.kind === "incomplete"}>
                              <span class={`${styles.badge} ${styles.hint}`} title="A .bare with no worktrees (right-click to add one or remove it)">stub</span>
                            </Show>
                            <Show when={u.isCurrent}>
                              <span class={styles.dot} title="current checkout">●</span>
                            </Show>
                            <RowChevron open={uopen()} />
                          </div>
                          <Show when={uopen()}>
                            {sessionRows(g, p, u, "sub2")}
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                  </Show>
                </Show>
              </div>
            );
          }}
        </For>

        <Show when={(config()?.spaces ?? []).length > 0 && activeProjects().length === 0}>
          <div class={`${styles.row} ${styles.dim} ${styles.sub1}`}>
            {q() ? "no matches in this space" : "no projects in this space"}
          </div>
        </Show>

        <Show when={(config()?.spaces ?? []).length === 0}>
          <div class="tree-empty">
            <Show
              when={(config()?.roots?.length ?? 0) === 0}
              fallback={
                <>
                  <p>No projects found under your base folders.</p>
                  <Button onClick={addSpace}>+ Create space</Button>
                  <Button variant="ghost" onClick={addBaseFolder}>Add another base folder</Button>
                </>
              }
            >
              <p>Welcome to Sway. Add a base folder to discover your projects.</p>
              <Button onClick={addBaseFolder}>Add base folder</Button>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={config()}>
        <div class={styles.spaceBar}>
          <div class={styles.gearWrap} ref={gearEl}>
            <button
              class={styles.gearBtn}
              classList={{ [styles.active]: gearOpen() }}
              title="Sidebar actions"
              onClick={() => setGearOpen(!gearOpen())}
            >
              <Icon icon={Settings} />
            </button>
            <Show when={gearOpen()}>
              <div class={styles.gearMenu}>
                <Show when={hasRoot()}>
                  <div class={styles.gearItem} onClick={() => gearAction(addSpace)}>
                    <Icon icon={FolderPlus} size={14} />New space
                  </div>
                </Show>
                <div class={styles.gearItem} onClick={() => gearAction(pinFolder)}>
                  <Icon icon={Pin} size={14} />Pin folder to "Other"
                </div>
                <div class={styles.gearDivider} />
                <div class={styles.gearItem} onClick={() => gearAction(addBaseFolder)}>
                  <Icon icon={FolderOpen} size={14} />Add/Update root
                </div>
                <Show when={hasRoot()}>
                  <div class={`${styles.gearItem} ${styles.danger}`} onClick={() => gearAction(resetRoot)}>
                    <Icon icon={RotateCcw} size={14} />Reset root (forget only)
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          <div class={styles.spaceScroll}>
            <For each={rootSpaces()}>{(g) => spaceTile(g)}</For>
            <Show when={rootSpaces().length > 0 && extSpaces().length > 0}>
              <div class={styles.spaceDivider} />
            </Show>
            <For each={extSpaces()}>{(g) => spaceTile(g)}</For>
          </div>

          <Show when={hasRoot()}>
            <button class={styles.spaceAdd} title="New space" onClick={addSpace}>
              <Icon icon={Plus} size={16} />
            </button>
          </Show>
        </div>
      </Show>

      <Show when={menu()}>
        <ContextMenu menu={menu()!} onClose={() => setMenu(null)} />
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

      <Show when={spaceReq()}>
        <SpaceDialog
          mode={spaceReq()!.mode}
          name={spaceReq()!.name}
          icon={spaceReq()!.icon}
          busy={spaceReq()!.busy}
          onConfirm={(opts) => confirmSpace(opts)}
          onCancel={() => setSpaceReq(null)}
        />
      </Show>

      <Toasts toasts={toasts()} onDismiss={dismissToast} />
    </div>
  );
}
