import { Show, onCleanup } from "solid-js";
import { type SpaceTint } from "./TopicItem";
import TopicRows from "./TopicRows";
import Button from "../../components/Button/Button";
import NewTopicDialog from "../../components/Dialogs/NewTopicDialog";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDeleteTopic from "../../components/Dialogs/ConfirmDeleteTopic";
import TopicWorktreeSweepDialog from "../../components/Dialogs/TopicWorktreeSweepDialog";
import WorktreeRemoveDialog from "../../components/Dialogs/WorktreeRemoveDialog";
import type { RepoSpace } from "../../components/Dialogs/RepoChecklist";
import { type Topic } from "../../utils/topics";
import { topics, topicsError, watchTopics } from "../../utils/topicStore";
import type { Rollup } from "../../utils/sessionStatus";
import type { TopicActions } from "./topicActions";
import styles from "./TopicList.module.css";

/** What the list needs from a Space: the tint for a chip and the projects for
 *  the creation checklist. The sidebar's own `Space` satisfies it as is. */
export type TopicSpace = SpaceTint & RepoSpace;

/** The sidebar's Topics mode: every Topic as a row, the dialogs that make or
 *  change one, and the toast for a creation that left a member failed. */
export default function TopicList(props: {
  spaces: TopicSpace[];
  query: string;
  class?: string;
  hidden?: boolean;
  /** The selected Topic's id, so exactly one row reads as active. */
  activeId?: string | null;
  /** The member root the selected Topic is showing, so one member row reads as open. */
  activeRoot?: string | null;
  /** Open a Topic on one of its members. */
  onOpenMember?: (topic: Topic, root: string) => void;
  topicStatus?: (topic: Topic) => Rollup | null;
  actions: TopicActions;
}) {
  onCleanup(watchTopics());
  const actions = props.actions;
  const {
    dialog,
    setDialog,
    renameReq,
    setRenameReq,
    memberRenameReq,
    setMemberRenameReq,
    wtReq,
    setWtReq,
    deleteReq,
    setDeleteReq,
    sweepReq,
    setSweepReq,
  } = actions;
  const error = () => actions.error() ?? topicsError();

  return (
    <div class={styles.list} classList={{ [props.class ?? ""]: !!props.class }} hidden={props.hidden} data-topic-list>
      <Show when={error()}>{(msg) => <p class={styles.error}>{msg()}</p>}</Show>
      <TopicRows
        topics={topics()}
        query={props.query}
        spaces={props.spaces}
        actions={actions}
        activeId={props.activeId}
        activeRoot={props.activeRoot}
        onOpenMember={props.onOpenMember}
        topicStatus={props.topicStatus}
        fallback={
          <div class="tree-empty">
            <Show when={topics().length === 0} fallback={<p>No Topic matches the filter.</p>}>
              <p>No Topics yet.</p>
              <Button size="sm" variant="ghost" onClick={() => setDialog({})}>
                Create a Topic
              </Button>
            </Show>
          </div>
        }
      />

      <Show when={dialog()}>
        {(req) => (
          <NewTopicDialog
            spaces={props.spaces}
            topics={topics()}
            topic={req().topic}
            onDone={actions.settled}
            onCancel={() => setDialog(null)}
          />
        )}
      </Show>

      <Show when={renameReq()}>
        {(f) => (
          <PromptModal
            title={`Rename ${f().name}`}
            initial={f().name}
            note={`${f().branch} stays as it is; only the name shown here changes.`}
            okLabel="Rename"
            onSubmit={(v) => void actions.rename(f(), v)}
            onCancel={() => setRenameReq(null)}
          />
        )}
      </Show>

      <Show when={memberRenameReq()}>
        {(req) => (
          <PromptModal
            title={`Rename ${req().member.displayName}`}
            initial={req().member.displayName}
            note="The repository and its worktree stay as they are; only the name shown here changes."
            okLabel="Rename"
            onSubmit={(v) => void actions.renameMember(req().topic, req().member, v)}
            onCancel={() => setMemberRenameReq(null)}
          />
        )}
      </Show>

      <Show when={wtReq()}>
        {(req) => (
          <WorktreeRemoveDialog
            label={req().member.displayName}
            path={req().worktreePath}
            // Remove worktree keeps the branch, so there is no branch to offer
            // deleting, and unpushed commits stay on it rather than being lost.
            branch={req().demote || req().member.keepsBranch ? null : req().topic.branch}
            dirty={req().dirty}
            unpushed={req().demote ? false : req().unpushed}
            hasRemote={req().demote ? false : req().hasRemote}
            runningCount={req().runningCount}
            busy={req().busy}
            keepLabel={req().demote ? undefined : "Keep worktree"}
            onConfirm={(opts) => void actions.confirmRemoveWorktree(opts)}
            onCancel={() => setWtReq(null)}
          />
        )}
      </Show>

      <Show when={deleteReq()}>
        {(req) => (
          <ConfirmDeleteTopic
            topicName={req().topic.name}
            branch={req().topic.branch}
            members={req().members}
            onConfirm={() => void actions.remove(req().topic, req().members)}
            onCancel={() => setDeleteReq(null)}
          />
        )}
      </Show>

      <Show when={sweepReq()}>
        {(req) => (
          <TopicWorktreeSweepDialog
            topicName={req().topic.name}
            branch={req().topic.branch}
            members={req().members}
            busy={req().busy}
            failures={req().failures}
            running={req().running}
            onApply={(choices) => void actions.sweep(choices)}
            onClose={() => setSweepReq(null)}
          />
        )}
      </Show>
    </div>
  );
}
