import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export default function Sidebar(props: {
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const [config, setConfig] = createSignal<ResolvedConfig | null>(null);
  const [error, setError] = createSignal("");
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [branches, setBranches] = createSignal<Record<string, Branch[]>>({});
  const [sessions, setSessions] = createSignal<Record<string, SessionMeta[]>>({});

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
      const b = await invoke<Branch[]>("list_branches", { path: p.path });
      setBranches({ ...branches(), [p.path]: b });
    } catch {
      setBranches({ ...branches(), [p.path]: [] });
    }
  }

  async function fetchSessions(path: string, branch: string) {
    const key = skey(path, branch);
    try {
      const s = await invoke<SessionMeta[]>("list_sessions", {
        projectPath: path,
        branch,
      });
      setSessions({ ...sessions(), [key]: s });
    } catch {
      setSessions({ ...sessions(), [key]: [] });
    }
  }

  // Re-fetch sessions for every currently-open branch when ~/.claude changes.
  async function refreshSessions() {
    const keys = Object.keys(sessions());
    const updated: Record<string, SessionMeta[]> = { ...sessions() };
    for (const k of keys) {
      const idx = k.indexOf("::");
      const path = k.slice(0, idx);
      const branch = k.slice(idx + 2);
      try {
        updated[k] = await invoke<SessionMeta[]>("list_sessions", {
          projectPath: path,
          branch,
        });
      } catch {
        /* keep stale on error */
      }
    }
    setSessions(updated);
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
    return (
      s != null &&
      s.projectPath === p.path &&
      s.branch === branch &&
      s.sessionId == null
    );
  }

  let unlistenConfig: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  onMount(async () => {
    await invoke("config_watch_start").catch(() => {});
    await invoke("sessions_watch_start").catch(() => {});
    await loadConfig();
    unlistenConfig = await listen("config://changed", () => loadConfig());
    unlistenSessions = await listen("sessions://changed", () => refreshSessions());
  });
  onCleanup(() => {
    unlistenConfig?.();
    unlistenSessions?.();
  });

  return (
    <div class="tree">
      <Show when={error()}>
        <div class="tree-error">{error()}</div>
      </Show>

      <For each={config()?.groups ?? []}>
        {(g) => {
          const gkey = `g:${g.name}`;
          return (
            <div class="node">
              <div class="row group" onClick={() => toggle(gkey)}>
                <span class="caret">{expanded().has(gkey) ? "▾" : "▸"}</span>
                <span class="label">{g.name}</span>
              </div>
              <Show when={expanded().has(gkey)}>
                <For each={g.projects}>
                  {(p) => {
                    const pkey = `p:${g.name}/${p.name}`;
                    return (
                      <div class="node">
                        <div
                          class="row project sub1"
                          onClick={() => {
                            toggle(pkey);
                            fetchBranches(p);
                          }}
                        >
                          <span class="caret">
                            {expanded().has(pkey) ? "▾" : "▸"}
                          </span>
                          <span class="label">{p.name}</span>
                        </div>
                        <Show when={expanded().has(pkey)}>
                          <For
                            each={branches()[p.path] ?? []}
                            fallback={<div class="row dim sub2">no git branches</div>}
                          >
                            {(b) => {
                              const bkey = `b:${g.name}/${p.name}/${b.name}`;
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
                                    <span class="caret">
                                      {expanded().has(bkey) ? "▾" : "▸"}
                                    </span>
                                    <span class="label">{b.name}</span>
                                    <Show when={b.current}>
                                      <span class="dot" title="current branch">●</span>
                                    </Show>
                                  </div>
                                  <Show when={expanded().has(bkey)}>
                                    <For
                                      each={sessions()[skey(p.path, b.name)] ?? []}
                                      fallback={<div class="row dim sub3">no sessions</div>}
                                    >
                                      {(s) => (
                                        <div
                                          class={`row session sub3 ${props.selected?.sessionId === s.id ? "sel" : ""}`}
                                          onClick={() => selectSession(p, b.name, s)}
                                          title={s.title}
                                        >
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

      <Show when={config()}>
        <div class="tree-foot" title={config()!.path}>
          {config()!.path.replace(/^.*\/\.config\//, "~/.config/")}
        </div>
      </Show>
    </div>
  );
}
