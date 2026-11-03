import { createSignal, For, Show } from "solid-js";
import { homeDir } from "@tauri-apps/api/path";
import { GitBranch } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Checkbox from "../Checkbox/Checkbox";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";

// The confirm for deleting a Topic, and what to do with each member's worktree
// and branch in the same step. Not `ConfirmDeleteSpace`: there is no name to
// type. The record is reversible by making the Topic again over the same repos;
// a removed worktree or branch is not, so each is ticked per row, and a row
// starts ticked only when git says nothing on it would be lost.
//
// What this owes the reader is the blast radius, which is why every member is
// listed with what git says about it rather than a count.

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
  /** The branch the row is on: the worktree's, or a reference's checkout. */
  branch?: string | null;
  /** A reference reads the repository's own checkout; there is nothing of the
   *  Topic's to remove. */
  reference?: boolean;
  /** Its pull request merged, so the branch's work is on the base already. */
  merged?: boolean;
};

/** A member the sweep can actually act on. Narrower than `MemberRisk` by the one
 *  field that matters here: a row with no worktree has nothing to offer, so the
 *  caller filters rather than every row asserting. */
export type SweepMember = MemberRisk & { worktreePath: string };

/** One row's answer. Only the rows being removed are handed back: a kept row is
 *  the absence of an instruction, not an instruction. */
export type SweepChoice = {
  repoPath: string;
  worktreePath: string;
  deleteBranch: boolean;
};

type Answer = { remove: boolean | null; branch: boolean | null };

/** The worktree and branch answer for each row, shared by the Delete Topic
 *  confirm and the retry. Held by repo path rather than per row: the status
 *  fills in async, which replaces the member objects, and a `<For>` keys on
 *  those, so a row's own signal would reset itself the moment git answered.
 *  Untouched follows the evidence, so a status landing after the dialog opened
 *  still moves the default; an explicit tick outranks it. */
export function createSweep(members: () => readonly MemberRisk[]) {
  const [answers, setAnswers] = createSignal<Record<string, Answer>>({});
  const at = (m: MemberRisk): Answer => answers()[m.repoPath] ?? { remove: null, branch: null };
  const set = (m: MemberRisk, next: Partial<Answer>) =>
    setAnswers((prev) => ({ ...prev, [m.repoPath]: { ...at(m), ...next } }));
  const safe = (m: MemberRisk) => !!m.merged || (m.dirty === false && m.unpushed === false);
  const removes = (m: MemberRisk) => !!m.worktreePath && (at(m).remove ?? safe(m));
  // A branch checked out in a worktree cannot be deleted, so it goes only with
  // its worktree.
  const branchOn = (m: MemberRisk) => removes(m) && !m.keepsBranch && (at(m).branch ?? safe(m));
  const removing = () => members().filter((m): m is SweepMember => removes(m));
  const choices = (): SweepChoice[] =>
    removing().map((m) => ({ repoPath: m.repoPath, worktreePath: m.worktreePath, deleteBranch: branchOn(m) }));
  return { at, set, removes, branchOn, removing, choices };
}

/** "Removes 2 worktrees and 1 branch", for the foot of the dialog. */
export function sweepSummary(sweep: ReturnType<typeof createSweep>): string {
  const n = sweep.removing().length;
  const b = sweep.removing().filter(sweep.branchOn).length;
  if (!n) return "Keeps every worktree and branch";
  const trees = `${n} worktree${n === 1 ? "" : "s"}`;
  return b ? `Removes ${trees} and ${b} branch${b === 1 ? "" : "es"}` : `Removes ${trees}`;
}

function MemberTag(props: { member: MemberRisk }) {
  const m = () => props.member;
  return (
    <Show
      when={m().worktreePath}
      fallback={<span class={`${styles.delTag} ${styles.muted}`}>{m().reference ? "main checkout" : m().state}</span>}
    >
      <Show when={!m().merged} fallback={<span class={`${styles.delTag} ${styles.good}`}>merged</span>}>
        <Show when={m().dirty === null || m().unpushed === null}>
          <span class={`${styles.delTag} ${styles.muted}`}>checking…</span>
        </Show>
        <Show when={m().dirty}>
          <span class={`${styles.delTag} ${styles.warn}`}>uncommitted</span>
        </Show>
        <Show when={m().unpushed}>
          <span class={`${styles.delTag} ${styles.attention}`}>unpushed</span>
        </Show>
        <Show when={m().dirty === false && m().unpushed === false}>
          <span class={`${styles.delTag} ${styles.muted}`}>clean</span>
        </Show>
      </Show>
    </Show>
  );
}

