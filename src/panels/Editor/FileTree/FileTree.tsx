import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  emitWith,
  OPEN_IN_EDITOR,
  DRAG_PATH_MIME,
  FILE_RENAMED,
  TOAST,
  type FileRenamed,
  type ToastEvent,
} from "../../../utils/events";
import FileIcon from "../../../seti/FileIcon";
import Chevron from "../../../components/Chevron/Chevron";
import Button from "../../../components/Button/Button";
import Icon from "../../../components/Icon/Icon";
import { FilePlus, FolderPlus, Crosshair, ChevronsDownUp } from "lucide-solid";
import Menu, { type MenuItem, type MenuState } from "../../../components/Menu/Menu";
import { type ConfirmOpts } from "../../../components/Dialogs/ConfirmDialog";
import { isTouched } from "../../../utils/touchedFiles";
import { isEditingNow } from "../../../utils/editingNow";
import { fuzzyScore } from "../../../utils/fuzzy";
import { editorDefaults } from "../../Settings/settingsStore";
import styles from "./FileTree.module.css";

type Entry = { name: string; path: string; is_dir: boolean; ignored: boolean };

// Hidden from the tree. Only VCS internals stay fully out; gitignored dirs like
// node_modules are shown (dimmed) rather than hidden, matching VS Code.
const HIDDEN = new Set([".git"]);

// When editable, the tree can create/rename/delete under a single containment
// root: `.shared` for the Shared tab, the workspace itself for the project tree.
// `root` is the boundary every fs mutation is scoped to; the menu opener and
// `askText` are threaded down so a deep node can prompt + open the shared context
// menu without owning that state itself.
//
// `noun` only names that boundary in a refusal ("outside the project folder"),
// so it is presentation: the backend fences on `root` whether or not it is set.
type EditCtx = {
  root: string;
  noun: string;
  askText: (title: string, initial?: string) => Promise<string | null>;
  askConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  openMenu: (e: MouseEvent, items: MenuItem[]) => void;
  /** Directories mounted right now, keyed by path. A mutation sometimes has to
   *  re-read a directory it does not own: a move touches the source's parent and
   *  the destination, and the drop handler sits on only one of them. */
  mounted: Map<string, () => Promise<void>>;
  selected: () => ReadonlySet<string>;
  toggleSelected: (path: string) => void;
  clearSelected: () => void;
};

// A drag that this tree owns. `DRAG_PATH_MIME` cannot carry that meaning: the
// editor's tab strip sets it too, and the chat composer and the terminal consume
// it as a file *mention*. Without a second type, dropping a file on the composer
// to mention it would be indistinguishable from dropping it to move it, and the
// ambiguity resolves as a filesystem move nobody asked for. So the tree marks
// its own drags, and only a marked drag can land on a folder.
const TREE_MOVE_MIME = "application/x-sway-tree-move";

/** A request to walk the tree to `path`. `nonce` distinguishes two requests for
 *  the same file, which a bare string could not. */
type Reveal = { path: string; nonce: number };

/** A row as the tree draws it: the entry it acts on, and the name it shows.
 *  The two differ only under compaction, where one row stands for a chain of
 *  folders and acts on the deepest of them. */
type Shown = { entry: Entry; label: string };

async function readDir(path: string): Promise<Entry[]> {
  try {
    const list = await invoke<Entry[]>("fs_read_dir", { path });
    return list.filter((e) => !HIDDEN.has(e.name));
  } catch {
    return [];
  }
}

// A chain longer than this is not a package layout, it is something generated,
// and walking it would turn one expansion into a walk of the whole subtree.
const MAX_COMPACT_DEPTH = 8;

/** Collapse a run of single-child folders into one row: `src` holding only
 *  `utils` holding only `helpers` draws as `src/utils/helpers` and acts on the
 *  deepest one, which is where the files actually are.
 *
 *  Gitignored folders are left alone. Compacting means reading each child
 *  directory to see whether the chain continues, and `node_modules` is both the
 *  most expensive place to do that and the least useful. */
