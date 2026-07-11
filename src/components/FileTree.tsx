import { createSignal, createEffect, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, OPEN_IN_EDITOR, DRAG_PATH_MIME, TOAST, type ToastEvent } from "../events";
import FileIcon from "../seti/FileIcon";
import Chevron from "./Chevron";
import ContextMenu, { type MenuItem, type MenuState } from "./ContextMenu";
import { type ConfirmOpts } from "./ConfirmDialog";

type Entry = { name: string; path: string; is_dir: boolean };

// Hidden from the tree (the watcher already ignores these too).
const HIDDEN = new Set([".git", "node_modules"]);

// When editable, the tree can create/rename/delete under a single containment
// root (`.shared`). `root` is the boundary every fs mutation is scoped to; the
// menu opener and `askText` are threaded down so a deep node can prompt + open
// the shared context menu without owning that state itself.
type EditCtx = {
  root: string;
  askText: (title: string, initial?: string) => Promise<string | null>;
  askConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  openMenu: (e: MouseEvent, items: MenuItem[]) => void;
};

async function readDir(path: string): Promise<Entry[]> {
  try {
    const list = await invoke<Entry[]>("fs_read_dir", { path });
    return list.filter((e) => !HIDDEN.has(e.name));
  } catch {
    return [];
  }
}

// A single path segment: no separators, no `.`/`..`. fs_mkdir/rename/delete are
// containment-scoped in the backend, but the new-file write is not, so the name
// is validated here before it ever becomes part of a path.
function validName(raw: string | null): string | null {
  const t = (raw ?? "").trim();
  if (!t || t === "." || t === ".." || t.includes("/")) return null;
  return t;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : path;
}

// --- editable mutations (each scoped to ctx.root, then reloads the caller) ---

