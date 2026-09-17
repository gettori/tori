import { createSignal, For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Checkbox from "../Checkbox/Checkbox";
import Dialog from "../Dialog/Dialog";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import { RiskTags, type MemberRisk } from "./ConfirmDeleteTopic";

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

/** A member the sweep can actually act on. Narrower than `MemberRisk` by the one
 *  field that matters here: a row with no worktree has nothing to offer, so the
 *  caller filters rather than every row asserting. */
export type SweepMember = MemberRisk & { worktreePath: string };

/** One row's answer. Only the rows being removed are handed back: a Keep row is
 *  the absence of an instruction, not an instruction. */
export type SweepChoice = {
  repoPath: string;
  worktreePath: string;
  deleteBranch: boolean;
};

type Answer = { remove: boolean; branch: boolean | null };

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
  // Held here rather than per row: the status fills in async, which replaces the
  // member objects, and a `<For>` keys on those. A row's own signal would reset
  // itself the moment git answered about it.
  const [answers, setAnswers] = createSignal<Record<string, Answer>>({});
  const at = (m: MemberRisk): Answer => answers()[m.repoPath] ?? { remove: false, branch: null };
  const set = (m: MemberRisk, next: Partial<Answer>) =>
    setAnswers((prev) => ({ ...prev, [m.repoPath]: { ...at(m), ...next } }));

  const clean = (m: MemberRisk) => m.dirty === false && m.unpushed === false;
  // Untouched means "whatever the evidence says", so a status that lands after
  // the dialog opened still moves the default; an explicit tick outranks it.
  const branchOn = (m: MemberRisk) => at(m).branch ?? clean(m);
  const removing = () => props.members.filter((m) => at(m).remove);

  const apply = () =>
    props.onApply(
      removing().map((m) => ({
        repoPath: m.repoPath,
        worktreePath: m.worktreePath,
        deleteBranch: branchOn(m),
      })),
    );

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
        A kept worktree stays on {props.branch} and shows up in Spaces as an ordinary branch of its
        repository. Nothing here is undone by closing this.
      </div>

      <div class={styles.delEntries}>
        <For each={props.members}>
          {(m) => (
            <div class={styles.sweepRow} data-sweep={m.repoPath}>
              <div class={styles.delEntry}>
                <span class={styles.delEntryName}>{m.label}</span>
                <RiskTags member={m} />
              </div>
              <Show when={props.running?.[m.repoPath]}>
                {(n) => (
                  <div class={styles.sweepRunning}>
                    {n()} terminal tab{n() === 1 ? "" : "s"} running here; removal stops {n() === 1 ? "it" : "them"}
                  </div>
                )}
              </Show>
              <div class={styles.sweepChoice}>
                <SegmentedControl
                  size="sm"
                  aria-label={`${m.label} worktree`}
                  value={at(m).remove ? "remove" : "keep"}
                  onChange={(v) => set(m, { remove: v === "remove" })}
                  options={[
                    { value: "keep", label: "Keep" },
                    { value: "remove", label: "Remove" },
                  ]}
                />
                <Checkbox
                  class={styles.wtCheck}
                  checked={branchOn(m)}
                  disabled={!at(m).remove}
                  onChange={(v) => set(m, { branch: v })}
                  label={`Delete ${props.branch}`}
                />
              </div>
              <Show when={props.failures?.[m.repoPath]}>
                {(why) => <div class={styles.sweepError}>{why()}</div>}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}
