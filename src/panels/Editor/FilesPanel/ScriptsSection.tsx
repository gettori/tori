import { createEffect, createSignal, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Play } from "lucide-solid";
import Icon from "../../../components/Icon/Icon";
import Chevron from "../../../components/Chevron/Chevron";
import ContextMenu from "../../../components/Menu/ContextMenu";
import OverlayScroll from "../../../components/Scrollbar/OverlayScroll";
import FileIcon from "../../../seti/FileIcon";
import { debounce } from "../../../utils/debounce";
import { emitWith, OPEN_IN_EDITOR, OPEN_TERMINAL, type FsChanged, type OpenInEditor } from "../../../utils/events";
import { isTaskSource, loadTasks, taskTab, type Task } from "../../../utils/tasks";
import { runTask } from "../../../utils/runTask";
import { loadTaskRuns } from "../../../utils/taskRecents";
import tree from "../FileTree/FileTree.module.css";
import styles from "./FilesPanel.module.css";

type DirEntry = { name: string };
type Group = { file: string; tasks: Task[] };

const FS_CHANGE_DEBOUNCE_MS = 400;

/** The latest run of `task` still holding its terminal, read off the tab ids
 *  `taskTab` mints, or 0 when none is. */
function runningRun(busy: ReadonlySet<string>, root: string, task: Task): number {
  const prefix = `task:${root}:${task.id}#`;
  let latest = 0;
  for (const id of busy) {
    if (id.startsWith(prefix)) latest = Math.max(latest, Number(id.slice(prefix.length)) || 0);
  }
  return latest;
}

/** Tasks by the file that defines them, in the order `loadTasks` found them:
 *  the root package.json, then workspace packages, then Make and just. */
function groupByFile(tasks: Task[]): Group[] {
  const out: Group[] = [];
  for (const t of tasks) {
    const file = t.file ?? "";
    const g = out.find((x) => x.file === file);
    if (g) g.tasks.push(t);
    else out.push({ file, tasks: [t] });
  }
  return out;
}

/** What this workspace can be told to do, one group per defining file, like
 *  VS Code's NPM Scripts view. A click runs; the menu also jumps to the line. */
export default function ScriptsSection(props: { root: string | null }) {
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [shut, setShut] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  // Bumped per read so a slow fs-refresh cannot overwrite a newer one.
  let scanGen = 0;

  async function scan() {
    const root = props.root;
    const gen = ++scanGen;
    if (!root) {
      setTasks([]);
      return;
    }
    try {
      const found = await loadTasks(
        root,
        (path) => invoke<DirEntry[]>("fs_read_dir", { path }),
        (path) => invoke<string>("fs_read_file", { path }),
        () => invoke<string[]>("list_project_files", { projectPath: root }),
      );
      if (gen !== scanGen) return;
      setTasks(found);
      setError(null);
    } catch (e) {
      // Said rather than swallowed: an empty list would read as "this project
      // defines no tasks", which is a claim about the project, not the read.
      if (gen !== scanGen) return;
      setTasks([]);
      setError(String(e));
    }
  }

  const debouncedScan = debounce(() => void scan(), FS_CHANGE_DEBOUNCE_MS);
  createEffect(
    on(
      () => props.root,
      () => void scan(),
    ),
  );

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const unlisten: UnlistenFn[] = [];
  let gone = false;
  onMount(async () => {
    const offs = await Promise.all([
      listen<FsChanged>("fs://changed", (e) => {
        if (e.payload.root && e.payload.root !== props.root) return;
        if (e.payload.paths.some(isTaskSource)) debouncedScan();
      }),
      listen<{ id: string; busy: boolean }>("pty://busy", (e) => mark(e.payload.id, e.payload.busy)),
      listen<{ id: string }>("pty://exit", (e) => mark(e.payload.id, false)),
    ]);
    if (gone) return offs.forEach((off) => off());
    unlisten.push(...offs);
    const ids = await invoke<string[]>("pty_busy_ids").catch(() => [] as string[]);
    if (!gone) setBusy(new Set(ids));
  });
  onCleanup(() => {
    gone = true;
    debouncedScan.cancel();
    unlisten.forEach((off) => off());
  });

  function run(task: Task) {
    if (props.root) runTask(loadTaskRuns(), props.root, task);
  }

  const running = (task: Task) => (props.root ? runningRun(busy(), props.root, task) : 0);

  function runOrShow(task: Task) {
    const n = running(task);
    if (n && props.root) emitWith(OPEN_TERMINAL, taskTab(props.root, task, n));
    else run(task);
  }

  function open(file: string, line?: number) {
    if (props.root) emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: `${props.root}/${file}`, line });
  }

  const toggle = (file: string) =>
    setShut((prev) => {
      const next = new Set(prev);
      if (!next.delete(file)) next.add(file);
      return next;
    });

  return (
    <OverlayScroll class={styles.sectionScroll}>
      <Show when={!error()} fallback={<div class={tree.empty}>{error()}</div>}>
        <Show
          when={tasks().length}
          fallback={<div class={tree.empty}>No scripts here. Tori reads package.json, Makefile and justfile.</div>}
        >
          <For each={groupByFile(tasks())}>
            {(g) => (
              <>
                <ContextMenu
                  items={[{ label: `Open ${g.file}`, onClick: () => open(g.file) }]}
                  class={tree.treeRow}
                  style={{ "padding-left": "8px" }}
                  onClick={() => toggle(g.file)}
                >
                  <Chevron open={!shut().has(g.file)} />
                  <FileIcon name={g.file.slice(g.file.lastIndexOf("/") + 1)} />
                  <span class={tree.treeName}>{g.file}</span>
                </ContextMenu>
                <Show when={!shut().has(g.file)}>
                  <For each={g.tasks}>
                    {(t) => (
                      <ContextMenu
                        items={[
                          ...(running(t)
                            ? [
                                { label: "Show terminal", onClick: () => runOrShow(t) },
                                { label: "Run again", onClick: () => run(t) },
                              ]
                            : [{ label: "Run", onClick: () => run(t) }]),
                          { label: `Open in ${g.file}`, onClick: () => open(g.file, t.line) },
                        ]}
                        class={tree.treeRow}
                        style={{ "padding-left": "20px" }}
                        onClick={() => runOrShow(t)}
                      >
                        <span
                          class={styles.play}
                          classList={{ [styles.running]: !!running(t) }}
                          title={running(t) ? "Running" : undefined}
                        >
                          <Icon icon={Play} />
                        </span>
                        <span class={tree.treeName}>{t.name}</span>
                        <span class={styles.command}>{t.command}</span>
                      </ContextMenu>
                    )}
                  </For>
                </Show>
              </>
            )}
          </For>
        </Show>
      </Show>
    </OverlayScroll>
  );
}
