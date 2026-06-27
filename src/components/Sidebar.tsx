import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Project = { name: string; path: string };
type Group = { name: string; projects: Project[] };
type ResolvedConfig = { path: string; groups: Group[] };
type Branch = { name: string; current: boolean };

export type Selection = {
  projectName: string;
  projectPath: string;
  branch: string;
};

export default function Sidebar(props: {
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const [config, setConfig] = createSignal<ResolvedConfig | null>(null);
  const [error, setError] = createSignal("");
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [branches, setBranches] = createSignal<Record<string, Branch[]>>({});

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

  async function expandProject(p: Project, key: string) {
    toggle(key);
    if (!branches()[p.path]) {
      try {
        const b = await invoke<Branch[]>("list_branches", { path: p.path });
        setBranches({ ...branches(), [p.path]: b });
      } catch {
        setBranches({ ...branches(), [p.path]: [] });
      }
    }
  }

  function isSelected(p: Project, b: Branch) {
    const s = props.selected;
    return s != null && s.projectPath === p.path && s.branch === b.name;
  }

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    await invoke("config_watch_start").catch(() => {});
    await loadConfig();
    unlisten = await listen("config://changed", () => loadConfig());
  });
  onCleanup(() => unlisten?.());

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
                          onClick={() => expandProject(p, pkey)}
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
                            {(b) => (
                              <div
                                class={`row branch sub2 ${isSelected(p, b) ? "sel" : ""}`}
                                onClick={() => props.onSelect({
                                  projectName: p.name,
                                  projectPath: p.path,
                                  branch: b.name,
                                })}
                              >
                                <span class="label">{b.name}</span>
                                <Show when={b.current}>
                                  <span class="dot" title="current branch">●</span>
                                </Show>
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

      <Show when={config()}>
        <div class="tree-foot" title={config()!.path}>
          {config()!.path.replace(/^.*\/\.config\//, "~/.config/")}
        </div>
      </Show>
    </div>
  );
}