async function newFileIn(ctx: EditCtx, dir: string, reload: () => Promise<void>) {
  const name = validName(await ctx.askText("New file name:"));
  if (!name) return;
  try {
    await invoke("fs_mkdir", { root: ctx.root, path: dir }); // creates `.shared` on first add
    const path = `${dir}/${name}`;
    // fs_write_file truncates, so never let "New File" empty an existing file:
    // open the existing one instead of clobbering it.
    if (await invoke<boolean>("file_exists", { path })) {
      emitWith<ToastEvent>(TOAST, { message: "A file with that name already exists.", kind: "info" });
      emitWith(OPEN_IN_EDITOR, { path });
      return;
    }
    await invoke("fs_write_file", { path, contents: "" });
    await reload();
    emitWith(OPEN_IN_EDITOR, { path }); // open the new file for editing
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

async function newFolderIn(ctx: EditCtx, dir: string, reload: () => Promise<void>) {
  const name = validName(await ctx.askText("New folder name:"));
  if (!name) return;
  try {
    await invoke("fs_mkdir", { root: ctx.root, path: `${dir}/${name}` });
    await reload();
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

async function renameEntry(ctx: EditCtx, entry: Entry, reloadParent: () => Promise<void>) {
  const name = validName(await ctx.askText("Rename:", entry.name));
  if (!name || name === entry.name) return;
  try {
    await invoke("fs_rename", { root: ctx.root, from: entry.path, to: `${parentOf(entry.path)}/${name}` });
    await reloadParent();
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

async function deleteEntry(ctx: EditCtx, entry: Entry, reloadParent: () => Promise<void>) {
  const what = entry.is_dir ? "folder" : "file";
  const ok = await ctx.askConfirm({
    title: `Delete the ${what} “${entry.name}”?`,
    message: "This cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke("fs_delete", { root: ctx.root, path: entry.path });
    await reloadParent();
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

function TreeNode(props: {
  entry: Entry;
  depth: number;
  ctx?: EditCtx;
  reloadParent: () => Promise<void>;
}) {
  const [open, setOpen] = createSignal(false);
  const [children, setChildren] = createSignal<Entry[] | null>(null);

  // Re-read this dir's children in place (keeps it expanded), so an add inside it
  // shows without remounting the whole tree.
  async function reloadSelf() {
    setChildren(await readDir(props.entry.path));
    setOpen(true);
  }

  async function activate() {
    if (!props.entry.is_dir) {
      emitWith(OPEN_IN_EDITOR, { path: props.entry.path });
      return;
    }
    // Lazy: fetch children the first time the dir is opened.
    if (children() === null) setChildren(await readDir(props.entry.path));
    setOpen(!open());
  }

  function onContextMenu(e: MouseEvent) {
    const ctx = props.ctx;
    if (!ctx) return;
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [];
    if (props.entry.is_dir) {
      items.push({ label: "New File", onClick: () => newFileIn(ctx, props.entry.path, reloadSelf) });
      items.push({ label: "New Folder", onClick: () => newFolderIn(ctx, props.entry.path, reloadSelf) });
      items.push({ separator: true });
    }
    items.push({ label: "Rename", onClick: () => renameEntry(ctx, props.entry, props.reloadParent) });
    items.push({ label: "Delete", danger: true, onClick: () => deleteEntry(ctx, props.entry, props.reloadParent) });
    ctx.openMenu(e, items);
  }

  return (
    <div class="tree-node">
      <div
        class="tree-row"
        style={{ "padding-left": `${props.depth * 12 + 8}px` }}
        onClick={activate}
        onContextMenu={onContextMenu}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer?.setData(DRAG_PATH_MIME, props.entry.path);
          e.dataTransfer?.setData("text/plain", props.entry.path);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        }}
      >
        {props.entry.is_dir ? (
          <Chevron open={open()} />
        ) : (
          <FileIcon name={props.entry.name} />
        )}
        <span class="tree-name" classList={{ "is-dir": props.entry.is_dir }}>
          {props.entry.name}
        </span>
      </div>
      <Show when={open() && children()}>
        <For each={children()!}>
          {(child) => (
            <TreeNode entry={child} depth={props.depth + 1} ctx={props.ctx} reloadParent={reloadSelf} />
          )}
        </For>
      </Show>
    </div>
  );
}

/** File tree rooted at the project path, on the right of the editor pane.
 *  Dirs expand lazily; clicking a file emits OPEN_IN_EDITOR. When `editable` is
 *  set, a header (New File/New Folder) and per-node context menus mutate the tree
 *  through the containment-scoped fs commands, all bounded to `root` (`.shared`);
 *  the header actions work even before `root` exists (mkdir auto-creates it). */
export default function FileTree(props: {
  root: string | null;
  editable?: boolean;
  askText?: (title: string, initial?: string) => Promise<string | null>;
  askConfirm?: (opts: ConfirmOpts) => Promise<boolean>;
}) {
  const [roots, setRoots] = createSignal<Entry[]>([]);
  const [menu, setMenu] = createSignal<MenuState | null>(null);

  async function reloadRoots() {
    setRoots(props.root ? await readDir(props.root) : []);
  }

  createEffect(on(() => props.root, () => reloadRoots()));

  const ctx = (): EditCtx | undefined => {
    if (!props.editable || !props.root || !props.askText || !props.askConfirm) return undefined;
    return {
      root: props.root,
      askText: props.askText,
      askConfirm: props.askConfirm,
      openMenu: (e, items) => setMenu({ x: e.clientX, y: e.clientY, items }),
    };
  };

  return (
    <div class="file-tree">
      <Show when={ctx()}>
        {(c) => (
          <div class="tree-actions">
            <button class="tree-action" onClick={() => newFileIn(c(), c().root, reloadRoots)}>
              New File
            </button>
            <button class="tree-action" onClick={() => newFolderIn(c(), c().root, reloadRoots)}>
              New Folder
            </button>
          </div>
        )}
      </Show>
      <Show when={roots().length} fallback={<div class="tree-empty">No files</div>}>
        <For each={roots()}>
          {(e) => <TreeNode entry={e} depth={0} ctx={ctx()} reloadParent={reloadRoots} />}
        </For>
      </Show>
      <Show when={menu()}>
        <ContextMenu menu={menu()!} onClose={() => setMenu(null)} />
      </Show>
    </div>
  );
}
