import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Checkbox from "../Checkbox/Checkbox";

// The removal confirmation for a plain-repo branch (mirrors WorktreeRemoveDialog).
// The base action removes the branch from Tori's list; the checkboxes escalate that
// to deleting the local branch (git branch -D, default on) and/or the remote branch
// (git push --delete, default off, shown only when it tracks one). Unchecking local
// leaves the git branch alone, a plain detach.
//
// The shell is `Dialog`: the portal, the backdrop, Escape and the focus trap all
// come from there, and `sheet` is the width the old danger-dialog rule spelled
// out. Enter stays here, through `Dialog`'s `onKeyDown`, because the confirm
// button is `disabled` while the removal runs and a disabled button is never
// clicked by the browser, so there is nothing else to answer the key. Escape
// does not: Kobalte reports it as `onClose`, and a second handler would cancel
// the same request twice.
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!props.busy) confirm();
  }

  return (
    <Dialog
      open
      size="sheet"
      title={`Remove branch “${props.branch}”?`}
      onClose={() => props.onCancel()}
      onKeyDown={onKeyDown}
      initialFocus={() => ok}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button ref={ok} variant="warn" disabled={props.busy} onClick={() => confirm()}>
            {props.busy ? "Removing…" : "Remove branch"}
          </Button>
        </>
      }
    >
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
        <div class={styles.warning}>This branch has commits not on its remote. Deleting it loses them.</div>
      </Show>

      <Checkbox
        class={styles.wtCheck}
        checked={deleteLocal()}
        onChange={setDeleteLocal}
        label="Delete local branch (git branch -D)"
      />

      <Show when={props.hasRemote}>
        <Checkbox
          class={styles.wtCheck}
          checked={deleteRemote()}
          onChange={setDeleteRemote}
          label="Delete remote branch (git push --delete)"
        />
      </Show>

      <Show when={!deleteLocal()}>
        <div class={styles.msg}>The branch stays in git; it is only removed from Tori’s list (detach).</div>
      </Show>
    </Dialog>
  );
}