/** Every member as one row of Repository, Worktree and Branch, with what a tick
 *  would lose spelled out under it. */
export function SweepTable(props: {
  members: readonly MemberRisk[];
  sweep: ReturnType<typeof createSweep>;
  /** The Topic's branch, for a row that names none of its own. */
  branch: string;
  /** The home folder, folded to `~` in the paths. */
  home: string;
  /** Live shell/agent tabs under each worktree, by repo path. */
  running?: Record<string, number>;
  /** Why a row's removal failed, by repo path. */
  failures?: Record<string, string>;
}) {
  const fold = (path: string) =>
    props.home && path.startsWith(props.home) ? `~${path.slice(props.home.length)}` : path;
  return (
    <div class={styles.sweepTable} role="table" aria-label="Worktrees and branches">
      <div class={styles.sweepHead} role="row">
        <span role="columnheader">Repository</span>
        <span role="columnheader">Worktree</span>
        <span role="columnheader">Branch</span>
      </div>
      <For each={props.members}>
        {(m) => {
          const branch = () => m.branch ?? props.branch;
          const running = () => props.running?.[m.repoPath] ?? 0;
          return (
            <div class={styles.sweepRow} role="row" data-member={m.repoPath}>
              <div class={styles.sweepWho} role="cell">
                <div class={styles.sweepName}>
                  <span>{m.label}</span>
                  <MemberTag member={m} />
                </div>
                <Show when={branch()}>
                  <div class={styles.sweepBranch}>
                    <Icon icon={GitBranch} />
                    {branch()}
                  </div>
                </Show>
                <div class={styles.sweepPath}>{fold(m.worktreePath ?? m.repoPath)}</div>
              </div>
              <Show
                when={m.worktreePath}
                fallback={
                  <div class={styles.sweepNone} role="cell">
                    {m.reference ? "Not a worktree" : "No worktree"}
                  </div>
                }
              >
                <div class={styles.sweepCell} role="cell">
                  <Checkbox
                    checked={props.sweep.removes(m)}
                    onChange={(v) => props.sweep.set(m, { remove: v })}
                    aria-label={`Remove ${m.label} worktree`}
                  />
                </div>
                <div class={styles.sweepCell} role="cell">
                  {/* A worktree moved in keeps a branch Tori never made. */}
                  <Show when={!m.keepsBranch} fallback={<span class={styles.sweepDash}>Kept</span>}>
                    <Checkbox
                      checked={props.sweep.branchOn(m)}
                      disabled={!props.sweep.removes(m)}
                      onChange={(v) => props.sweep.set(m, { branch: v })}
                      aria-label={`Delete branch ${branch()}`}
                    />
                  </Show>
                </div>
              </Show>
              <Show when={props.sweep.removes(m) && m.dirty}>
                <div class={styles.sweepLoss}>Uncommitted changes in this worktree will be lost.</div>
              </Show>
              <Show when={props.sweep.branchOn(m) && m.unpushed && !m.merged}>
                <div class={styles.sweepLoss}>Commits on {branch()} aren't pushed and will be lost.</div>
              </Show>
              <Show when={props.sweep.removes(m) && running()}>
                <div class={styles.sweepNote}>
                  {running()} terminal tab{running() === 1 ? "" : "s"} running here will stop.
                </div>
              </Show>
              <Show when={props.failures?.[m.repoPath]}>{(why) => <div class={styles.sweepLoss}>{why()}</div>}</Show>
            </div>
          );
        }}
      </For>
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
  let cancel: HTMLButtonElement | undefined;
  const sweep = createSweep(() => props.members);
  const [home, setHome] = createSignal("");
  void homeDir()
    .then((h) => setHome(h.replace(/\/$/, "")))
    .catch(() => {});

  return (
    <Dialog
      open
      size="table"
      title={`Delete \u201C${props.topicName}\u201D?`}
      onClose={() => props.onCancel()}
      initialFocus={() => cancel}
      actions={
        <>
          <span class={styles.sweepSummary}>{sweepSummary(sweep)}</span>
          <Button ref={cancel} onClick={() => props.onCancel()}>
            Cancel
          </Button>
          <Button variant="danger" disabled={props.busy} onClick={() => props.onConfirm(sweep.choices())}>
            {props.busy ? "Deleting…" : "Delete Topic"}
          </Button>
        </>
      }
    >
      <div class={styles.msg}>
        The Topic is deleted. Anything you leave unticked stays in its repository and shows up in Spaces.
      </div>
      <SweepTable members={props.members} sweep={sweep} branch={props.branch} home={home()} running={props.running} />
    </Dialog>
  );
}
