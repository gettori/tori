import { createSignal, For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Checkbox from "../Checkbox/Checkbox";
import Dialog from "../Dialog/Dialog";

// The confirm for deleting a Topic, and what to do with each member's worktree
// in the same step. Not `ConfirmDeleteSpace`: there is no name to type. The
// record is reversible by making the Topic again over the same repos; a removed
// worktree is not, so that is chosen per row, and every row starts on Keep.
//
// What this owes the reader is the blast radius, which is why every member is
// listed with what git says about its worktree rather than a count.

/** One member as the delete flow shows it. `dirty` and `unpushed` are null while
 *  the status is in flight, and stay null for a member with no worktree to ask
 *  about. `state` is `memberState().label`, so a broken member still reads as
 *  one here rather than silently having nothing to say. */
export type MemberRisk = {
  repoPath: string;
  label: string;
  worktreePath: string | null;
  state: string;
  dirty: boolean | null;
  unpushed: boolean | null;
  /** A worktree moved in on its own branch: its branch is never offered. */
  keepsBranch?: boolean;
  /** The branch the worktree is on, as the sweep names it. */
  branch?: string | null;
};

/** The tags for one member: what is loading, what is at risk, or clean. Shared
 *  with the sweep, which shows the same evidence beside the choice it drives. */
export function RiskTags(props: { member: MemberRisk }) {
  return (
    <span class={styles.delEntryTags}>
      <Show
        when={props.member.worktreePath}
        fallback={<span class={`${styles.delTag} ${styles.muted}`}>{props.member.state}</span>}
      >
        <Show when={props.member.dirty === null || props.member.unpushed === null}>
          <span class={`${styles.delTag} ${styles.muted}`}>checking…</span>
        </Show>
        <Show when={props.member.dirty}>
          <span class={`${styles.delTag} ${styles.warn}`}>uncommitted changes</span>
        </Show>
        <Show when={props.member.unpushed}>
          <span class={`${styles.delTag} ${styles.warn}`}>unpushed commits</span>
        </Show>
        <Show when={props.member.dirty === false && props.member.unpushed === false}>
          <span class={`${styles.delTag} ${styles.muted}`}>clean</span>
        </Show>
      </Show>
    </span>
  );
}

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

/** The Keep or Remove answer for each worktree row, shared by the Delete Topic
 *  confirm and the retry sweep. Held by repo path rather than per row: the
 *  status fills in async, which replaces the member objects, and a `<For>` keys
 *  on those, so a row's own signal would reset itself the moment git answered. */
export function createSweep(members: () => readonly MemberRisk[]) {
  const [answers, setAnswers] = createSignal<Record<string, Answer>>({});
  const at = (m: MemberRisk): Answer => answers()[m.repoPath] ?? { remove: false, branch: null };
  const set = (m: MemberRisk, next: Partial<Answer>) =>
    setAnswers((prev) => ({ ...prev, [m.repoPath]: { ...at(m), ...next } }));
  const clean = (m: MemberRisk) => m.dirty === false && m.unpushed === false;
  // Untouched means "whatever the evidence says", so a status that lands after
  // the dialog opened still moves the default; an explicit tick outranks it.
  const branchOn = (m: MemberRisk) => !m.keepsBranch && (at(m).branch ?? clean(m));
  const removing = () => members().filter((m): m is SweepMember => !!m.worktreePath && at(m).remove);
  const choices = (): SweepChoice[] =>
    removing().map((m) => ({ repoPath: m.repoPath, worktreePath: m.worktreePath, deleteBranch: branchOn(m) }));
  return { at, set, branchOn, removing, choices };
}

/** One worktree's controls under its row: whether to remove it, and only then
 *  whether its branch goes too, with what is running there and why a removal
 *  failed. */
export function SweepControls(props: {
  member: MemberRisk;
  sweep: ReturnType<typeof createSweep>;
  branch: string;
  running?: number;
  failure?: string;
}) {
  const m = () => props.member;
  const removing = () => props.sweep.at(m()).remove;
  return (
    <div class={styles.sweepChoice}>
      <Checkbox
        class={styles.wtCheck}
        checked={removing()}
        onChange={(v) => props.sweep.set(m(), { remove: v })}
        label={`Remove worktree ${m().worktreePath?.split("/").pop() ?? ""}`.trim()}
      />
      <div class={styles.sweepNested}>
        {/* A worktree moved in keeps a branch Tori never made. */}
        <Show when={removing() && !m().keepsBranch}>
          <Checkbox
            class={styles.wtCheck}
            checked={props.sweep.branchOn(m())}
            onChange={(v) => props.sweep.set(m(), { branch: v })}
            label={`Also delete branch ${m().branch ?? props.branch}`}
          />
        </Show>
        <Show when={props.running}>
          {(n) => (
            <div class={styles.sweepRunning}>
              {n()} terminal tab{n() === 1 ? "" : "s"} running here; removal stops {n() === 1 ? "it" : "them"}
            </div>
          )}
        </Show>
        <Show when={props.failure}>{(why) => <div class={styles.sweepError}>{why()}</div>}</Show>
      </div>
    </div>
  );
}

export default function ConfirmDeleteTopic(props: {
  topicName: string;
  branch: string;
  members: MemberRisk[];
  /** Live shell/agent tabs under each worktree, by repo path, filling in async. */
  running?: Record<string, number>;
  busy?: boolean;
  onConfirm: (choices: SweepChoice[]) => void;
  onCancel: () => void;
}) {
  let ok: HTMLButtonElement | undefined;
  const sweep = createSweep(() => props.members);
  const n = () => sweep.removing().length;

  return (
    <Dialog
      open
      size="sheet"
      title={`Delete ${props.topicName}?`}
      onClose={() => props.onCancel()}
      initialFocus={() => ok}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button ref={ok} variant="danger" disabled={props.busy} onClick={() => props.onConfirm(sweep.choices())}>
            {props.busy
              ? "Deleting…"
              : n()
                ? `Delete Topic and ${n()} worktree${n() === 1 ? "" : "s"}`
                : "Delete Topic"}
          </Button>
        </>
      }
    >
      <div class={styles.msg}>
        This deletes the Topic record. A worktree you leave unticked stays on its branch and shows up in Spaces as an
        ordinary branch of its repository.
      </div>

      <div class={styles.delEntries}>
        <For each={props.members}>
          {(m) => (
            <div class={styles.sweepRow} data-member={m.repoPath}>
              <div class={styles.delEntry}>
                <span class={styles.delEntryName}>{m.label}</span>
                <RiskTags member={m} />
              </div>
              <Show when={m.worktreePath}>
                <SweepControls member={m} sweep={sweep} branch={props.branch} running={props.running?.[m.repoPath]} />
              </Show>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}