async function compactChain(dir: Entry): Promise<Shown> {
  let cur = dir;
  let label = dir.name;
  for (let i = 0; i < MAX_COMPACT_DEPTH; i++) {
    const kids = await readDir(cur.path);
    if (kids.length !== 1 || !kids[0].is_dir || kids[0].ignored) break;
    cur = kids[0];
    label = `${label}/${cur.name}`;
  }
  return { entry: cur, label };
}

async function listChildren(path: string, compactFolders: boolean): Promise<Shown[]> {
  const kids = await readDir(path);
  if (!compactFolders) return kids.map((entry) => ({ entry, label: entry.name }));
  return Promise.all(
    kids.map((k) => (k.is_dir && !k.ignored ? compactChain(k) : { entry: k, label: k.name })),
  );
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
    await invoke("fs_mkdir", { root: ctx.root, path: dir, noun: ctx.noun }); // creates `.shared` on first add
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
    await invoke("fs_mkdir", { root: ctx.root, path: `${dir}/${name}`, noun: ctx.noun });
    await reload();
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

/** Move `from` to `to` on disk and tell the rest of the app, so open tabs and
 *  their buffers follow rather than orphaning onto a path that no longer exists.
 *
 *  `undo` is the offer, not a second undo level: reversing a rename is itself a
 *  rename, and stacking toasts on toasts would let one stray click walk a file
 *  backwards through a history nobody is tracking. */
async function applyRename(ctx: EditCtx, from: string, to: string, undo?: string) {
  await invoke("fs_rename", { root: ctx.root, from, to, noun: ctx.noun });
  // After the move, because that is where the files are now: local history is
  // keyed by path, so without this every saved version stays filed under a name
  // nothing will ever ask about again. Not awaited, and failure is silent - the
  // file has moved either way, and a toast about a version store would be about
  // something the user did not do.
  void invoke("local_history_rename", { repoPath: ctx.root, from, to }).catch(() => {});
  emitWith<FileRenamed>(FILE_RENAMED, { from, to });
  await reloadDirs(ctx, parentOf(from), parentOf(to));
  if (!undo) return;
  emitWith<ToastEvent>(TOAST, {
    message: undo,
    kind: "info",
    action: {
      label: "Undo",
      // The moment someone wants this back is the moment they are told about it,
      // so the reverse runs here rather than living in a history panel.
      run: () => {
        void applyRename(ctx, to, from).catch((e) =>
          emitWith<ToastEvent>(TOAST, { message: `Could not undo: ${e}` }),
        );
      },
    },
  });
}

async function renameEntry(ctx: EditCtx, entry: Entry, reloadParent: () => Promise<void>) {
  const name = validName(await ctx.askText("Rename:", entry.name));
  if (!name || name === entry.name) return;
  try {
    await applyRename(ctx, entry.path, `${parentOf(entry.path)}/${name}`, `Renamed to ${name}`);
    await reloadParent();
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

/** Delete `entry`, or the whole selection when `entry` is part of one.
 *
 *  Deleting one of several selected rows and watching the other selected rows
 *  survive is the kind of surprise that makes people stop trusting selection,
 *  so the menu acts on what is highlighted, and says how many. */
async function deleteEntry(ctx: EditCtx, entry: Entry, reloadParent: () => Promise<void>) {
  const chosen = ctx.selected();
  const targets = chosen.has(entry.path) ? [...chosen] : [entry.path];
  const what = entry.is_dir ? "folder" : "file";
  const ok = await ctx.askConfirm({
    title:
      targets.length > 1
        ? `Delete ${targets.length} selected items?`
        : `Delete the ${what} “${entry.name}”?`,
    // Not "cannot be undone": the backend trashes rather than unlinks, and a
    // dialog that overstates the damage teaches people to distrust the next one.
    message: "They move to the Trash, where you can put them back.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  // Each delete is independent: one failure must not strand the rest, so the
  // loop reports and keeps going rather than aborting half-done and silent.
  const failed: string[] = [];
  for (const path of targets) {
    try {
      // Before the delete, not after: a folder's saved versions can only be
      // found by walking it, and by the time it is in the Trash there is
      // nothing left to walk. Awaited for the same reason, and forgiving,
      // since a version store that will not answer must not block the delete.
      await invoke("local_history_forget", { repoPath: ctx.root, path }).catch(() => {});
      await invoke("fs_delete", { root: ctx.root, path, noun: ctx.noun });
    } catch (e) {
      failed.push(String(e));
    }
  }
  ctx.clearSelected();
  if (failed.length) emitWith<ToastEvent>(TOAST, { message: failed[0] });
  await reloadParent();
  await reloadDirs(ctx, ...targets.map(parentOf));
}

async function reloadDirs(ctx: EditCtx, ...dirs: string[]) {
  for (const d of new Set(dirs)) await ctx.mounted.get(d)?.();
}

/** Move `from` into the directory `dir`.
 *
 *  A plain `fs_rename`, never `git mv`: the manual-git invariant means a move
 *  shows up as a deletion plus an untracked add until the user stages it
 *  themselves, which is the same thing moving a file in Finder would do. */
async function moveInto(ctx: EditCtx, from: string, dir: string) {
  const name = from.slice(from.lastIndexOf("/") + 1);
  const to = `${dir}/${name}`;
  // Dropping something back where it already lives is a no-op, not an error.
  if (from === to || parentOf(from) === dir) return;
  // A folder cannot swallow itself. `fs_rename` would refuse or, worse, succeed
  // into a path that no longer resolves, so the tree refuses first and says why.
  if (dir === from || dir.startsWith(`${from}/`)) {
    emitWith<ToastEvent>(TOAST, { message: "A folder cannot be moved inside itself." });
    return;
  }
  try {
    await applyRename(ctx, from, to, `Moved ${name}`);
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

/** Whether this drag is one the tree started, which is what separates a move
 *  from the chat composer's file mention. Read from `types` rather than the
 *  data, since a browser exposes values only at drop time. */
function isTreeDrag(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(TREE_MOVE_MIME);
}

function TreeNode(props: {
  entry: Entry;
  /** What the row shows. Differs from `entry.name` only under compaction. */
  label: string;
  depth: number;
  /** Bumped to close every open directory at once. */
  collapseAll?: () => number;
  compactFolders?: boolean;
  ctx?: EditCtx;
  reloadParent: () => Promise<void>;
  /** The path the tree is being asked to walk to, if any. Every node reacts to
   *  it independently: a directory the target sits under opens itself, and the
   *  target's own row scrolls into view once it exists. That is what makes the
   *  walk work against a lazily-loaded tree, with no path-chasing loop. */
  revealing?: () => Reveal | null;
  /** Called by the target's own row once it has been reached, which is what ends
   *  the walk. */
  onRevealed?: () => void;
}) {
  let row: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [children, setChildren] = createSignal<Shown[] | null>(null);
  const [dropInto, setDropInto] = createSignal(false);

  // Re-read this dir's children in place (keeps it expanded), so an add inside it
  // shows without remounting the whole tree.
  async function reloadSelf() {
    setChildren(await listChildren(props.entry.path, !!props.compactFolders));
    setOpen(true);
  }

  // Publish this directory's reload so a mutation elsewhere in the tree can
  // refresh it. Only mounted dirs are registered, which is exactly the set whose
  // contents are on screen and could go stale.
  onMount(() => {
    if (props.entry.is_dir) props.ctx?.mounted.set(props.entry.path, reloadSelf);
  });
  onCleanup(() => {
    if (props.entry.is_dir) props.ctx?.mounted.delete(props.entry.path);
  });

  const acceptsDrop = (e: DragEvent) => !!props.ctx && isTreeDrag(e);

  // Where a drop on this row lands. A file is not a container, so it stands for
  // the directory holding it: dropping onto a sibling means "put it here too".
  // Without this a file row would fall through to the tree background, which
  // means the workspace root, and a file dropped next to a deeply nested sibling
  // would silently fly to the top of the project.
  const dropDir = () => (props.entry.is_dir ? props.entry.path : parentOf(props.entry.path));

  // Open without toggling. Reveal needs "make sure this is open"; a toggle would
  // close a directory that happened to be open already, hiding the target.
  async function expand() {
    if (children() === null) setChildren(await listChildren(props.entry.path, !!props.compactFolders));
    setOpen(true);
  }

  async function activate(e?: MouseEvent) {
    // Cmd/Ctrl-click builds a selection instead of acting on the row, so a
    // multi-file delete does not have to open every file on the way.
    if (props.ctx && (e?.metaKey || e?.ctrlKey)) {
      props.ctx.toggleSelected(props.entry.path);
      return;
    }
    props.ctx?.clearSelected();
    if (!props.entry.is_dir) {
      emitWith(OPEN_IN_EDITOR, { path: props.entry.path });
      return;
    }
    // Lazy: fetch children the first time the dir is opened.
    if (children() === null) setChildren(await listChildren(props.entry.path, !!props.compactFolders));
    setOpen(!open());
  }

  // Collapse-all is a broadcast rather than a walk: every directory owns its own
  // `open`, so the only way to shut them from the top is to let each one hear
  // the same bump and close itself.
  createEffect(
    on(
      () => props.collapseAll?.() ?? 0,
      (n, prev) => {
        if (prev !== undefined && n !== prev) setOpen(false);
      },
    ),
  );

  createEffect(() => {
    const target = props.revealing?.()?.path;
    if (!target) return;
    if (props.entry.is_dir && target.startsWith(`${props.entry.path}/`)) {
      void expand();
    } else if (props.entry.path === target) {
      // Guarded: jsdom has no layout, so it does not implement this.
      row?.scrollIntoView?.({ block: "nearest" });
      // Arriving ends the walk. Leaving the target set would outlive the reveal:
      // collapsing an ancestor unmounts these rows, and remounting them would
      // replay the cascade and re-open the chain the user just closed.
      props.onRevealed?.();
    }
  });

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
    <div>
      <div
        ref={row}
        class={styles.treeRow}
        classList={{
          [styles.ignored]: props.entry.ignored,
          [styles.dropInto]: dropInto(),
          [styles.selected]: !!props.ctx?.selected().has(props.entry.path),
        }}
        style={{ "padding-left": `${props.depth * 12 + 8}px` }}
        onClick={activate}
        onContextMenu={onContextMenu}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer?.setData(DRAG_PATH_MIME, props.entry.path);
          e.dataTransfer?.setData("text/plain", props.entry.path);
          // Only an editable tree marks its drags, so a read-only tree can still
          // be dragged into chat but can never move anything.
          if (props.ctx) e.dataTransfer?.setData(TREE_MOVE_MIME, props.entry.path);
          // Both meanings stay available: the drop target picks which one by
          // setting `dropEffect`, so chat copies a mention and a folder moves.
          if (e.dataTransfer) e.dataTransfer.effectAllowed = props.ctx ? "copyMove" : "copy";
        }}
        onDragOver={(e) => {
          // Not calling preventDefault is what makes a row *not* a drop target,
          // so an unmarked drag falls through to whatever is underneath.
          if (!acceptsDrop(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          setDropInto(true);
        }}
        onDragLeave={() => setDropInto(false)}
        onDrop={(e) => {
          if (!acceptsDrop(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropInto(false);
          const from = e.dataTransfer?.getData(TREE_MOVE_MIME);
          if (from) void moveInto(props.ctx!, from, dropDir());
        }}
      >
        {props.entry.is_dir ? (
          <Chevron open={open()} />
        ) : (
          <FileIcon name={props.entry.name} />
        )}
        <span
          class={styles.treeName}
          classList={{
            [styles.isDir]: props.entry.is_dir,
            // Only files carry the marker: a dir's tint would have to mean
            // "something below me changed", which is a different claim.
            [styles.touched]: !props.entry.is_dir && isTouched(props.entry.path),
            // The live indicator is a strict subset of touched: a file being
            // written right now is by definition one this session wrote.
            [styles.editing]: !props.entry.is_dir && isEditingNow(props.entry.path),
          }}
        >
          {props.label}
        </span>
        <Show when={!props.entry.is_dir && (isTouched(props.entry.path) || isEditingNow(props.entry.path))}>
          <span
            class={styles.touchedDot}
            classList={{ [styles.editingDot]: isEditingNow(props.entry.path) }}
            title={
              isEditingNow(props.entry.path) ? "Being edited right now" : "Changed by the selected session"
            }
          >
            ●
          </span>
        </Show>
      </div>
      <Show when={open() && children()}>
        <For each={children()!}>
          {(child) => (
            <TreeNode
              entry={child.entry}
              label={child.label}
              depth={props.depth + 1}
              ctx={props.ctx}
              reloadParent={reloadSelf}
              revealing={props.revealing}
              onRevealed={props.onRevealed}
              collapseAll={props.collapseAll}
              compactFolders={props.compactFolders}
            />
          )}
        </For>
      </Show>
    </div>
  );
}

/** The filter's answer: a flat, ranked list of files, not a pruned tree.
 *
 *  A tree keeps a match's ancestors on screen to place it, which is exactly the
 *  chrome someone filtering is trying to get past. Ranked paths put the best
 *  match on the first row every time. */
function FilterResults(props: { root: string; matches: { rel: string; score: number }[] }) {
  return (
    <Show
      when={props.matches.length}
      fallback={<div class={styles.empty}>No files match that filter.</div>}
    >
      <For each={props.matches}>
        {(m) => (
          <div
            class={styles.treeRow}
            onClick={() => emitWith(OPEN_IN_EDITOR, { path: `${props.root}/${m.rel}` })}
          >
            <FileIcon name={m.rel.slice(m.rel.lastIndexOf("/") + 1)} />
            <span class={styles.treeName}>{m.rel}</span>
          </div>
        )}
      </For>
    </Show>
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
  /** Names the containment boundary in a refusal. Presentation only. */
  noun?: string;
  /** The file the editor is showing, so the tree can walk to it on request. */
  activePath?: string | null;
  askText?: (title: string, initial?: string) => Promise<string | null>;
  askConfirm?: (opts: ConfirmOpts) => Promise<boolean>;
}) {
  const [roots, setRoots] = createSignal<Shown[]>([]);
  const [filter, setFilter] = createSignal("");
  const [allFiles, setAllFiles] = createSignal<string[] | null>(null);
  const [collapseNonce, setCollapseNonce] = createSignal(0);
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [dropRoot, setDropRoot] = createSignal(false);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  // The file the tree is walking to. Deliberately never cleared: the walk is a
  // cascade of lazy loads, so a directory that mounts three levels down has to
  // still find the target when it arrives. `nonce` is what makes asking for the
  // same file twice reveal it twice instead of going quiet after the first.
  const [revealing, setRevealing] = createSignal<Reveal | null>(null);
  let revealNonce = 0;

  // Only a real file under this root can be revealed: `activePath` can also be a
  // synthetic `sway://` tab, which has no row to scroll to.
  const revealable = () => {
    const p = props.activePath;
    return p && props.root && p.startsWith(`${props.root}/`) ? p : null;
  };

  function reveal() {
    const p = revealable();
    if (p) setRevealing({ path: p, nonce: ++revealNonce });
  }

  // Every mounted directory's reload, the root's included, so a move can refresh
  // both ends. Stable across `ctx()` calls, which rebuild the rest each time.
  const mounted = new Map<string, () => Promise<void>>();

  const compactFolders = () => editorDefaults().compactFolders;

  async function reloadRoots() {
    setRoots(props.root ? await listChildren(props.root, compactFolders()) : []);
  }

  // Filtering searches the whole project, not the rows that happen to be
  // expanded: a lazily-loaded tree has most of itself unread, so filtering the
  // visible rows would answer a question nobody asked. `list_project_files`
  // already respects .gitignore, and is read once per root and cached.
  async function ensureFileList() {
    if (allFiles() !== null || !props.root) return;
    try {
      setAllFiles(await invoke<string[]>("list_project_files", { projectPath: props.root }));
    } catch {
      setAllFiles([]);
    }
  }

  // Matches, best first. Capped because a one-letter query matches most of a
  // repo and nobody reads past the first screen of it.
  const matches = () => {
    const q = filter().trim();
    const files = allFiles();
    if (!q || !files) return [];
    return files
      .map((rel) => ({ rel, score: fuzzyScore(q, rel) }))
      .filter((m): m is { rel: string; score: number } => m.score !== null)
      // Shorter wins a tie. `fuzzyScore` does not penalise length, so a deeply
      // nested file scores the same as the one sitting at the root with the same
      // name, and the ranked list would then just echo directory order. Broken
      // here rather than in `fuzzyScore`, which the omnibox and the sidebar share.
      .sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
      .slice(0, 200);
  };

  createEffect(
    on(
      () => props.root,
      (root, prev) => {
        if (prev) mounted.delete(prev);
        if (root) mounted.set(root, reloadRoots);
        // A different project is a different file list; keeping the old one
        // would filter this tree against someone else's files, and a selection
        // made over there would light up any path that happens to match here.
        setAllFiles(null);
        setFilter("");
        setSelected(new Set<string>());
        setRevealing(null);
        void reloadRoots();
      },
    ),
  );

  // Turning compaction on or off restructures every row, so the visible level
  // is rebuilt rather than left describing the other setting.
  createEffect(on(compactFolders, () => void reloadRoots(), { defer: true }));

  const ctx = (): EditCtx | undefined => {
    if (!props.editable || !props.root || !props.askText || !props.askConfirm) return undefined;
    return {
      root: props.root,
      noun: props.noun ?? "workspace folder",
      askText: props.askText,
      askConfirm: props.askConfirm,
      openMenu: (e, items) => setMenu({ x: e.clientX, y: e.clientY, items }),
      mounted,
      selected,
      toggleSelected: (path) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (!next.delete(path)) next.add(path);
          return next;
        }),
      clearSelected: () => setSelected((prev) => (prev.size ? new Set() : prev)),
    };
  };

  return (
    <div
      class={styles.fileTree}
      classList={{ [styles.dropInto]: dropRoot() }}
      // The background is the way back out of a folder: without it, a file
      // dragged into `src/` could only be moved to a sibling folder, never to
      // the workspace root. Folder rows stopPropagation, so they win.
      onDragOver={(e) => {
        const c = ctx();
        if (!c || !isTreeDrag(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setDropRoot(true);
      }}
      onDragLeave={() => setDropRoot(false)}
      onDrop={(e) => {
        const c = ctx();
        if (!c || !isTreeDrag(e)) return;
        e.preventDefault();
        setDropRoot(false);
        const from = e.dataTransfer?.getData(TREE_MOVE_MIME);
        if (from) void moveInto(c, from, c.root);
      }}
    >
      <Show when={ctx()}>
        {(c) => (
          <div class={styles.treeActions}>
            <Button variant="ghost" size="xs" onClick={() => newFileIn(c(), c().root, reloadRoots)}>
              <Icon icon={FilePlus} />
              New File
            </Button>
            <Button variant="ghost" size="xs" onClick={() => newFolderIn(c(), c().root, reloadRoots)}>
              <Icon icon={FolderPlus} />
              New Folder
            </Button>
            <Show when={revealable()}>
              <Button variant="ghost" size="xs" title="Reveal the open file" onClick={reveal}>
                <Icon icon={Crosshair} />
                Reveal
              </Button>
            </Show>
            <Button
              variant="ghost"
              size="xs"
              title="Collapse all folders"
              aria-label="Collapse all folders"
              onClick={() => setCollapseNonce((n) => n + 1)}
            >
              <Icon icon={ChevronsDownUp} />
            </Button>
          </div>
        )}
      </Show>
      <Show when={props.root}>
        <input
          class={styles.filterBox}
          type="text"
          placeholder="Filter files"
          aria-label="Filter files"
          value={filter()}
          onFocus={ensureFileList}
          onInput={(e) => {
            setFilter(e.currentTarget.value);
            void ensureFileList();
          }}
        />
      </Show>
      <Show when={!filter().trim()} fallback={<FilterResults root={props.root!} matches={matches()} />}>
      <Show
        when={roots().length}
        fallback={<div class={styles.empty}>This folder is empty. Use New File above to add one.</div>}
      >
        <For each={roots()}>
          {(e) => (
            <TreeNode
              entry={e.entry}
              label={e.label}
              depth={0}
              ctx={ctx()}
              reloadParent={reloadRoots}
              revealing={revealing}
              onRevealed={() => setRevealing(null)}
              collapseAll={collapseNonce}
              compactFolders={compactFolders()}
            />
          )}
        </For>
      </Show>
      </Show>
      <Show when={menu()}>
        <Menu x={menu()!.x} y={menu()!.y} items={menu()!.items} onClose={() => setMenu(null)} />
      </Show>
    </div>
  );
}
