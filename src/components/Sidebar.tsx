import { createSignal, For, Show, onMount, onCleanup, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { on as onEvent, FOCUS_SEARCH, FOCUS_SIDEBAR } from "../events";

type Project = { name: string; path: string };
type Group = { name: string; projects: Project[] };
type ResolvedConfig = { path: string; groups: Group[] };
type Branch = { name: string; current: boolean };
type SessionMeta = {
  id: string;
  cwd: string;
  branch: string;
  title: string;
  last_active: number;
};

export type Selection = {
  projectName: string;
  projectPath: string;
  branch: string;
  sessionId?: string;
  sessionTitle?: string;
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

const skey = (path: string, branch: string) => `${path}::${branch}`;

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
  openIds: Set<string>;
}) {
  const [config, setConfig] = createSignal<ResolvedConfig | null>(null);
  const [error, setError] = createSignal("");
  const [expanded, setExpanded] = createSignal<Set<string>>(loadExpanded());
  const [branches, setBranches] = createSignal<Record<string, Branch[]>>({});
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

  async function fetchBranches(p: Project) {
    if (branches()[p.path]) return;
    try {
      setBranches({ ...branches(), [p.path]: await invoke("list_branches", { path: p.path }) });
    } catch {
      setBranches({ ...branches(), [p.path]: [] });
    }
  }

  async function fetchSessions(path: string, branch: string) {
    const key = skey(path, branch);
    try {
      const s = await invoke<SessionMeta[]>("list_sessions", { projectPath: path, branch });
      setSessions({ ...sessions(), [key]: s });
    } catch {
      setSessions({ ...sessions(), [key]: [] });
    }
  }

  async function refreshSessions() {
    const updated: Record<string, SessionMeta[]> = { ...sessions() };
    for (const k of Object.keys(updated)) {
      const idx = k.indexOf("::");
      try {
        updated[k] = await invoke<SessionMeta[]>("list_sessions", {
          projectPath: k.slice(0, idx),
          branch: k.slice(idx + 2),
        });
      } catch {
        /* keep stale */
      }
    }
    setSessions(updated);
  }

  // After config loads, re-hydrate branches/sessions for restored-open nodes.
  async function restoreOpen(cfg: ResolvedConfig) {
    for (const g of cfg.groups) {
      for (const p of g.projects) {
        if (expanded().has(`p:${g.name}/${p.name}`)) {
          await fetchBranches(p);
        }
      }
    }
    for (const g of cfg.groups) {
      for (const p of g.projects) {
        for (const b of branches()[p.path] ?? []) {
          if (expanded().has(`b:${g.name}/${p.name}/${b.name}`)) {
            await fetchSessions(p.path, b.name);
          }
        }
      }
    }
  }

  function selectBranch(p: Project, branch: string) {
    props.onSelect({ projectName: p.name, projectPath: p.path, branch });
  }

  function selectSession(p: Project, branch: string, s: SessionMeta) {
    props.onSelect({
      projectName: p.name,
      projectPath: p.path,
      branch,
      sessionId: s.id,
      sessionTitle: s.title,
    });
  }

  function branchSelected(p: Project, branch: string) {
    const s = props.selected;
    return s != null && s.projectPath === p.path && s.branch === branch && s.sessionId == null;
  }

  // --- filtering ---
  const q = () => query().trim().toLowerCase();
  function sessionsMatch(p: Project) {
    if (!q()) return false;
    return Object.entries(sessions()).some(
      ([k, list]) =>
        k.startsWith(`${p.path}::`) && list.some((s) => s.title.toLowerCase().includes(q())),
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
    return !q() || s.title.toLowerCase().includes(q());
  }

  let unlistenConfig: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  let offSearch: (() => void) | undefined;
  let offSidebar: (() => void) | undefined;
  onMount(async () => {
    await invoke("config_watch_start").catch(() => {});
    await invoke("sessions_watch_start").catch(() => {});
    await loadConfig();
    const cfg = config();
    if (cfg) await restoreOpen(cfg);
    unlistenConfig = await listen("config://changed", () => loadConfig());
    unlistenSessions = await listen("sessions://changed", () => refreshSessions());
    offSearch = onEvent(FOCUS_SEARCH, () => searchEl?.focus());
    offSidebar = onEvent(FOCUS_SIDEBAR, () => searchEl?.focus());
  });
  onCleanup(() => {
    unlistenConfig?.();
    unlistenSessions?.();
    offSearch?.();
    offSidebar?.();
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
            const gkey = `g:${g.name}`;
            const open = () => expanded().has(gkey) || !!q();
            return (
              <div class="node">
                <div class="row group" onClick={() => toggle(gkey)}>
                  <span class="caret">{open() ? "▾" : "▸"}</span>
                  <span class="label">{g.name}</span>
                </div>
                <Show when={open()}>
                  <For each={g.projects.filter(projectVisible)}>
                    {(p) => {
                      const pkey = `p:${g.name}/${p.name}`;
                      const popen = () => expanded().has(pkey);
                      return (
                        <div class="node">
                          <div
                            class="row project sub1"
                            onClick={() => {
                              toggle(pkey);
                              fetchBranches(p);
                            }}
                          >
                            <span class="caret">{popen() ? "▾" : "▸"}</span>
                            <span class="label">{p.name}</span>
                          </div>
                          <Show when={popen()}>
                            <For
                              each={branches()[p.path] ?? []}
                              fallback={<div class="row dim sub2">no git branches</div>}
                            >
                              {(b) => {
                                const bkey = `b:${g.name}/${p.name}/${b.name}`;
                                const bopen = () => expanded().has(bkey);
                                return (
                                  <div class="node">
                                    <div
                                      class={`row branch sub2 ${branchSelected(p, b.name) ? "sel" : ""}`}
                                      onClick={() => {
                                        toggle(bkey);
                                        fetchSessions(p.path, b.name);
                                        selectBranch(p, b.name);
                                      }}
                                    >
                                      <span class="caret">{bopen() ? "▾" : "▸"}</span>
                                      <span class="label">{b.name}</span>
                                      <Show when={b.current}>
                                        <span class="dot" title="current branch">●</span>
                                      </Show>
                                    </div>
                                    <Show when={bopen()}>
                                      <For
                                        each={(sessions()[skey(p.path, b.name)] ?? []).filter(sessionVisible)}
                                        fallback={<div class="row dim sub3">no sessions</div>}
                                      >
                                        {(s) => (
                                          <div
                                            class={`row session sub3 ${props.selected?.sessionId === s.id ? "sel" : ""}`}
                                            onClick={() => selectSession(p, b.name, s)}
                                            title={s.title}
                                          >
                                            <Show when={props.openIds.has(s.id)}>
                                              <span class="run-dot" title="running">●</span>
                                            </Show>
                                            <span class="label">{s.title}</span>
                                            <span class="when">{ago(s.last_active)}</span>
                                          </div>
                                        )}
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
