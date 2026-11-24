import { createSignal, createMemo, createEffect, onSettled, Errored, For, Loading, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { parseDiffHunks } from "../../utils/diffHunks";
import { buildRows } from "../../utils/diffView";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import DiffRows, { diffRowClasses } from "./DiffRows";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Tooltip from "../../components/Tooltip/Tooltip";
import styles from "./CommitDetail.module.css";

/** Mirrors `CommitFile` in src-tauri/src/git.rs. */
export type CommitFile = {
  path: string;
  old_path: string | null;
  status: string;
};

/** Mirrors `CommitDetail` in src-tauri/src/git.rs. */
export type CommitDetailData = {
  sha: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  relative_date: string;
  parents: string[];
  refs: string[];
  files: CommitFile[];
};

/** Matches the Changes panel, so a hunk reads the same in both places. */
const DIFF_CONTEXT = 3;

const STATUS_WORD: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
};

/**
 * One commit, opened as an editor tab from a row in the graph or in a file's
 * history.
 *
 * Diffs are fetched per file rather than as one patch for the whole commit: a
 * commit can touch hundreds of files, and the reader almost always wants two of
 * them. The rows come back with the commit; the patch comes back when a row is
 * opened, which is the same bargain the Changes panel strikes.
 */
export default function CommitDetail(props: { workspace: string; sha: string }) {
  const detail = createMemo(() =>
    invoke<CommitDetailData>("git_commit_detail", { projectPath: props.workspace, sha: props.sha }),
  );
  // Which file's patch is open, by path, and the patch itself.
  const [openFile, setOpenFile] = createSignal<string | null>(null);
  const [diff, setDiff] = createSignal("");
  const [diffError, setDiffError] = createSignal("");
  const [paneWidth, setPaneWidth] = createSignal(Infinity);

  const hunks = createMemo(() => parseDiffHunks(diff()));
  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;
  const isMerge = () => detail().parents.length > 1;

  // Switching from one commit tab to another reuses this component, so an open
  // row belongs to the commit you left.
  createEffect(
    () => [props.workspace, props.sha] as const,
    () => {
      setOpenFile(null);
      setDiff("");
    },
  );

  async function toggleFile(f: CommitFile) {
    if (openFile() === f.path) {
      setOpenFile(null);
      setDiff("");
      return;
    }
    // Set first, so the row reads as open while its patch is on the way.
    setOpenFile(f.path);
    setDiff("");
    setDiffError("");
    try {
      const text = await invoke<string>("git_commit_file_diff", {
        projectPath: props.workspace,
        sha: props.sha,
        file: f.path,
        // Without the old path a renamed file comes back as an addition of the
        // whole file; see `CommitFile::old_path` in git.rs.
        oldPath: f.old_path ?? undefined,
        context: DIFF_CONTEXT,
      });
      if (openFile() !== f.path) return;
      setDiff(text);
    } catch (e) {
      if (openFile() !== f.path) return;
      setDiffError(String(e));
    }
  }

  function toggleColumns() {
    writeSideBySide(!sideBySide());
  }

  function rowLabel(f: CommitFile): string {
    return f.old_path ? `${f.old_path} → ${f.path}` : f.path;
  }

  let paneRef: HTMLDivElement | undefined;
  onSettled(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    ro.observe(paneRef);
    return () => ro.disconnect();
  });

  return (
    <div class={styles.commitDetail} ref={paneRef}>
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
        <Loading on={props.sha} fallback={<div class="tree-empty">Reading the commit...</div>}>
          <Show when={detail()}>
            {(c) => (
              <>
                <div class={styles.header}>
                  <div class={styles.subjectRow}>
                    <span class={styles.subject}>{c().subject}</span>
                    <For each={c().refs}>{(r) => <span class={styles.ref}>{r}</span>}</For>
                    <IconButton
                      size="xs"
                      active={twoColumn()}
                      disabled={paneWidth() < SIDE_BY_SIDE_MIN_WIDTH}
                      icon={<span aria-hidden="true">⇹</span>}
                      tooltipWhenDisabled
                      tooltip={
                        paneWidth() < SIDE_BY_SIDE_MIN_WIDTH
                          ? "Side-by-side needs a wider pane"
                          : twoColumn()
                            ? "Switch to inline diff"
                            : "Switch to side-by-side diff"
                      }
                      onClick={toggleColumns}
                    />
                  </div>
                  <div class={styles.meta}>
                    <span class={styles.sha} title={c().sha}>
                      {c().short}
                    </span>
                    <span>
                      {c().author} &lt;{c().email}&gt;
                    </span>
                    <span>{c().relative_date}</span>
                    {/* Worth saying: the diff below is against the first parent, so
                    it shows what the merge brought in, not every change in the
                    branch it merged. */}
                    <Show when={isMerge()}>
                      <span class={styles.mergeNote}>merge, shown against its first parent</span>
                    </Show>
                  </div>
                  <Show when={c().body}>
                    <pre class={styles.body}>{c().body}</pre>
                  </Show>
                </div>
                <Show when={c().files.length} fallback={<div class="tree-empty">This commit changed no files.</div>}>
                  <For each={c().files}>
                    {(f) => (
                      <div>
                        <Tooltip
                          as="button"
                          type="button"
                          class={styles.fileRow}
                          label={rowLabel(f)}
                          onClick={() => void toggleFile(f)}
                        >
                          <span class={styles.status} data-status={f.status}>
                            {STATUS_WORD[f.status] ?? f.status}
                          </span>
                          <span class={styles.path}>{rowLabel(f)}</span>
                        </Tooltip>
                        <Show when={openFile() === f.path}>
                          <div class={styles.fileDiff}>
                            <Show when={diffError()}>
                              <div class={styles.error}>{diffError()}</div>
                            </Show>
                            <Show
                              when={hunks().length}
                              fallback={
                                <Show when={!diffError() && diff()}>
                                  <div class="tree-empty">
                                    {f.old_path
                                      ? "Moved, with no change to its contents."
                                      : "No line changes to show (a binary file, or a mode change)."}
                                  </div>
                                </Show>
                              }
                            >
                              <For each={hunks()}>
                                {(hunk) => (
                                  <div>
                                    <div class={`${diffRowClasses.line} ${diffRowClasses.hunk}`}>{hunk.header}</div>
                                    <DiffRows
                                      rows={buildRows(hunk.lines, { old: hunk.oldStart, new: hunk.startLine })}
                                      twoColumn={twoColumn()}
                                    />
                                  </div>
                                )}
                              </For>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </>
            )}
          </Show>
        </Loading>
      </Errored>
    </div>
  );
}
