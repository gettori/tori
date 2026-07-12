import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

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
      <div class="modal-backdrop" onMouseDown={() => props.onCancel()}>
        <div class="modal modal-danger" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class="modal-title">Remove branch “{props.branch}”?</div>

          <div class="wt-detail">
            <div class="wt-detail-row">
              <span class="wt-detail-key">Branch</span>
              <span class="wt-detail-val">{props.branch}</span>
            </div>
            <div class="wt-detail-row">
              <span class="wt-detail-key">Status</span>
              <span class="wt-detail-tags">
                <Show when={props.unpushed === null}>
                  <span class="del-tag muted">checking…</span>
                </Show>
                <Show when={props.unpushed}>
                  <span class="del-tag warn">unpushed commits</span>
                </Show>
                <Show when={props.unpushed === false}>
                  <span class="del-tag muted">pushed</span>
                </Show>
              </span>
            </div>
          </div>

          <Show when={props.unpushed}>
            <div class="modal-warn">
              This branch has commits not on its remote. Deleting it loses them.
            </div>
          </Show>

          <label class="wt-check">
            <input
              type="checkbox"
              checked={deleteLocal()}
              onChange={(e) => setDeleteLocal(e.currentTarget.checked)}
            />
            <span>Delete local branch (git branch -D)</span>
          </label>

          <Show when={props.hasRemote}>
            <label class="wt-check">
              <input
                type="checkbox"
                checked={deleteRemote()}
                onChange={(e) => setDeleteRemote(e.currentTarget.checked)}
              />
              <span>Delete remote branch (git push --delete)</span>
            </label>
          </Show>

          <div class="modal-msg">
            {deleteLocal()
              ? "The local branch is deleted from git."
              : "The branch stays in git; it is only removed from Sway’s list (detach)."}
          </div>

          <div class="modal-actions">
            <button class="modal-btn" onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button ref={ok} class="modal-btn warn" disabled={props.busy} onClick={() => confirm()}>
              {props.busy ? "Removing…" : "Remove branch"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
