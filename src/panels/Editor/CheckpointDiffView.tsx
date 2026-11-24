import { createEffect, createMemo, createSignal, onSettled, Errored, For, Loading, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Columns2, Copy, FileCode } from "../../components/Icon/icons";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { parseDiffHunks } from "../../utils/diffHunks";
import { buildRows } from "../../utils/diffView";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import { copyText } from "../../utils/clipboard";
import { checkpointClock, parseCheckpointDiffArg, WORKTREE_SOURCE } from "../../utils/syntheticTabs";
import DiffRows, { diffRowClasses } from "./DiffRows";
import HunkProvenance, { createOpenHunks, WhyToggle } from "./HunkProvenance";
import { claimsVia, type ClaimReader } from "../../utils/provenance";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import styles from "./CommitDiffView.module.css";
import hunkStyles from "./HunkCommentInput.module.css";

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

/** Who wrote a checkpoint diff's hunks, against the tree that diff ends at. */
export function checkpointClaims(
  workspace: string,
  target: { source: string; ts: number; scope: "turn" | "since"; file: string },
): ClaimReader {
  return claimsVia("checkpoint_provenance", {
    repoPath: workspace,
    sessionId: target.source === WORKTREE_SOURCE ? null : target.source,
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
  const diff = createMemo(() => {
    const of = target();
    return checkpointFileDiff(props.workspace, of).then((text) => ({ of, text }));
  });
  const [paneWidth, setPaneWidth] = createSignal(Infinity);
  const whyOpen = createOpenHunks();

  const hunks = createMemo(() => parseDiffHunks(diff().text));
  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;
  const file = () => target().file;

  createEffect(
    () => [props.workspace, target()] as const,
    () => {
      whyOpen.clear();
    },
  );

  // The read throws while pending or failed, and holds the previous file's
  // diff while the next one is read.
  function shownDiff(): string {
    try {
      const shown = diff();
      return shown.of === target() ? shown.text : "";
    } catch {
      return "";
    }
  }

  async function copyDiff() {
    const text = shownDiff();
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
  onSettled(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([e]) => setPaneWidth(e.contentRect.width));
    ro.observe(paneRef);
    return () => ro.disconnect();
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
          aria-pressed={twoColumn() ? "true" : "false"}
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
      <Errored
        fallback={(err, reset) => (
          <div class={styles.error}>
            {String(err())}{" "}
            <Button size="xs" variant="ghost" onClick={() => reset()}>
              Try again
            </Button>
          </div>
        )}
      >
        <Loading
          on={target()}
          fallback={
            <div class="tree-empty">
              <p>Reading the diff...</p>
            </div>
          }
        >
          <Show
            when={hunks().length}
            fallback={
              <div class="tree-empty">
                <p>No line changes to show (a binary file, or a mode change).</p>
              </div>
            }
          >
            <div class={styles.body}>
              <For each={hunks()}>
                {(hunk, hi) => (
                  <div>
                    <div class={`${diffRowClasses.line} ${diffRowClasses.hunk} ${hunkStyles.hunkHeaderRow}`}>
                      <span class={hunkStyles.hunkHeaderText}>{hunk.header}</span>
                      <WhyToggle open={whyOpen.has(hi())} onClick={() => whyOpen.toggle(hi())} />
                    </div>
                    <Show when={whyOpen.has(hi())}>
                      <HunkProvenance file={file()} hunk={hunk} read={checkpointClaims(props.workspace, target())} />
                    </Show>
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
        </Loading>
      </Errored>
    </div>
  );
}
