import { For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// The confirm for deleting a Topic. Not `ConfirmDeleteSpace`: nothing here is
// permanent yet, so there is no name to type. Deleting the record is reversible
// by making the Topic again over the same repos; what is not reversible is the
// worktree sweep that follows, and that dialog asks per row.
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

export default function ConfirmDeleteTopic(props: {
  topicName: string;
  branch: string;
  members: MemberRisk[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  let ok: HTMLButtonElement | undefined;

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
          <Button ref={ok} variant="danger" onClick={() => props.onConfirm()}>
            Delete Topic
          </Button>
        </>
      }
    >
      <div class={styles.msg}>
        This deletes the Topic record. {props.branch} stays checked out in every repository, and what happens to each
        worktree is asked next, one row at a time.
      </div>

      <div class={styles.delEntries}>
        <For each={props.members}>
          {(m) => (
            <div class={styles.delEntry} data-member={m.repoPath}>
              <span class={styles.delEntryName}>{m.label}</span>
              <RiskTags member={m} />
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}
