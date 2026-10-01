import { createEffect, createMemo, createSignal, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Columns2, Copy, FileCode } from "lucide-solid";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { parseDiffHunks } from "../../utils/diffHunks";
import { buildRows } from "../../utils/diffView";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import { copyText } from "../../utils/clipboard";
import { checkpointClock, parseCheckpointDiffArg, WORKTREE_SOURCE } from "../../utils/syntheticTabs";
import DiffRows, { diffRowClasses } from "./DiffRows";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import styles from "./CommitDiffView.module.css";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** One checkpoint's diff for one file, whichever kind of checkpoint it is. */
export function checkpointFileDiff(
  workspace: string,
  target: { source: string; ts: number; scope: "turn" | "since"; file: string },
): Promise<string> {
  if (target.source === WORKTREE_SOURCE) {
    return invoke<string>("backstop_diff_file", { repoPath: workspace, ts: target.ts, file: target.file });
  }
  return invoke<string>("checkpoint_diff_file", {
    repoPath: workspace,
    sessionId: target.source,
    promptTs: target.ts,
    file: target.file,
    cumulative: target.scope === "since",
  });
}

/**
 * One file's change within one checkpoint, as its own tab. The Checkpoints
 * panel shows the same patch inline under the file's row; this is the same read
 * given room, and a side-by-side view the sidebar is too narrow for.
 */
export default function CheckpointDiffView(props: { workspace: string; arg: string }) {
  const target = createMemo(() => parseCheckpointDiffArg(props.arg));
  const [diff, setDiff] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [paneWidth, setPaneWidth] = createSignal(Infinity);

  const hunks = createMemo(() => parseDiffHunks(diff()));
  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;
  const file = () => target().file;

  // Which read is current: the tab strip reuses this component across tabs
  // of the same kind, so an earlier tab's answer can land after a later one's.
  let current = 0;

  createEffect(
    on([() => props.workspace, target], async ([workspace, target]) => {
      const mine = ++current;
      setLoading(true);
      setDiff("");
      setError("");
      try {
        const text = await checkpointFileDiff(workspace, target);
        if (mine === current) setDiff(text);
      } catch (e) {
        if (mine === current) setError(String(e));
      } finally {
        if (mine === current) setLoading(false);
      }
    }),
  );

  async function copyDiff() {
    const text = diff();
    if (!text) {
      emitWith<ToastEvent>(TOAST, { message: "No diff to copy.", kind: "error" });
      return;
    }
    const ok = await copyText(text);
    emitWith<ToastEvent>(TOAST, {
      message: ok ? `Copied diff for ${file()}` : "Couldn't copy to the clipboard.",
      kind: ok ? "info" : "error",
    });
  }

  let paneRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([e]) => setPaneWidth(e.contentRect.width));
    ro.observe(paneRef);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div class={styles.commitDiff} ref={paneRef}>
      <div class={styles.topBar}>
        <span class={styles.name}>{fileName(file())}</span>
        <Show when={fileDir(file())}>
          <span class={styles.dir}>{fileDir(file())}</span>
        </Show>
        <span class={styles.sha}>
          {target().scope === "since" ? `since ${checkpointClock(target().ts)}` : checkpointClock(target().ts)}
        </span>
        <span class={styles.spacer} />
        <IconButton size="sm" icon={<Icon icon={Copy} />} tooltip="Copy diff" onClick={() => void copyDiff()} />
        <IconButton
          size="sm"
          icon={<Icon icon={FileCode} />}
          tooltip="Open the file as it is now"
          onClick={() => emitWith(OPEN_IN_EDITOR, { path: `${props.workspace}/${file()}` })}
        />
        <IconButton
          size="sm"
          class={styles.pressable}
          aria-pressed={twoColumn()}
          icon={<Icon icon={Columns2} />}
          disabled={paneWidth() < SIDE_BY_SIDE_MIN_WIDTH}
          tooltipWhenDisabled
          tooltip={
            paneWidth() < SIDE_BY_SIDE_MIN_WIDTH
              ? "Side-by-side needs a wider pane"
              : twoColumn()
                ? "Switch to inline diff"
                : "Switch to side-by-side diff"
          }
          onClick={() => writeSideBySide(!sideBySide())}
        />
      </div>
      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>
      <Show
        when={hunks().length}
        fallback={
          <div class="tree-empty">
            <Show when={!loading() && !error()}>
              <p>No line changes to show (a binary file, or a mode change).</p>
            </Show>
          </div>
        }
      >
        <div class={styles.body}>
          <For each={hunks()}>
            {(hunk) => (
              <div>
                <div class={`${diffRowClasses.line} ${diffRowClasses.hunk}`}>{hunk.header}</div>
                <DiffRows
                  rows={buildRows(hunk.lines, { old: hunk.oldStart, new: hunk.startLine })}
                  path={file()}
                  twoColumn={twoColumn()}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
