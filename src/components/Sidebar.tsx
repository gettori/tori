import { createSignal, For, Show, onMount, onCleanup, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { on as onEvent, FOCUS_SEARCH, SESSIONS_REFRESH, DRAG_ABS_PATH_MIME } from "../events";
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
type Project = { name: string; path: string; branchUnits: BranchUnit[] };
type Group = { name: string; projects: Project[] };
type ResolvedConfig = { path: string; groups: Group[] };
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
  let searchEl: HTMLInputElement | undefined;

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
      setConfig(await invoke<ResolvedConfig>("get_config"));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

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

  function selectUnit(p: Project, u: BranchUnit) {
    props.onSelect({
      projectName: p.name,
      projectPath: p.path,
      folderPath: u.folderPath,
      branch: unitLabel(u),
      projectKind: u.kind,
    });
  }

  function selectSession(p: Project, u: BranchUnit, s: SessionMeta) {
    props.onSelect({
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
      </div>

      <Show when={error()}>
        <div class="tree-error">{error()}</div>
      </Show>

      <div class="tree-scroll">
        <For each={(config()?.groups ?? []).filter(groupVisible)}>
          {(g) => {
            const open = () => expanded().has(gkey(g)) || !!q();
            return (
              <div class="node">
                <div
                  class="row group"
                  onClick={() => toggle(gkey(g))}
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
                                        selectUnit(p, u);
                                      }}
                                      draggable={true}
                                      onDragStart={(e) => startAbsDrag(e, u.folderPath)}
                                    >
                                      <Chevron open={uopen()} />
                                      <span class="label">{unitLabel(u)}</span>
                                      <Show when={u.kind === "incomplete"}>
                                        <span class="badge hint" title="A .bare with no worktrees (cleanable stub)">stub</span>
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
                                              onClick={() => selectSession(p, u, s)}
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
            );
          }}
        </For>
      </div>

      <Show when={config()}>
        <div class="tree-foot" title={config()!.path}>
          {config()!.path.replace(/^.*\/\.config\//, "~/.config/")}
        </div>
      </Show>
    </div>
  );
}
