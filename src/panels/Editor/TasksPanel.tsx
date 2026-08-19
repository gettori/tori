import { createEffect, createSignal, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Play } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import { debounce } from "../../utils/debounce";
import type { FsChanged } from "../../utils/events";
import { loadTasks, type Task, type TaskSource } from "../../utils/tasks";
import { runTask } from "../../utils/runTask";
import { loadTaskRuns, runsFor, type TaskRunStore } from "../../utils/taskRecents";
import styles from "./TasksPanel.module.css";

type DirEntry = { name: string };

const FS_CHANGE_DEBOUNCE_MS = 400;

/** What each source is called on screen, and the order the sections appear in.
 *  npm first because a `scripts` block is the one most projects have. */
const SECTIONS: { source: TaskSource; label: string }[] = [
  { source: "npm", label: "Scripts" },
  { source: "make", label: "Make" },
  { source: "just", label: "Just" },
];

/**
 * What this project can be told to do, as a list you pick from.
 *
 * The tasks come from `utils/tasks.ts` and nowhere else, which is the same
 * module the omnibox's rows are built from: one reader means the palette and the
 * panel cannot drift into disagreeing about what this project defines.
 *
 * Re-reads on `fs://changed` while mounted, so adding a script shows up without
 * reopening anything. The right-hand Switch/Match tears this down when another
 * mode is selected, so nothing re-reads while it is hidden.
 */
export default function TasksPanel(props: { root: string | null }) {
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [runs, setRuns] = createSignal<TaskRunStore>(loadTaskRuns());
  // Bumped per read so a slow fs-refresh cannot overwrite a newer one, the same
  // latest-wins guard the Search and TODO panels keep.
  let scanGen = 0;

  const recents = () => runsFor(runs(), props.root);
  const forSource = (source: TaskSource) => tasks().filter((t) => t.source === source);

  async function scan() {
    const root = props.root;
    if (!root) {
      scanGen++;
      setTasks([]);
      return;
    }
    const gen = ++scanGen;
    setLoading(true);
    try {
      const found = await loadTasks(
        root,
        (path) => invoke<DirEntry[]>("fs_read_dir", { path }),
        (path) => invoke<string>("fs_read_file", { path }),
      );
      if (gen !== scanGen) return;
      setTasks(found);
      setError(null);
    } catch (e) {
      // Said rather than swallowed: an empty list would read as "this project
      // defines no tasks", which is a claim about the project rather than about
      // a folder that could not be listed.
      if (gen !== scanGen) return;
      setTasks([]);
      setError(String(e));
    } finally {
      if (gen === scanGen) setLoading(false);
    }
  }

  const debouncedScan = debounce(() => void scan(), FS_CHANGE_DEBOUNCE_MS);

  createEffect(on(() => props.root, () => void scan()));

  let unlistenFs: UnlistenFn | undefined;
  onMount(async () => {
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      if (e.payload.root && e.payload.root !== props.root) return;
      debouncedScan();
    });
  });
  onCleanup(() => unlistenFs?.());

  function run(task: Task) {
    const root = props.root;
    if (!root) return;
    setRuns(runTask(runs(), root, task));
  }

  // No `aria-label`: the name and the command below are what the row should be
  // called. The tooltip repeats the command because the row truncates it, and a
  // row you can Tab to should be able to show it.
  function row(task: Task) {
    return (
      <Tooltip as="button" type="button" class={styles.taskRow} onClick={() => run(task)} label={task.command}>
        <span class={styles.play}>
          <Icon icon={Play} />
        </span>
        <span class={styles.name}>{task.name}</span>
        <span class={styles.command}>{task.command}</span>
      </Tooltip>
    );
  }

  return (
    <div class={styles.tasksPanel}>
      <Show when={props.root} fallback={<div class="tree-empty">Open a project to see its tasks.</div>}>
        <Show when={!error()} fallback={<div class="tree-empty">{error()}</div>}>
          <Show
            when={tasks().length || loading()}
            fallback={
              <div class="tree-empty">
                No tasks here. Sway reads npm scripts, Make targets and just recipes.
              </div>
            }
          >
            <div class={styles.list}>
              <Show when={recents().length}>
                <div class={styles.sectionHead}>Recent</div>
                {/* The same tasks again, on purpose: this is the shortcut past
                    reading the list, and a recent row that had to be hunted for
                    in the section below would not be one. */}
                <For each={recents()}>{(entry) => row(entry.task)}</For>
              </Show>
              <For each={SECTIONS}>
                {(section) => (
                  <Show when={forSource(section.source).length}>
                    <div class={styles.sectionHead}>{section.label}</div>
                    <For each={forSource(section.source)}>{(task) => row(task)}</For>
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
