import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR } from "../../events";
import styles from "./ReviewPanel.module.css";

type FileStatus = { status: string; path: string };

// Map a porcelain XY code to a coarse class for the badge color.
function statusClass(status: string): string {
  if (status.includes("?")) return "untracked";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  return "modified";
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/** Review surface: the uncommitted changed-file list (git_status) with a
 *  per-file inline diff toggle (git_diff_text). Clicking a name opens the file. */
export default function ReviewPanel(props: { root: string | null }) {
  const [files, setFiles] = createSignal<FileStatus[]>([]);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [diff, setDiff] = createSignal<string>("");

  async function refresh() {
    const root = props.root;
    if (!root) {
      setFiles([]);
      return;
    }
    try {
      setFiles(await invoke<FileStatus[]>("git_status", { projectPath: root }));
    } catch {
      setFiles([]);
    }
  }

  async function toggleDiff(path: string) {
    if (expanded() === path) {
      setExpanded(null);
      return;
    }
    const root = props.root;
    if (!root) return;
    try {
      setDiff(await invoke<string>("git_diff_text", { projectPath: root, file: path }));
    } catch {
      setDiff("");
    }
    setExpanded(path);
  }

  function openFile(path: string) {
    const root = props.root;
    if (root) emitWith(OPEN_IN_EDITOR, { path: `${root}/${path}` });
  }

  createEffect(
    on(
      () => props.root,
      () => {
        setExpanded(null);
        refresh();
      },
    ),
  );

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen("fs://changed", () => refresh());
  });
  onCleanup(() => unlisten?.());

  return (
    <div class={styles.reviewPanel}>
      <Show when={files().length} fallback={<div class="tree-empty">No changes</div>}>
        <For each={files()}>
          {(f) => (
            <div>
              <div class={styles.reviewRow} onClick={() => toggleDiff(f.path)} title={f.path}>
                <span class={`${styles.reviewStatus} ${styles[statusClass(f.status)]}`}>
                  {f.status.trim() || "?"}
                </span>
                <span
                  class={styles.reviewName}
                  onClick={(e) => {
                    e.stopPropagation();
                    openFile(f.path);
                  }}
                >
                  {f.path}
                </span>
              </div>
              <Show when={expanded() === f.path}>
                <div class={styles.reviewDiff}>
                  <For each={diff().split("\n")}>
                    {(line) => <div class={`${styles.diffLine} ${styles[diffLineClass(line)] ?? ""}`}>{line || " "}</div>}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
