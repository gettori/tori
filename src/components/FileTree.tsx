import { createSignal, createEffect, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, OPEN_IN_EDITOR, DRAG_PATH_MIME } from "../events";
import FileIcon from "../seti/FileIcon";

type Entry = { name: string; path: string; is_dir: boolean };

// Hidden from the tree (the watcher already ignores these too).
const HIDDEN = new Set([".git", "node_modules"]);

async function readDir(path: string): Promise<Entry[]> {
  try {
    const list = await invoke<Entry[]>("fs_read_dir", { path });
    return list.filter((e) => !HIDDEN.has(e.name));
  } catch {
    return [];
  }
}

function TreeNode(props: { entry: Entry; depth: number }) {
  const [open, setOpen] = createSignal(false);
  const [children, setChildren] = createSignal<Entry[] | null>(null);

  async function activate() {
    if (!props.entry.is_dir) {
      emitWith(OPEN_IN_EDITOR, { path: props.entry.path });
      return;
    }
    // Lazy: fetch children the first time the dir is opened.
    if (children() === null) setChildren(await readDir(props.entry.path));
    setOpen(!open());
  }

  return (
    <div class="tree-node">
      <div
        class="tree-row"
        style={{ "padding-left": `${props.depth * 12 + 8}px` }}
        onClick={activate}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer?.setData(DRAG_PATH_MIME, props.entry.path);
          e.dataTransfer?.setData("text/plain", props.entry.path);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        }}
      >
        {props.entry.is_dir ? (
          <span class="tree-twisty" classList={{ open: open() }}>
            ›
          </span>
        ) : (
          <FileIcon name={props.entry.name} />
        )}
        <span class="tree-name" classList={{ "is-dir": props.entry.is_dir }}>
          {props.entry.name}
        </span>
      </div>
      <Show when={open() && children()}>
        <For each={children()!}>
          {(child) => <TreeNode entry={child} depth={props.depth + 1} />}
        </For>
      </Show>
    </div>
  );
}

/** File tree rooted at the project path, on the right of the editor pane.
 *  Dirs expand lazily; clicking a file emits OPEN_IN_EDITOR. */
export default function FileTree(props: { root: string | null }) {
  const [roots, setRoots] = createSignal<Entry[]>([]);

  createEffect(
    on(
      () => props.root,
      async (root) => {
        setRoots(root ? await readDir(root) : []);
      },
    ),
  );

  return (
    <div class="file-tree">
      <Show
        when={roots().length}
        fallback={<div class="tree-empty">No files</div>}
      >
        <For each={roots()}>{(e) => <TreeNode entry={e} depth={0} />}</For>
      </Show>
    </div>
  );
}
