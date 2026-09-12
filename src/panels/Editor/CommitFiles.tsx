import { createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { commitDiffTabId } from "../../utils/syntheticTabs";
import FileIcon from "../../seti/FileIcon";
import Tooltip from "../../components/Tooltip/Tooltip";
import type { CommitDetailData, CommitFile } from "./CommitDetail";
import styles from "./CommitFiles.module.css";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * What one commit touched, as rows under it in a sidebar list. Shared by the
 * Stashes and Graph sections; a stash is a commit, so one fetch serves both.
 * A row opens that file's patch in a tab of its own.
 */
export default function CommitFiles(props: { root: string; sha: string }) {
  const [detail] = createResource(
    () => ({ projectPath: props.root, sha: props.sha }),
    (args) => invoke<CommitDetailData>("git_commit_detail", args),
  );

  function open(f: CommitFile) {
    emitWith(OPEN_IN_EDITOR, { path: commitDiffTabId(props.root, props.sha, f.path) });
  }

  return (
    <div class={styles.files}>
      <Show when={detail.error}>
        <div class={styles.note}>{String(detail.error)}</div>
      </Show>
      <Show when={detail()}>
        {(d) => (
          <Show when={d().files.length} fallback={<div class={styles.note}>No files in this commit.</div>}>
            <For each={d().files}>
              {(f) => (
                <Tooltip
                  as="button"
                  type="button"
                  class={styles.row}
                  label={f.old_path ? `${f.old_path} -> ${f.path}` : f.path}
                  onClick={() => open(f)}
                >
                  <FileIcon name={baseName(f.path)} />
                  <span class={styles.name}>{baseName(f.path)}</span>
                  <Show when={dirName(f.path)}>
                    <span class={styles.dir}>{dirName(f.path)}</span>
                  </Show>
                  <span class={styles.status} data-status={f.status}>
                    {f.status}
                  </span>
                </Tooltip>
              )}
            </For>
          </Show>
        )}
      </Show>
    </div>
  );
}
