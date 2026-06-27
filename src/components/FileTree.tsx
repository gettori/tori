import { createSignal, For, Show, onMount, onCleanup, createEffect, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Entry = { name: string; path: string; is_dir: boolean };

export default function FileTree(props: {
  root: string | null;
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  // path -> children (undefined = not loaded yet)
  const [children, setChildren] = createSignal<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  async function load(dir: string) {
    try {
      const items = await invoke<Entry[]>("list_dir", { path: dir });
      setChildren({ ...children(), [dir]: items });
    } catch {
      setChildren({ ...children(), [dir]: [] });
    }
  }

  async function toggleDir(dir: string) {
    const next = new Set(expanded());
    if (next.has(dir)) {
      next.delete(dir);
    } else {
      next.add(dir);
      if (!children()[dir]) await load(dir);
    }
    setExpanded(next);
  }

  // Reset and load when the project root changes.
  createEffect(
    on(
      () => props.root,
      (root) => {
        setChildren({});
        setExpanded(new Set<string>());
        if (root) load(root);
      },
    ),
  );

  // Refresh any already-loaded dirs when the filesystem changes.
  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen("files://changed", () => {
      for (const dir of Object.keys(children())) load(dir);
    });
  });
  onCleanup(() => unlisten?.());

  function Node(p: { entry: Entry; depth: number }): any {
    const e = p.entry;
    const pad = 6 + p.depth * 12;
    if (e.is_dir) {
      return (
        <div>
          <div
            class="frow dir"
            style={{ "padding-left": `${pad}px` }}
            onClick={() => toggleDir(e.path)}
          >
            <span class="caret">{expanded().has(e.path) ? "▾" : "▸"}</span>
            <span class="fname">{e.name}</span>
          </div>
          <Show when={expanded().has(e.path)}>
            <For each={children()[e.path] ?? []}>
              {(child) => <Node entry={child} depth={p.depth + 1} />}
            </For>
          </Show>
        </div>
      );
    }
    return (
      <div
        class={`frow file ${props.activePath === e.path ? "active" : ""}`}
        style={{ "padding-left": `${pad + 12}px` }}
        onClick={() => props.onOpen(e.path)}
      >
        <span class="fname">{e.name}</span>
      </div>
    );
  }

  return (
    <div class="file-tree">
      <Show
        when={props.root}
        fallback={<div class="ft-empty">No project selected</div>}
      >
        <For each={children()[props.root!] ?? []}>
          {(entry) => <Node entry={entry} depth={0} />}
        </For>
      </Show>
    </div>
  );
}
