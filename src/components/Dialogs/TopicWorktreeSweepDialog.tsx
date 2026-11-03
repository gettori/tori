import { For } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import { RiskTags, SweepControls, createSweep, type SweepChoice, type SweepMember } from "./ConfirmDeleteTopic";

// What happens to the worktrees a deleted Topic leaves behind, one row per
// repository. `WorktreeRemoveDialog` asks the same question for a single
// worktree; this is the N-row form, and the difference is not only the count.
//
// **The branch checkbox follows the evidence on its own row.** The single-
// worktree dialog defaults local-delete on, which is calibrated for one tree
// whose warning is in the same dialog and impossible to miss. Over N rows the
// warning belongs where the choice is made, so a row git calls clean arrives
// checked and a row with uncommitted or unpushed work arrives unchecked, with
// its tags beside it.

export type { SweepChoice, SweepMember } from "./ConfirmDeleteTopic";

export default function TopicWorktreeSweepDialog(props: {
  topicName: string;
  branch: string;
  /** Members that still have a worktree. One with none has nothing to sweep. */
  members: SweepMember[];
  busy?: boolean;
  /** Live shell/agent tabs under each worktree, by repo path, filling in async.
   *  Removal tears their PTYs down, which is the one consequence git has
   *  nothing to say about. */
  running?: Record<string, number>;
  /** Why a row's removal failed, by repo path. A failed row stays on screen. */
  failures?: Record<string, string>;
  onApply: (choices: SweepChoice[]) => void;
  onClose: () => void;
}) {
  const sweep = createSweep(() => props.members);
  const removing = sweep.removing;
  const apply = () => props.onApply(sweep.choices());

  return (
    <Dialog
      open
      size="sheet"
      title={`${props.topicName} is deleted. Its worktrees?`}
      onClose={() => props.onClose()}
      actions={
        <>
          <Button onClick={() => props.onClose()}>Keep all</Button>
          <Button variant="warn" disabled={props.busy || removing().length === 0} onClick={apply}>
            {props.busy ? "Removing…" : `Remove ${removing().length} worktree${removing().length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div class={styles.msg}>
        A kept worktree stays on its branch and shows up in Spaces as an ordinary branch of its repository. Nothing here
        is undone by closing this.
      </div>

      <div class={styles.delEntries}>
        <For each={props.members}>
          {(m) => (
            <div class={styles.sweepRow} data-sweep={m.repoPath}>
              <div class={styles.delEntry}>
                <span class={styles.delEntryName}>{m.label}</span>
                <RiskTags member={m} />
              </div>
              <SweepControls
                member={m}
                sweep={sweep}
                branch={props.branch}
                running={props.running?.[m.repoPath]}
                failure={props.failures?.[m.repoPath]}
              />
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}
