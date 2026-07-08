import { createSignal, For, Show, onMount, onCleanup, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ContextMenu, { type MenuItem, type MenuState } from "./ContextMenu";
import PromptModal from "./PromptModal";
import Toasts, { type Toast } from "./Toasts";
import {
  on as onEvent,
  emitWith,
  FOCUS_SEARCH,
  SESSIONS_REFRESH,
  DRAG_ABS_PATH_MIME,
  OPEN_TERMINAL,
  NEW_SESSION,
  type OpenTerminal,
  type NewSession,
} from "../events";
import ClaudeIcon from "../seti/ClaudeIcon";
import PiIcon from "../seti/PiIcon";
import Chevron from "./Chevron";

// Mark a drag from a sidebar row as carrying one or more absolute paths, which
// the terminal inserts verbatim as `@<abspath>` (newline-separated for a group).
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
type Group = { name: string; path: string; projects: Project[]; external: boolean };
type ResolvedConfig = { path: string; roots: string[]; groups: Group[] };
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
  groupName: string;
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

export default function Sidebar(props: {
  selected: Selection | null;
  onSelect: (s: Selection) => void;
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
  // under a collapsed "Historical" group until adopted.
  const [historical, setHistorical] = createSignal<Record<string, boolean>>({});
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

  // Render order: root-discovered groups first, pinned externals after (under the
  // "Other" divider). The divider is drawn before the first external group.
  const visibleGroups = () => {
    const gs = (config()?.groups ?? []).filter(groupVisible);
    return [...gs.filter((g) => !g.external), ...gs.filter((g) => g.external)];
  };
  const firstExternalIdx = () => visibleGroups().findIndex((g) => g.external);

  // Per-node right-click menu. Set on `contextmenu`, cleared on close.
  const [menu, setMenu] = createSignal<MenuState | null>(null);

  // In-app replacement for window.prompt (unimplemented in WKWebView). Holds the
  // pending request plus its resolver; askText opens the modal and awaits an
  // answer, resolving with the entered string or null on cancel.
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
      const folders = cfg.groups.flatMap((g) =>
        g.projects.flatMap((p) => p.branchUnits.map((u) => u.folderPath)),
      );
      invoke("seed_adopted", { folders }).catch(() => {});
      // Seed each plain repo's attached-branch set once (origin default, else the
      // checkout), so it shows a sensible branch instead of every local branch.
      const plainRepos = cfg.groups
        .flatMap((g) => g.projects)
        .filter((p) => p.branchUnits.some((u) => u.kind === "plain"))
        .map((p) => p.path);
      for (const repo of plainRepos) invoke("seed_attached", { repo }).catch(() => {});
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
    if (!confirm("Forget the base folder? Nothing on disk is deleted; the tree returns to its first-run state.")) {
      return;
    }
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

  async function addGroup() {
    const roots = config()?.roots ?? [];
    if (!roots.length) return;
    const name = await askText("New group name:");
    if (!name) return;
    try {
      await invoke("add_group", { root: roots[0], name });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  async function addFolder(g: Group) {
    const name = await askText(`New folder in "${g.name}":`);
    if (!name) return;
    try {
      await invoke("add_folder", { groupPath: g.path, name });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  function badName(name: string): string | null {
    const n = name.trim();
    if (!n) return "Name is empty";
    if (n.includes("/") || n.includes("\\")) return "Name cannot contain a slash";
    if (n.startsWith(".")) return "Name cannot start with a dot";
    return null;
  }

  function nameFromUrl(url: string): string {
    const last = url.replace(/\/+$/, "").split("/").pop() ?? "";
    return last.replace(/\.git$/, "");
  }

  // Pre-check the target dir is free, then run the command in a terminal tab
  // (native git progress + ambient auth, no in-app credentials). The terminal
  // area re-discovers when the tab exits.
  async function runInTab(g: Group, name: string, kind: string, program: string, args: string[]) {
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

  async function cloneRepo(g: Group) {
    const url = await askText("Repository URL to clone:");
    if (!url?.trim()) return;
    const name = (await askText("Folder name:", nameFromUrl(url))) ?? "";
    if (!name) return;
    await runInTab(g, name, "clone", "git", ["clone", url.trim(), name.trim()]);
  }

  async function bootstrapRepo(g: Group) {
    const url = await askText("Repository URL for a bare + worktree project:");
    if (!url?.trim()) return;
    const name = (await askText("Project folder name:", nameFromUrl(url))) ?? "";
    if (!name) return;
    // url/name pass as $1/$2 (never interpolated), so there is no shell injection.
    await runInTab(g, name, "bootstrap", "sh", ["-c", BOOTSTRAP_SCRIPT, "sway", url.trim(), name.trim()]);
  }

  async function cleanupStub(u: BranchUnit) {
    if (!confirm("Remove this incomplete stub (a .bare with no worktrees)?")) return;
    try {
      await invoke("cleanup_incomplete", { path: u.folderPath });
    } catch (e) {
      setError(String(e));
    }
  }

  // --- worktree lifecycle ---

  // Create a worktree under a bare container. The backend names the folder
  // (branch's last segment, slug fallback, clean error on double collision),
  // fetches + bases new branches on origin's default, and links shared .link/ files.
  async function createWorktree(p: Project) {
    const branch = await askText(`New worktree in "${p.name}" (branch name):`);
    if (!branch?.trim()) return;
    try {
      await invoke("create_worktree", { repoPath: p.path, branch: branch.trim() });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Shared pre-removal guards for a worktree: open in the editor, a dirty tree, or
  // a live agent nested inside (in it or any subdir). Returns an error message to
  // show, or null when removal is clear. Nothing is deleted here.
  async function worktreeRemovalBlock(u: BranchUnit): Promise<string | null> {
    const sel = props.selected;
    if (sel && (sel.folderPath === u.folderPath || sel.folderPath.startsWith(`${u.folderPath}/`))) {
      return "This worktree is open in the editor; switch away before removing it.";
    }
    if (await invoke<boolean>("worktree_dirty", { path: u.folderPath })) {
      return "This worktree has uncommitted changes; commit or discard them first.";
    }
    // Prefix-matched nested sessions: refuse if any is a live agent.
    const nested = await invoke<SessionMeta[]>("list_sessions", { folder: u.folderPath });
    for (const s of nested) {
      if (await invoke<boolean>("session_running", { id: s.id })) {
        return "An agent is running in this worktree (or a subdir); stop it first.";
      }
    }
    return null;
  }

  // Remove a worktree folder, keeping its branch. Guarded against live use.
  async function removeWorktree(p: Project, u: BranchUnit) {
    try {
      const block = await worktreeRemovalBlock(u);
      if (block) return setError(block);
      if (!confirm(`Remove the worktree "${u.label}"? Its folder is deleted; the branch is kept.`)) return;
      await invoke("remove_worktree", { repoPath: p.path, worktreePath: u.folderPath });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Remove a worktree AND delete its branch. Same guards; on a `-D` failure the
  // backend has already removed the folder and re-emitted, so its explicit
  // "folder removed, branch not deleted" message surfaces here (no swallowed partial).
  async function deleteWorktreeAndBranch(p: Project, u: BranchUnit) {
    if (!u.branch) return;
    try {
      const block = await worktreeRemovalBlock(u);
      if (block) return setError(block);
      if (!confirm(`Delete the worktree "${u.label}" AND its branch "${u.branch}"? Both the folder and the branch are removed.`)) {
        return;
      }
      await invoke("remove_worktree_and_branch", {
        repoPath: p.path,
        worktreePath: u.folderPath,
        branch: u.branch,
      });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // "Update .links/": restore any shared `.link/` file deleted from a worktree.
  async function relinkWorktrees(p: Project) {
    try {
      await invoke("relink_worktrees", { repoPath: p.path });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // --- plain-dir git lifecycle ---

  // Initialize git in a plain-dir (optional initial branch); re-discovers as plain.
  async function initRepo(p: Project) {
    const branch = await askText(`Initialize git in "${p.name}". Initial branch (blank = git default):`);
    if (branch === null) return; // cancelled
    try {
      await invoke("git_init", { projectPath: p.path, branch: branch.trim() || null });
      await loadConfig();
    } catch (e) {
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

  // --- plain-repo branch actions (attach/detach model) ---

  // Create a branch at HEAD (attached + shown immediately by new_branch), then
  // switch to it. The switch is a same-commit checkout, so it changes no files and
  // needs no working-tree confirm; the branch persists even if the switch fails.
  async function newBranch(p: Project) {
    const name = await askText(`New branch in "${p.name}" (from HEAD):`);
    if (!name?.trim()) return;
    const branch = name.trim();
    try {
      await invoke("new_branch", { repo: p.path, branch });
    } catch (e) {
      return setError(String(e));
    }
    try {
      await invoke("git_checkout", { repoPath: p.path, branch });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Attach an already-existing local branch, chosen from those not yet visible.
  async function attachExisting(p: Project) {
    let branches: Branch[];
    try {
      branches = await invoke<Branch[]>("list_branches", { path: p.path });
    } catch (e) {
      return setError(String(e));
    }
    const visible = new Set(
      p.branchUnits.filter((u) => u.kind === "plain" && u.branch).map((u) => u.branch),
    );
    const candidates = branches.map((b) => b.name).filter((n) => !visible.has(n));
    if (candidates.length === 0) {
      return setError("Every local branch is already attached.");
    }
    const name = await askText(`Attach which branch?  (${candidates.join(", ")})`);
    if (!name?.trim()) return;
    if (!candidates.includes(name.trim())) {
      return setError(`"${name.trim()}" is not an attachable local branch.`);
    }
    try {
      await invoke("attach_branch", { repo: p.path, branch: name.trim() });
    } catch (e) {
      setError(String(e));
    }
  }

  // Switch the shared working tree to this branch (runs the checkout guard).
  async function checkoutUnit(g: Group, p: Project, u: BranchUnit) {
    await selectUnit(g, p, u);
  }

  // Remove a branch from the visible list (git branch untouched). Its sessions
  // re-home onto the current checkout, so nothing is lost.
  async function detachBranch(p: Project, u: BranchUnit) {
    if (!u.branch) return;
    try {
      await invoke("detach_branch", { repo: p.path, branch: u.branch });
    } catch (e) {
      setError(String(e));
    }
  }

  // Delete the branch for real (`git branch -D`) and prune the store entry.
  async function deleteBranch(p: Project, u: BranchUnit) {
    if (!u.branch) return;
    if (!confirm(`Delete branch "${u.branch}"? This runs git branch -D and cannot be undone.`)) {
      return;
    }
    try {
      await invoke("delete_branch", { repo: p.path, branch: u.branch });
    } catch (e) {
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
    if (!confirm("Delete this session's transcript? Its history is removed and cannot be undone.")) return;
    try {
      await invoke("delete_session", { path: s.path });
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  // --- per-node context menus ---

  // Create/clone/bootstrap target the root tree; an external ("Other") group is
  // just a pin's parent dir, so it gets no group-level actions (unpin is per
  // project, in projectMenu).
  const groupMenu = (g: Group): MenuItem[] =>
    g.external
      ? []
      : [
          { label: "New folder", onClick: () => addFolder(g) },
          { separator: true },
          { label: "Clone repo…", onClick: () => cloneRepo(g) },
          { label: "Bare + worktree…", onClick: () => bootstrapRepo(g) },
        ];

  // A project's git kind comes from its branch-units (all share one kind).
  const projectKind = (p: Project) => p.branchUnits[0]?.kind;

  // External (pinned) projects can be unpinned. Otherwise the menu is keyed by
  // git kind: a worktree container spawns worktrees, a plain-dir initializes git,
  // a plain repo commits / sets a remote / pushes.
  const projectMenu = (p: Project): MenuItem[] => {
    if (p.external) return [{ label: "Unpin", onClick: () => unpinPath(p) }];
    switch (projectKind(p)) {
      case "worktree":
        return [
          { label: "Add Origin", onClick: () => addRemote(p) },
          { label: "New worktree…", onClick: () => createWorktree(p) },
          { label: "Update .links/", onClick: () => relinkWorktrees(p) },
        ];
      case "plain-dir":
        return [{ label: "Initialize git repo…", onClick: () => initRepo(p) }];
      case "plain":
        return [
          { label: "New Branch", onClick: () => newBranch(p) },
          { label: "Attach Existing Branch", onClick: () => attachExisting(p) },
          { separator: true },
          { label: "Add / set remote…", onClick: () => addRemote(p) },
        ];
      default:
        return [];
    }
  };

  const unitMenu = (g: Group, p: Project, u: BranchUnit): MenuItem[] => {
    // An incomplete stub (a .bare with no worktree) has nothing to run; its only
    // action is removal.
    if (u.kind === "incomplete") {
      return [{ label: "Remove stub", danger: true, onClick: () => cleanupStub(u) }];
    }
    const items: MenuItem[] = [{ label: "New session", onClick: () => startSession(g, p, u) }];
    if (u.kind === "worktree") {
      items.push({ separator: true });
      items.push({ label: "Remove worktree", danger: true, onClick: () => removeWorktree(p, u) });
      items.push({ label: "Delete worktree + branch", danger: true, onClick: () => deleteWorktreeAndBranch(p, u) });
    }
    // Plain branch-unit: checkout always; detach/delete only off the current
    // checkout and only when the unit actually has a branch (never the folder fallback).
    if (u.kind === "plain" && u.branch != null) {
      items.push({ separator: true });
      items.push({ label: "Checkout", onClick: () => checkoutUnit(g, p, u) });
      if (!u.isCurrent) {
        items.push({ label: "Detach Branch", onClick: () => detachBranch(p, u) });
        items.push({ label: "Delete Branch", danger: true, onClick: () => deleteBranch(p, u) });
      }
    }
    return items;
  };

  const sessionMenu = (g: Group, p: Project, u: BranchUnit, s: SessionMeta): MenuItem[] => [
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
    for (const g of cfg.groups) {
      for (const p of g.projects) {
        for (const u of p.branchUnits) {
          if (expanded().has(ukey(g, p, u))) await fetchSessions(u.folderPath);
        }
      }
    }
  }

  const gkey = (g: Group) => `g:${g.name}`;
  const pkey = (g: Group, p: Project) => `p:${g.name}/${p.name}`;
  const ukey = (g: Group, p: Project, u: BranchUnit) => `u:${g.name}/${p.name}/${u.label}`;
  const hkey = (u: BranchUnit) => `h:${u.folderPath}`; // "Historical" sub-group
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
    if (!confirm(`Switch ${p.name} from "${cur}" to "${target}"?\nThis changes the shared working tree.`)) {
      return false;
    }
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

  async function selectUnit(g: Group, p: Project, u: BranchUnit): Promise<boolean> {
    if (!(await ensureBranch(p, u, u.branch))) return false;
    props.onSelect({
      groupName: g.name,
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
  async function startSession(g: Group, p: Project, u: BranchUnit) {
    if (await selectUnit(g, p, u)) {
      emitWith<NewSession>(NEW_SESSION, { folderPath: u.folderPath, projectName: p.name });
    }
  }

  async function selectSession(g: Group, p: Project, u: BranchUnit, s: SessionMeta) {
    // A Claude session wants its recorded branch checked out; pi has no branch.
    const target = s.agent === "pi" ? null : s.branch || u.branch;
    if (!(await ensureBranch(p, u, target))) return;
    props.onSelect({
      groupName: g.name,
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

  function unitSelected(u: BranchUnit) {
    const s = props.selected;
    return (
      s != null &&
      s.folderPath === u.folderPath &&
      s.branch === unitLabel(u) &&
      s.sessionId == null
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

  // A plain branch-unit that is not the current checkout: opening anything under
  // it shows the current tree, not this branch.
  function unitMismatch(u: BranchUnit) {
    return u.kind === "plain" && !u.isCurrent;
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
  function groupVisible(g: Group) {
    if (!q()) return true;
    return g.name.toLowerCase().includes(q()) || g.projects.some(projectVisible);
  }
  function sessionVisible(s: SessionMeta) {
    return !q() || sessionText(s).includes(q());
  }

  let unlistenConfig: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  let offSearch: (() => void) | undefined;
  let offRefresh: (() => void) | undefined;
  onMount(async () => {
    await invoke("config_watch_start").catch(() => {});
    await invoke("sessions_watch_start").catch(() => {});
    await loadConfig();
    const cfg = config();
    if (cfg) await restoreOpen(cfg);
    unlistenConfig = await listen("config://changed", () => loadConfig());
    unlistenSessions = await listen("sessions://changed", () => refreshSessions());
    offSearch = onEvent(FOCUS_SEARCH, () => searchEl?.focus());
    offRefresh = onEvent(SESSIONS_REFRESH, () => refreshSessions());
  });
  onCleanup(() => {
    unlistenConfig?.();
    unlistenSessions?.();
    offSearch?.();
    offRefresh?.();
  });

  return (
    <div class="tree">
      <div class="tree-search">
        <input
          ref={searchEl}
          class="search-input"
          placeholder="Filter projects / sessions (⌘P)"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
        <div class="gear-wrap" ref={gearEl}>
          <button
            class="gear-btn"
            classList={{ active: gearOpen() }}
            title="Sidebar actions"
            onClick={() => setGearOpen(!gearOpen())}
          >
            ⚙
          </button>
          <Show when={gearOpen()}>
            <div class="gear-menu">
              <Show when={hasRoot()}>
                <div class="gear-item" onClick={() => gearAction(addGroup)}>New group</div>
              </Show>
              <div class="gear-item" onClick={() => gearAction(pinFolder)}>Pin folder to "Other"</div>
              <div class="gear-divider" />
              <div class="gear-item" onClick={() => gearAction(addBaseFolder)}>Add/Update root</div>
              <Show when={hasRoot()}>
                <div class="gear-item danger" onClick={() => gearAction(resetRoot)}>Reset root (forget only)</div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <div class="tree-scroll">
        <For each={visibleGroups()}>
          {(g, i) => {
            const open = () => expanded().has(gkey(g)) || !!q();
            return (
              <>
              <Show when={g.external && i() === firstExternalIdx()}>
                <div class="tree-divider" title="Pinned folders outside your base folder">Other</div>
              </Show>
              <div class="node">
                <div
                  class="row group"
                  onClick={() => toggle(gkey(g))}
                  onContextMenu={(e) => openMenu(e, groupMenu(g))}
                  draggable={true}
                  onDragStart={(e) => startAbsDrag(e, g.projects.map((p) => p.path))}
                >
                  <Chevron open={open()} />
                  <span class="label">{g.name}</span>
                </div>
                <Show when={open()}>
                  <For each={g.projects.filter(projectVisible)}>
                    {(p) => {
                      const popen = () => expanded().has(pkey(g, p));
                      return (
                        <div class="node">
                          <div
                            class="row project sub1"
                            onClick={() => toggle(pkey(g, p))}
                            onContextMenu={(e) => openMenu(e, projectMenu(p))}
                            draggable={true}
                            onDragStart={(e) => startAbsDrag(e, p.path)}
                          >
                            <Chevron open={popen()} />
                            <span class="label">{p.name}</span>
                          </div>
                          <Show when={popen()}>
                            <For
                              each={p.branchUnits}
                              fallback={<div class="row dim sub2">no branches</div>}
                            >
                              {(u) => {
                                const uopen = () => expanded().has(ukey(g, p, u));
                                return (
                                  <div class="node">
                                    <div
                                      class={`row branch sub2 ${unitSelected(u) ? "sel" : ""}`}
                                      onClick={() => {
                                        toggle(ukey(g, p, u));
                                        fetchSessions(u.folderPath);
                                        selectUnit(g, p, u);
                                      }}
                                      onContextMenu={(e) => openMenu(e, unitMenu(g, p, u))}
                                      draggable={true}
                                      onDragStart={(e) => startAbsDrag(e, u.folderPath)}
                                    >
                                      <Chevron open={uopen()} />
                                      <span class="label">{unitLabel(u)}</span>
                                      <Show when={u.kind === "incomplete"}>
                                        <span class="badge hint" title="A .bare with no worktrees (right-click to remove)">stub</span>
                                      </Show>
                                      <Show when={unitMismatch(u)}>
                                        <span class="badge" title="Not the current checkout">≠ checkout</span>
                                      </Show>
                                      <Show when={u.isCurrent}>
                                        <span class="dot" title="current checkout">●</span>
                                      </Show>
                                    </div>
                                    <Show when={uopen()}>
                                      <Show when={isHistorical(u)}>
                                        <div
                                          class="row dim sub3 historical"
                                          onClick={() => toggle(hkey(u))}
                                          title="Sessions predating this recreated folder"
                                        >
                                          <Chevron open={expanded().has(hkey(u))} />
                                          <span class="label">Historical ({unitSessions(p, u).length})</span>
                                          <button
                                            class="adopt-btn"
                                            title="Adopt these sessions into the normal listing"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              adoptFolder(u);
                                            }}
                                          >
                                            Adopt
                                          </button>
                                        </div>
                                      </Show>
                                      <Show when={!isHistorical(u) || expanded().has(hkey(u))}>
                                      <For
                                        each={unitSessions(p, u)}
                                        fallback={<div class="row dim sub3">no sessions</div>}
                                      >
                                        {(s) => {
                                          const badge = sessionBadge(p, u, s);
                                          return (
                                            <div
                                              class={`row session sub3 ${props.selected?.sessionId === s.id ? "sel" : ""}`}
                                              onClick={() => selectSession(g, p, u, s)}
                                              onContextMenu={(e) => openMenu(e, sessionMenu(g, p, u, s))}
                                              title={s.name || s.title}
                                              draggable={true}
                                              onDragStart={(e) => startAbsDrag(e, s.path)}
                                            >
                                              <Show when={s.agent === "pi"} fallback={<ClaudeIcon />}>
                                                <PiIcon />
                                              </Show>
                                              <span class="label">{s.name || s.title}</span>
                                              <Show when={badge}>
                                                <span
                                                  class={`badge ${badge!.hint ? "hint" : ""}`}
                                                  title={
                                                    badge!.hint
                                                      ? "Branchless session: files reflect the current checkout"
                                                      : "Recorded on a branch other than the current checkout"
                                                  }
                                                >
                                                  {badge!.text}
                                                </span>
                                              </Show>
                                              <span class="when">{ago(s.last_active)}</span>
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
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
              </>
            );
          }}
        </For>

        <Show when={(config()?.groups ?? []).length === 0}>
          <div class="tree-empty">
            <Show
              when={(config()?.roots?.length ?? 0) === 0}
              fallback={
                <>
                  <p>No projects found under your base folders.</p>
                  <button class="btn" onClick={addGroup}>+ Create group</button>
                  <button class="btn ghost" onClick={addBaseFolder}>Add another base folder</button>
                </>
              }
            >
              <p>Welcome to Sway. Add a base folder to discover your projects.</p>
              <button class="btn" onClick={addBaseFolder}>Add base folder</button>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={config()}>
        <div class="tree-foot" title={config()!.path}>
          {config()!.path.replace(/^.*\/\.config\//, "~/.config/")}
        </div>
      </Show>

      <Show when={menu()}>
        <ContextMenu menu={menu()!} onClose={() => setMenu(null)} />
      </Show>

      <Show when={promptReq()}>
        <PromptModal
          title={promptReq()!.title}
          initial={promptReq()!.initial}
          onSubmit={(v) => resolvePrompt(v)}
          onCancel={() => resolvePrompt(null)}
        />
      </Show>

      <Toasts toasts={toasts()} onDismiss={dismissToast} />
    </div>
  );
}
