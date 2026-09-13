import { createEffect, createMemo, createSignal, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Columns2, Copy, FileCode } from "lucide-solid";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { parseDiffHunks, DIFF_CONTEXT } from "../../utils/diffHunks";
import { buildRows } from "../../utils/diffView";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import { copyText } from "../../utils/clipboard";
import { parseCommitDiffArg } from "../../utils/syntheticTabs";
import DiffRows, { diffRowClasses } from "./DiffRows";
import type { CommitDetailData, CommitFile } from "./CommitDetail";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
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
  const [entry, setEntry] = createSignal<CommitFile | null>(null);
  const [short, setShort] = createSignal("");
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
    on([() => props.workspace, target], async ([workspace, { sha, file }]) => {
      const mine = ++current;
      setLoading(true);
      setDiff("");
      setError("");
      try {
        // The commit's file list first: a rename's patch needs the old path,
        // and the status letter comes from the same read.
        const detail = await invoke<CommitDetailData>("git_commit_detail", { projectPath: workspace, sha });
        if (mine !== current) return;
        const found = detail.files.find((x) => x.path === file) ?? null;
        setEntry(found);
        setShort(detail.short);
        const text = await invoke<string>("git_commit_file_diff", {
          projectPath: workspace,
          sha,
          file,
          oldPath: found?.old_path ?? undefined,
          context: DIFF_CONTEXT,
        });
        if (mine !== current) return;
        setDiff(text);
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
        <span class={styles.status} data-status={entry()?.status ?? ""}>
          {entry()?.status ?? "?"}
        </span>
        <span class={styles.name}>{fileName(file())}</span>
        <Show when={fileDir(file())}>
          <span class={styles.dir}>{fileDir(file())}</span>
        </Show>
        <span class={styles.sha}>{short() || target().sha.slice(0, 7)}</span>
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
              <p>
                {entry()?.old_path
                  ? "Moved, with no change to its contents."
                  : "No line changes to show (a binary file, or a mode change)."}
              </p>
            </Show>
          </div>
        }
      >
        <div class={styles.body}>
          <For each={hunks()}>
            {(hunk) => (
              <div>
                <div class={`${diffRowClasses.line} ${diffRowClasses.hunk}`}>{hunk.header}</div>
                <DiffRows rows={buildRows(hunk.lines)} path={file()} twoColumn={twoColumn()} />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
