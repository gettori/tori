import { createMemo, createSignal, onSettled, Errored, For, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { invoke } from "@tauri-apps/api/core";
import { Columns2, Copy, FileCode } from "../../components/Icon/icons";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { parseDiffHunks, DIFF_CONTEXT } from "../../utils/diffHunks";
import { buildRows } from "../../utils/diffView";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import { copyText } from "../../utils/clipboard";
import { parseCommitDiffArg } from "../../utils/syntheticTabs";
import DiffRows, { diffRowClasses } from "./DiffRows";
import type { CommitDetailData } from "./CommitDetail";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import styles from "./CommitDiffView.module.css";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * One file's patch within one commit, as its own tab. The commit view shows
 * the same patch inline under the file's row; this is the same read given a
 * tab of its own, so two files from one commit can sit side by side.
 */
export default function CommitDiffView(props: { workspace: string; arg: string }) {
  const target = createMemo(() => parseCommitDiffArg(props.arg));
  const detail = createMemo(() =>
    invoke<CommitDetailData>("git_commit_detail", { projectPath: props.workspace, sha: target().sha }),
  );
  const entry = () => detail().files.find((x) => x.path === target().file) ?? null;
  // The commit's file list first: a rename's patch needs the old path.
  const diff = createMemo(() => {
    const of = target();
    return invoke<string>("git_commit_file_diff", {
      projectPath: props.workspace,
      sha: of.sha,
      file: of.file,
      oldPath: entry()?.old_path ?? undefined,
      context: DIFF_CONTEXT,
    }).then((text) => ({ of, text }));
  });
  const [paneWidth, setPaneWidth] = createSignal(Infinity);

  const hunks = createMemo(() => parseDiffHunks(diff().text));
  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;
  const file = () => target().file;

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
        <FromDetail
          on={target()}
          fallback={() => (
            <span class={styles.status} data-status="">
              ?
            </span>
          )}
        >
          <span class={styles.status} data-status={entry()?.status ?? ""}>
            {entry()?.status ?? "?"}
          </span>
        </FromDetail>
        <span class={styles.name}>{fileName(file())}</span>
        <Show when={fileDir(file())}>
          <span class={styles.dir}>{fileDir(file())}</span>
        </Show>
        <FromDetail on={target()} fallback={() => <span class={styles.sha}>{target().sha.slice(0, 7)}</span>}>
          <span class={styles.sha}>{detail().short || target().sha.slice(0, 7)}</span>
        </FromDetail>
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
                <p>
                  {entry()?.old_path
                    ? "Moved, with no change to its contents."
                    : "No line changes to show (a binary file, or a mode change)."}
                </p>
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
        </Loading>
      </Errored>
    </div>
  );
}

function FromDetail(props: { on: unknown; fallback: () => JSX.Element; children: JSX.Element }) {
  return (
    <Errored fallback={props.fallback()}>
      <Loading on={props.on} fallback={props.fallback()}>
        {props.children}
      </Loading>
    </Errored>
  );
}
