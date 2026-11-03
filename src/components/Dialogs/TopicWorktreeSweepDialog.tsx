import { createSignal } from "solid-js";
import { homeDir } from "@tauri-apps/api/path";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import { SweepTable, createSweep, sweepSummary, type SweepChoice, type SweepMember } from "./ConfirmDeleteTopic";

// The retry for worktrees a Topic's delete could not remove, in the same table
// the Delete Topic confirm draws, with git's reason on each row.

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
  const n = () => sweep.removing().length;
  const [home, setHome] = createSignal("");
  void homeDir()
    .then((h) => setHome(h.replace(/\/$/, "")))
    .catch(() => {});

  return (
    <Dialog
      open
      size="table"
      title={`${props.topicName} is deleted. Its worktrees?`}
      onClose={() => props.onClose()}
      actions={
        <>
          <span class={styles.sweepSummary}>{sweepSummary(sweep)}</span>
          <Button onClick={() => props.onClose()}>Keep all</Button>
          <Button variant="warn" disabled={props.busy || n() === 0} onClick={() => props.onApply(sweep.choices())}>
            {props.busy ? "Removing…" : `Remove ${n()} worktree${n() === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div class={styles.msg}>These could not be removed. Anything you leave unticked stays in its repository.</div>
      <SweepTable
        members={props.members}
        sweep={sweep}
        branch={props.branch}
        home={home()}
        running={props.running}
        failures={props.failures}
      />
    </Dialog>
  );
}
