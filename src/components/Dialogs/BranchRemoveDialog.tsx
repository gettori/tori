import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";

// The removal confirmation for a plain-repo branch (mirrors WorktreeRemoveDialog).
// The base action removes the branch from Sway's list; the checkboxes escalate that
// to deleting the local branch (git branch -D, default on) and/or the remote branch
// (git push --delete, default off, shown only when it tracks one). Unchecking local
// leaves the git branch alone, a plain detach. Enter confirms, Escape/backdrop cancel.
export default function BranchRemoveDialog(props: {
  branch: string;
  // null while status loads; fills in async.
  unpushed: boolean | null;
  hasRemote: boolean | null;
  busy: boolean;
  onConfirm: (opts: { deleteLocal: boolean; deleteRemote: boolean }) => void;
  onCancel: () => void;
}) {
  const [deleteLocal, setDeleteLocal] = createSignal(true);
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
        <div class={`${styles.modal} ${styles.modalDanger}`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class={styles.modalTitle}>Remove branch “{props.branch}”?</div>

          <div class={styles.wtDetail}>
            <div class={styles.wtDetailRow}>
              <span class={styles.wtDetailKey}>Branch</span>
              <span class={styles.wtDetailVal}>{props.branch}</span>
            </div>
            <div class={styles.wtDetailRow}>
              <span class={styles.wtDetailKey}>Status</span>
              <span class={styles.wtDetailTags}>
                <Show when={props.unpushed === null}>
                  <span class={`${styles.delTag} ${styles.muted}`}>checking…</span>
                </Show>
                <Show when={props.unpushed}>
                  <span class={`${styles.delTag} ${styles.warn}`}>unpushed commits</span>
                </Show>
                <Show when={props.unpushed === false}>
                  <span class={`${styles.delTag} ${styles.muted}`}>pushed</span>
                </Show>
              </span>
            </div>
          </div>

          <Show when={props.unpushed}>
            <div class={styles.modalWarn}>
              This branch has commits not on its remote. Deleting it loses them.
            </div>
          </Show>

          <label class={styles.wtCheck}>
            <input
              type="checkbox"
              checked={deleteLocal()}
              onChange={(e) => setDeleteLocal(e.currentTarget.checked)}
            />
            <span>Delete local branch (git branch -D)</span>
          </label>

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

          <Show when={!deleteLocal()}>
            <div class={styles.modalMsg}>
              The branch stays in git; it is only removed from Sway’s list (detach).
            </div>
          </Show>

          <div class={styles.modalActions}>
            <Button onClick={() => props.onCancel()}>
              Cancel
            </Button>
            <Button ref={ok} variant="warn" disabled={props.busy} onClick={() => confirm()}>
              {props.busy ? "Removing…" : "Remove branch"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
