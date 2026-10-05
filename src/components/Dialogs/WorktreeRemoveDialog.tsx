import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Checkbox from "../Checkbox/Checkbox";

// The removal confirmation for a single worktree. Shows what is being deleted (the
// branch + folder path), warns when the tree has uncommitted or unpushed work about
// to be lost, and offers a "delete the branch too" checkbox (default on). Replaces
// the old confirm()-gated Remove worktree / Delete worktree + branch pair with one
// explicit dialog.
//
// The shell is `Dialog` (see `BranchRemoveDialog` for why Enter stays here and
// Escape does not). This is also the dialog most likely to be underneath another
// one: it stays mounted with `busy` set while the removal runs, and a remote
// delete is a network op that can raise an askpass prompt on top of it, which
// `stackedDialogs.test.tsx` covers.
export default function WorktreeRemoveDialog(props: {
  label: string;
  path: string;
  branch: string | null;
  // null while the status is still loading; the flags fill in async.
  dirty: boolean | null;
  unpushed: boolean | null;
  // Whether the branch tracks a remote branch (so it can be deleted there too).
  hasRemote: boolean | null;
  // Live shell/agent tabs running under this worktree, whose PTYs removal tears down.
  runningCount: number;
  busy: boolean;
  /** What declining is called. "Cancel" everywhere the worktree is the only
   *  thing at stake; "Keep worktree" where the caller has already changed
   *  something else (Remove repository detaches the record first, so cancelling
   *  there would read as an undo the dialog cannot perform). */
  keepLabel?: string;
  onConfirm: (opts: { deleteLocal: boolean; deleteRemote: boolean }) => void;
  onCancel: () => void;
}) {
  // Local delete on by default: the common case is discarding a finished branch's
  // worktree and its local branch. Remote delete off by default, it's a network op
  // that affects everyone, so it must be an explicit opt-in.
  const [deleteLocal, setDeleteLocal] = createSignal(props.branch != null);
  const [deleteRemote, setDeleteRemote] = createSignal(false);
  const confirm = () => props.onConfirm({ deleteLocal: deleteLocal(), deleteRemote: deleteRemote() });
  let ok: HTMLButtonElement | undefined;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!props.busy) confirm();
  }

  return (
    <Dialog
      open
      size="sheet"
      title={`Remove worktree “${props.label}”?`}
      onClose={() => props.onCancel()}
      onKeyDown={onKeyDown}
      initialFocus={() => ok}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>{props.keepLabel ?? "Cancel"}</Button>
          <Button ref={ok} variant="warn" disabled={props.busy} onClick={() => confirm()}>
            {props.busy ? "Removing…" : "Remove worktree"}
          </Button>
        </>
      }
    >
      <div class={styles.wtDetail}>
        <Show when={props.branch}>
          <div class={styles.wtDetailRow}>
            <span class={styles.wtDetailKey}>Branch</span>
            <span class={styles.wtDetailVal}>{props.branch}</span>
          </div>
        </Show>
        <div class={styles.wtDetailRow}>
          <span class={styles.wtDetailKey}>Folder</span>
          <span class={styles.wtDetailVal} title={props.path}>
            {props.path}
          </span>
        </div>
        <div class={styles.wtDetailRow}>
          <span class={styles.wtDetailKey}>Status</span>
          <span class={styles.wtDetailTags}>
            <Show when={props.dirty === null || props.unpushed === null}>
              <span class={`${styles.delTag} ${styles.muted}`}>checking…</span>
            </Show>
            <Show when={props.dirty}>
              <span class={`${styles.delTag} ${styles.warn}`}>uncommitted changes</span>
            </Show>
            <Show when={props.unpushed}>
              <span class={`${styles.delTag} ${styles.warn}`}>unpushed commits</span>
            </Show>
            <Show when={props.dirty === false && props.unpushed === false}>
              <span class={`${styles.delTag} ${styles.muted}`}>clean</span>
            </Show>
          </span>
        </div>
        <Show when={props.runningCount > 0}>
          <div class={styles.wtDetailRow}>
            <span class={styles.wtDetailKey}>Running</span>
            <span class={styles.wtDetailVal}>
              {props.runningCount} terminal tab{props.runningCount === 1 ? "" : "s"} (their processes will be stopped)
            </span>
          </div>
        </Show>
      </div>

      <Show when={props.dirty || props.unpushed}>
        <div class={styles.warning}>This deletes work that is not saved anywhere else. It cannot be undone.</div>
      </Show>

      <Show when={props.branch}>
        <Checkbox
          class={styles.wtCheck}
          checked={deleteLocal()}
          onChange={setDeleteLocal}
          label="Delete local branch (git branch -D)"
        />
      </Show>

      <Show when={props.hasRemote}>
        <Checkbox
          class={styles.wtCheck}
          checked={deleteRemote()}
          onChange={setDeleteRemote}
          label="Delete remote branch (git push --delete)"
        />
      </Show>
    </Dialog>
  );
}
