import { createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { syntheticId } from "../../utils/syntheticTabs";
import { requestCommitFile } from "../../utils/commitFocus";
import FileIcon from "../../seti/FileIcon";
import Tooltip from "../../components/Tooltip/Tooltip";
import type { CommitDetailData, CommitFile } from "./CommitDetail";
import styles from "./CommitFiles.module.css";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * What one commit touched, as rows under it in a sidebar list. Shared by the
 * Stashes and Graph sections; a stash is a commit, so one fetch serves both.
 * A row opens the commit view with that file's patch already open.
 */
export default function CommitFiles(props: { root: string; sha: string }) {
  const [detail] = createResource(
    () => ({ projectPath: props.root, sha: props.sha }),
    (args) => invoke<CommitDetailData>("git_commit_detail", args),
  );

  function open(f: CommitFile) {
    requestCommitFile(props.sha, f.path);
    emitWith(OPEN_IN_EDITOR, { path: syntheticId("commit", props.root, props.sha) });
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
