// Landing a pull request: the server's verdict, the three ways to merge, and
// what to do with the branch afterwards.
//
// **Every control here is gated on `mergeableState`, which is asked, not
// worked out.** Branch protection, required reviewers and required checks are
// invisible from this side, so a verdict derived locally would render an enabled
// button the server refuses, and the user would learn it will not merge only
// after asking it to. `mergeGate.ts` is that translation and nothing more.
//
// The **method picker offers all three** and lets the server refuse. A repo can
// forbid squash or rebase, and that setting is not readable from here; hiding a
// method on a guess would remove the one the user's repo actually requires.
//
// **Deleting the branch is handed to the sidebar**, not done here. The removal
// dialogs there already guard a dirty worktree, unpushed work and running
// agents, and a second delete path in this panel would be a second place for
// those guards to be forgotten.

import { For, Show, createSignal } from "solid-js";
import { mergeGate } from "../../../utils/mergeGate";
import { MERGE_METHODS, type MergeMethod, type MergeableState } from "../../../utils/forgeTypes";
import Button from "../../../components/Button/Button";
import styles from "./MergeBar.module.css";

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export default function MergeBar(props: {
  /** null until the verdict has been read, which is not the same as `unknown`:
   *  one means nobody has asked, the other that GitHub has not decided. */
  state: MergeableState | null;
  busy: boolean;
  /** The server's own sentence from a refused merge or update, which is the only
   *  place the specifics of a branch-protection rule ever appear. */
  error: string | null;
  /** Set once this pull request has been landed from here. */
  merged: boolean;
  /** Absent when no branch-unit in this project carries the head, so there is
   *  nothing local to delete. */
  onDeleteBranch?: () => void;
  onMerge: (method: MergeMethod) => void;
  onUpdateBranch: () => void;
}) {
  const [method, setMethod] = createSignal<MergeMethod>("squash");
  const gate = () => mergeGate(props.state ?? "unknown");

  return (
    <div class={styles.bar} data-merge-state={props.state ?? "unread"}>
      <Show
        when={!props.merged}
        fallback={
          <div class={styles.done}>
            <span class={styles.summary} data-merge-summary>
              Merged.
            </span>
            <Show when={props.onDeleteBranch}>
              <Button variant="ghost" onClick={() => props.onDeleteBranch!()}>
                Delete branch…
              </Button>
            </Show>
          </div>
        }
      >
        <div class={styles.row}>
          <span class={styles.summary} data-merge-summary>
            {props.state === null ? "Checking whether this can merge…" : gate().summary}
          </span>

          <Show when={gate().canUpdate}>
            <Button variant="ghost" disabled={props.busy} onClick={() => props.onUpdateBranch()}>
              Update branch
            </Button>
          </Show>

          <select
            class={styles.method}
            aria-label="How to merge"
            value={method()}
            disabled={props.busy}
            onChange={(e) => setMethod(e.currentTarget.value as MergeMethod)}
          >
            <For each={MERGE_METHODS}>
              {(m) => <option value={m}>{METHOD_LABEL[m]}</option>}
            </For>
          </select>

          {/* An unread verdict falls through `gate()` to `unknown`, which
              blocks. That is the same answer for the same reason: nothing has
              said this can merge, so nothing here may offer to. */}
          <Button disabled={props.busy || gate().block} onClick={() => props.onMerge(method())}>
            Merge
          </Button>
        </div>
      </Show>

      {/* The server's refusal, verbatim. GitHub knows about rules Sway cannot
          read, so its wording is the only thing here that can name one. */}
      <Show when={props.error}>
        <div class={styles.error} data-merge-error>
          {props.error}
        </div>
      </Show>
    </div>
  );
}
