import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

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
  busy: boolean;
  onConfirm: (deleteBranch: boolean) => void;
  onCancel: () => void;
}) {
  // Default on: the common case is discarding a finished/abandoned branch's worktree
  // and the branch with it. Only meaningful when the worktree actually has a branch.
  const [deleteBranch, setDeleteBranch] = createSignal(props.branch != null);
  let ok: HTMLButtonElement | undefined;

  onMount(() => requestAnimationFrame(() => ok?.focus()));

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!props.busy) props.onConfirm(deleteBranch());
    }
  }

  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={() => props.onCancel()}>
        <div
          class="modal modal-danger"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          <div class="modal-title">Remove worktree “{props.label}”?</div>

          <div class="wt-detail">
            <Show when={props.branch}>
              <div class="wt-detail-row">
                <span class="wt-detail-key">Branch</span>
                <span class="wt-detail-val">{props.branch}</span>
              </div>
            </Show>
            <div class="wt-detail-row">
              <span class="wt-detail-key">Folder</span>
              <span class="wt-detail-val" title={props.path}>{props.path}</span>
            </div>
            <div class="wt-detail-row">
              <span class="wt-detail-key">Status</span>
              <span class="wt-detail-tags">
                <Show when={props.dirty === null || props.unpushed === null}>
                  <span class="del-tag muted">checking…</span>
                </Show>
                <Show when={props.dirty}>
                  <span class="del-tag warn">uncommitted changes</span>
                </Show>
                <Show when={props.unpushed}>
                  <span class="del-tag warn">unpushed commits</span>
                </Show>
                <Show when={props.dirty === false && props.unpushed === false}>
                  <span class="del-tag muted">clean</span>
                </Show>
              </span>
            </div>
          </div>

          <Show when={props.dirty || props.unpushed}>
            <div class="modal-warn">
              This deletes work that is not saved anywhere else. It cannot be undone.
            </div>
          </Show>

          <Show when={props.branch}>
            <label class="wt-check">
              <input
                type="checkbox"
                checked={deleteBranch()}
                onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
              />
              <span>
                Also delete branch <strong>{props.branch}</strong> (git branch -D)
              </span>
            </label>
          </Show>

          <div class="modal-actions">
            <button class="modal-btn" onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button
              ref={ok}
              class="modal-btn danger"
              disabled={props.busy}
              onClick={() => props.onConfirm(deleteBranch())}
            >
              {props.busy ? "Removing…" : "Remove worktree"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
