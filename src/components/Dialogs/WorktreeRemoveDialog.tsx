import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";

// The removal confirmation for a single worktree. Shows what is being deleted (the
// branch + folder path), warns when the tree has uncommitted or unpushed work about
// to be lost, and offers a "delete the branch too" checkbox (default on). Replaces
// the old confirm()-gated Remove worktree / Delete worktree + branch pair with one
// explicit dialog. Enter confirms, Escape or a backdrop click cancels.
export default function WorktreeRemoveDialog(props: {
  label: string;
  path: string;
  branch: string | null;
  // null while the status is still loading; the flags fill in async.
  dirty: boolean | null;
  unpushed: boolean | null;
  // Whether the branch tracks a remote branch (so it can be deleted there too).
  hasRemote: boolean | null;
  busy: boolean;
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

  onMount(() => requestAnimationFrame(() => ok?.focus()));

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!props.busy) confirm();
    }
  }

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div
          class={`${styles.modal} ${styles.modalDanger}`}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          <div class={styles.modalTitle}>Remove worktree “{props.label}”?</div>

          <div class={styles.wtDetail}>
            <Show when={props.branch}>
              <div class={styles.wtDetailRow}>
                <span class={styles.wtDetailKey}>Branch</span>
                <span class={styles.wtDetailVal}>{props.branch}</span>
              </div>
            </Show>
            <div class={styles.wtDetailRow}>
              <span class={styles.wtDetailKey}>Folder</span>
              <span class={styles.wtDetailVal} title={props.path}>{props.path}</span>
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
          </div>

          <Show when={props.dirty || props.unpushed}>
            <div class={styles.modalWarn}>
              This deletes work that is not saved anywhere else. It cannot be undone.
            </div>
          </Show>

          <Show when={props.branch}>
            <label class={styles.wtCheck}>
              <input
                type="checkbox"
                checked={deleteLocal()}
                onChange={(e) => setDeleteLocal(e.currentTarget.checked)}
              />
              <span>Delete local branch (git branch -D)</span>
            </label>
          </Show>

          <Show when={props.hasRemote}>
            <label class={styles.wtCheck}>
              <input
                type="checkbox"
                checked={deleteRemote()}
                onChange={(e) => setDeleteRemote(e.currentTarget.checked)}
              />
              <span>Delete remote branch (git push --delete)</span>
            </label>
          </Show>

          <div class={styles.modalActions}>
            <Button onClick={() => props.onCancel()}>
              Cancel
            </Button>
            <Button ref={ok} variant="warn" disabled={props.busy} onClick={() => confirm()}>
              {props.busy ? "Removing…" : "Remove worktree"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
