import { createEffect, createSignal, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../components/Button/Button";
import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "../../utils/events";
import styles from "./LocalHistory.module.css";

/** `HistoryEntry` from `src-tauri/src/local_history.rs`. */
type Entry = { ts: number; blob: string; size: number };

function shortTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const clock = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  // The date only when it is not today: a column of "today" on every row is a
  // column that distinguishes nothing.
  return sameDay ? clock : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Same rule the checkpoint timeline and the transcript's diff view use, so a
 *  unified diff reads identically wherever it appears. */
function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/**
 * One file's local history: every version this editor saved, newest first.
 *
 * A sibling of the git file-history view rather than a part of it, because the
 * two answer different questions. `git log` lists what was committed; this
 * lists what was *had* - the edit made, saved, and replaced ten minutes later
 * without ever being staged, which is exactly what people come looking for and
 * the one thing git never kept.
 *
 * Picking a version diffs it against the file as it is now. Restoring writes
 * those bytes back to disk and nothing else: the user's index is not touched,
 * so whatever they had staged survives it (the manual-git invariant).
 */
export default function LocalHistory(props: { workspace: string; file: string }) {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [picked, setPicked] = createSignal<number | null>(null);
  // `null` is "not read yet", `""` is "identical to the file". Two different
  // things that would otherwise both render as the empty-diff message, so
  // picking a row would claim it matched the file before anything had looked.
  const [diff, setDiff] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [restoring, setRestoring] = createSignal(false);

  const abs = () => `${props.workspace}/${props.file}`;

  async function reload() {
    setLoading(true);
    try {
      const found = await invoke<Entry[]>("local_history_list", {
        repoPath: props.workspace,
        path: abs(),
      });
      setEntries(found);
      setError(null);
    } catch (e) {
      setEntries([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  createEffect(on([() => props.workspace, () => props.file], () => {
    setPicked(null);
    setDiff(null);
    void reload();
  }));

  // Bumped per request so a slow diff cannot land under a row picked since, the
  // same latest-wins guard the Search, TODO and Tasks panels keep.
  let pickGen = 0;

  async function pick(ts: number) {
    const gen = ++pickGen;
    if (picked() === ts) {
      setPicked(null);
      setDiff(null);
      return;
    }
    setPicked(ts);
    setDiff(null);
    const text = await invoke<string>("local_history_diff", {
      repoPath: props.workspace,
      path: abs(),
      ts,
    }).catch((e) => `Could not read that version: ${e}`);
    if (gen !== pickGen) return;
    setDiff(text);
  }

  async function restore(ts: number) {
    if (restoring()) return;
    setRestoring(true);
    try {
      await invoke("local_history_restore", { repoPath: props.workspace, path: abs(), ts });
      // Reopened rather than left to the file watcher: the point of pressing
      // restore is to look at what came back, and a buffer already open on this
      // file is what the watcher would have to reconcile anyway.
      emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: abs() });
      emitWith<ToastEvent>(TOAST, { message: `Restored ${props.file} to ${shortTime(ts)}`, kind: "info" });
      await reload();
      setPicked(null);
      setDiff(null);
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: String(e) });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div class={styles.localHistory}>
      <div class={styles.head}>
        <span class={styles.title}>Local history</span>
        <span class={styles.sub}>{props.file}</span>
      </div>
      <Show when={!error()} fallback={<div class="tree-empty">{error()}</div>}>
        <Show when={loading() || entries().length} fallback={
          <div class="tree-empty">
            No saved versions yet. Sway keeps one each time you save this file, whether or not it
            is committed.
          </div>
        }>
          <div class={styles.list}>
            <For each={entries()}>
              {(entry, i) => (
                <>
                  <div
                    class={styles.row}
                    classList={{ [styles.rowOn]: picked() === entry.ts }}
                    onClick={() => void pick(entry.ts)}
                  >
                    <span class={styles.when}>{shortTime(entry.ts)}</span>
                    {/* The newest entry is what the file was at its last save,
                        which is the one version whose relationship to what is on
                        screen is worth naming. */}
                    <span class={styles.tag}>{i() === 0 ? "last save" : ""}</span>
                    <span class={styles.size}>{formatBytes(entry.size)}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      class={styles.restore}
                      disabled={restoring()}
                      tooltip="Write this version back to the file"
                      onClick={(e) => {
                        e.stopPropagation();
                        void restore(entry.ts);
                      }}
                    >
                      Restore
                    </Button>
                  </div>
                  <Show when={picked() === entry.ts}>
                    <div class={styles.diff}>
                      <Show
                        when={diff() !== null}
                        fallback={<div class={styles.same}>Reading that version…</div>}
                      >
                        <Show
                          when={diff()}
                          fallback={<div class={styles.same}>Identical to the file as it is now.</div>}
                        >
                          <For each={diff()!.split("\n")}>
                            {(line) => (
                              <div class={`${styles.diffLine} ${styles[diffLineClass(line)] ?? ""}`}>
                                {line || " "}
                              </div>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
