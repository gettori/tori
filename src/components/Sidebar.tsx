import { createSignal, For, Show, onMount, onCleanup, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ContextMenu, { type MenuItem, type MenuState } from "./ContextMenu";
import {
  on as onEvent,
  emitWith,
  FOCUS_SEARCH,
  SESSIONS_REFRESH,
  DRAG_ABS_PATH_MIME,
  OPEN_TERMINAL,
  type OpenTerminal,
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
  const [error, setError] = createSignal("");
  const [expanded, setExpanded] = createSignal<Set<string>>(loadExpanded());
  // Sessions keyed by branch-unit folderPath (the cwd anchor).
  const [sessions, setSessions] = createSignal<Record<string, SessionMeta[]>>({});
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
    const name = prompt("New group name:");
    if (!name) return;
    try {
      await invoke("add_group", { root: roots[0], name });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  async function addFolder(g: Group) {
    const name = prompt(`New folder in "${g.name}":`);
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
    const url = prompt("Repository URL to clone:");
    if (!url?.trim()) return;
    const name = prompt("Folder name:", nameFromUrl(url)) ?? "";
    if (!name) return;
    await runInTab(g, name, "clone", "git", ["clone", url.trim(), name.trim()]);
  }

  async function bootstrapRepo(g: Group) {
    const url = prompt("Repository URL for a bare + worktree project:");
    if (!url?.trim()) return;
    const name = prompt("Project folder name:", nameFromUrl(url)) ?? "";
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
    const branch = prompt(`New worktree in "${p.name}" (branch name):`);
    if (!branch?.trim()) return;
    try {
      await invoke("create_worktree", { repoPath: p.path, branch: branch.trim() });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // Remove a worktree, guarded against live use: refuse if it is open in the
  // editor, has a dirty tree, or hosts a running agent (in it or any subdir).
  // Nothing is deleted when refused. The branch is kept; only the folder goes.
  async function removeWorktree(p: Project, u: BranchUnit) {
    const sel = props.selected;
    if (sel && (sel.folderPath === u.folderPath || sel.folderPath.startsWith(`${u.folderPath}/`))) {
      return setError("This worktree is open in the editor; switch away before removing it.");
    }
    try {
      if (await invoke<boolean>("worktree_dirty", { path: u.folderPath })) {
        return setError("This worktree has uncommitted changes; commit or discard them first.");
      }
      // Prefix-matched nested sessions: refuse if any is a live agent.
      const nested = await invoke<SessionMeta[]>("list_sessions", { folder: u.folderPath });
      for (const s of nested) {
        if (await invoke<boolean>("session_running", { id: s.id })) {
          return setError("An agent is running in this worktree (or a subdir); stop it first.");
        }
      }
      if (!confirm(`Remove the worktree "${u.label}"? Its folder is deleted; the branch is kept.`)) return;
      await invoke("remove_worktree", { repoPath: p.path, worktreePath: u.folderPath });
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  }

  // --- session overlay actions (rename/archive/delete) ---

  async function renameSession(s: SessionMeta) {
    const name = prompt("Rename session:", s.name ?? s.title);
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
          { label: "Clone repo…", onClick: () => cloneRepo(g) },
          { label: "Bootstrap bare + worktree…", onClick: () => bootstrapRepo(g) },
        ];

  // A bare-container ("worktree") project: its branch-units are worktree folders.
  const isWorktreeProject = (p: Project) => p.branchUnits.some((u) => u.kind === "worktree");

  // External (pinned) projects can be unpinned. A worktree container can spawn a
  // new worktree. Plain/plain-dir get their git lifecycle in Phase 5.
  const projectMenu = (p: Project): MenuItem[] => {
    if (p.external) return [{ label: "Unpin", onClick: () => unpinPath(p) }];
    if (isWorktreeProject(p)) return [{ label: "New worktree…", onClick: () => createWorktree(p) }];
    return [];
  };

  const unitMenu = (g: Group, p: Project, u: BranchUnit): MenuItem[] => {
    // An incomplete stub (a .bare with no worktree) has nothing to run; its only
    // action is removal.
    if (u.kind === "incomplete") {
      return [{ label: "Remove stub", danger: true, onClick: () => cleanupStub(u) }];
    }
    const items: MenuItem[] = [{ label: "New session", onClick: () => selectUnit(g, p, u) }];
    if (u.kind === "worktree") {
      items.push({ separator: true });
      items.push({ label: "Remove worktree", danger: true, onClick: () => removeWorktree(p, u) });
    }
    return items;
  };

  const sessionMenu = (g: Group, p: Project, u: BranchUnit, s: SessionMeta): MenuItem[] => [
    { label: "New session", onClick: () => selectUnit(g, p, u) },
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
    } catch {
      setSessions({ ...sessions(), [folderPath]: [] });
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

  async function selectUnit(g: Group, p: Project, u: BranchUnit) {
    if (!(await ensureBranch(p, u, u.branch))) return;
    props.onSelect({
      groupName: g.name,
      projectName: p.name,
      projectPath: p.path,
      folderPath: u.folderPath,
      branch: unitLabel(u),
      projectKind: u.kind,
    });
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

  // Attach a folder's sessions to the most-specific branch-unit. Worktree /
  // plain-dir / incomplete units own a distinct folder, so all of it is theirs.
  // Plain units share one repo folder, so split Claude sessions by recorded
  // branch and park branchless (pi) sessions on the current checkout.
  function unitSessions(u: BranchUnit): SessionMeta[] {
    const all = (sessions()[u.folderPath] ?? [])
      .filter((s) => !s.archived)
      .filter(sessionVisible);
    if (u.kind !== "plain") return all;
    return all.filter((s) => {
      if (s.agent === "pi") return u.isCurrent;
      return (s.branch || "") === (u.branch || "");
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
              <div class="gear-item" onClick={() => gearAction(addBaseFolder)}>Add base folder</div>
              <div class="gear-item" onClick={() => gearAction(pinFolder)}>Pin folder to "Other"</div>
              <Show when={hasRoot()}>
                <div class="gear-item danger" onClick={() => gearAction(resetRoot)}>Reset root (forget only)</div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <Show when={error()}>
        <div class="tree-error">{error()}</div>
      </Show>

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
                                      <For
                                        each={unitSessions(u)}
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
    </div>
  );
}
