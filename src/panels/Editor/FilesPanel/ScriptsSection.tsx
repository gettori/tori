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
import { emitWith, OPEN_IN_EDITOR, type FsChanged, type OpenInEditor } from "../../../utils/events";
import { isTaskSource, loadTasks, type Task } from "../../../utils/tasks";
import { runTask } from "../../../utils/runTask";
import { loadTaskRuns } from "../../../utils/taskRecents";
import tree from "../FileTree/FileTree.module.css";
import styles from "./FilesPanel.module.css";

type DirEntry = { name: string };
type Group = { file: string; tasks: Task[] };

const FS_CHANGE_DEBOUNCE_MS = 400;

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
  createEffect(on(() => props.root, () => void scan()));

  let unlistenFs: UnlistenFn | undefined;
  let gone = false;
  onMount(async () => {
    const off = await listen<FsChanged>("fs://changed", (e) => {
      if (e.payload.root && e.payload.root !== props.root) return;
      if (e.payload.paths.some(isTaskSource)) debouncedScan();
    });
    if (gone) off();
    else unlistenFs = off;
  });
  onCleanup(() => {
    gone = true;
    debouncedScan.cancel();
    unlistenFs?.();
  });

  function run(task: Task) {
    if (props.root) runTask(loadTaskRuns(), props.root, task);
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
          fallback={<div class={tree.empty}>No scripts here. Sway reads package.json, Makefile and justfile.</div>}
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
                          { label: "Run", onClick: () => run(t) },
                          { label: `Open in ${g.file}`, onClick: () => open(g.file, t.line) },
                        ]}
                        class={tree.treeRow}
                        style={{ "padding-left": "20px" }}
                        onClick={() => run(t)}
                      >
                        <span class={styles.play}>
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
