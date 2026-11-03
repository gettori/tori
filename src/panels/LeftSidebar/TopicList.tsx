import { Show, onCleanup, type JSX } from "solid-js";
import { type SpaceTint } from "./TopicItem";
import TopicRows, { type TopicFold } from "./TopicRows";
import { TriangleAlert } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import NewTopicDialog from "../../components/Dialogs/NewTopicDialog";
import PromptModal from "../../components/Dialogs/PromptModal";
import MoveTopicDialog from "../../components/Dialogs/MoveTopicDialog";
import ConfirmDeleteTopic from "../../components/Dialogs/ConfirmDeleteTopic";
import TopicWorktreeSweepDialog from "../../components/Dialogs/TopicWorktreeSweepDialog";
import WorktreeRemoveDialog from "../../components/Dialogs/WorktreeRemoveDialog";
import type { RepoSpace } from "../../components/Dialogs/RepoChecklist";
import { type Topic } from "../../utils/topics";
import { topics, topicsError, watchTopics } from "../../utils/topicStore";
import type { Rollup } from "../../utils/sessionStatus";
import type { DialogReq, TopicActions } from "./topicActions";
import styles from "./TopicList.module.css";

const dialogScope = (req: DialogReq) =>
  "topic" in req ? { topic: req.topic, space: req.topic.space } : { space: req.space };

function GoneSpaceNote(props: { topic: Topic; actions: TopicActions }) {
  return (
    <div class={styles.goneNote}>
      <Icon icon={TriangleAlert} class={styles.goneIcon} />
      <div class={styles.goneBody}>
        <p>
          From <strong>{props.topic.space}</strong>, which Tori can't find. Its folder was renamed or deleted outside
          Tori.
        </p>
        <div class={styles.goneActions}>
          <Button size="sm" onClick={() => props.actions.keepInGlobal(props.topic)}>
            Keep in Home
          </Button>
          <Button size="sm" variant="danger" onClick={() => props.actions.openDelete(props.topic)}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

export type TopicListing = "listed" | "gone" | null;

/** What the list needs from a Space: the tint for a chip and the projects for
 *  the creation checklist. The sidebar's own `Space` satisfies it as is. */
export type TopicSpace = SpaceTint & RepoSpace;

export default function TopicList(props: {
  spaces: TopicSpace[];
  targets?: TopicSpace[];
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
  /** Whether a Topic lists here, and whether it is here only because Tori no
   *  longer finds its space. Absent lists every Topic. */
  listing?: (topic: Topic) => TopicListing;
  actions: TopicActions;
  fold?: TopicFold;
  lead?: JSX.Element;
  onContextMenu?: (e: MouseEvent) => void;
  head?: JSX.Element;
  collapsed?: boolean;
  tail?: JSX.Element;
  empty?: JSX.Element;
}) {
  onCleanup(watchTopics());
  const actions = props.actions;
  const {
    dialog,
    setDialog,
    renameReq,
    setRenameReq,
    moveReq,
    setMoveReq,
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
  const listed = () => (props.listing ? topics().filter((t) => props.listing!(t)) : topics());

  return (
    <div
      class={styles.list}
      classList={{ [props.class ?? ""]: !!props.class }}
      hidden={props.hidden}
      onContextMenu={(e) => props.onContextMenu?.(e)}
      data-topic-list
    >
      <Show when={error()}>{(msg) => <p class={styles.error}>{msg()}</p>}</Show>
      {props.lead}
      <Show when={listed().length > 0} fallback={props.empty}>
        {props.head}
        <Show when={!props.collapsed}>
          <TopicRows
            topics={listed()}
            query={props.query}
            spaces={props.spaces}
            actions={actions}
            activeId={props.activeId}
            activeRoot={props.activeRoot}
            onOpenMember={props.onOpenMember}
            topicStatus={props.topicStatus}
            fold={props.fold}
            note={(t) => (
              <Show when={props.listing?.(t) === "gone"}>
                <GoneSpaceNote topic={t} actions={actions} />
              </Show>
            )}
            fallback={
              <div class="tree-empty">
                <p>No Topic matches the filter.</p>
              </div>
            }
          />
        </Show>
      </Show>
      {props.tail}

      <Show when={dialog()}>
        {(req) => (
          <NewTopicDialog
            spaces={props.spaces}
            topics={topics()}
            {...dialogScope(req())}
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

      <Show when={moveReq()}>
        {(f) => (
          <MoveTopicDialog
            topic={topics().find((t) => t.id === f().id) ?? f()}
            spaces={props.targets ?? props.spaces}
            homes={props.spaces}
            onDone={actions.moved}
            onCancel={() => setMoveReq(null)}
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
            running={req().running}
            busy={req().busy}
            onConfirm={(choices) => void actions.remove(req().topic, req().members, choices)}
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
