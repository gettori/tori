import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Select from "../Select/Select";
import { samePath } from "../../panels/LeftSidebar/attempts";
import { byName, isReference, type Topic } from "../../utils/topics";

const TOPIC_LABEL = "move-topic-label";

/** Take a worktree the user already has into a Topic, on the branch it is on.
 *  Nothing in git changes. What the backend would refuse is said before the
 *  click: a worktree it cannot take at all (`check_moved_worktree`) blocks the
 *  dialog, a Topic already holding the repo with a worktree blocks that Topic. */
export default function MoveToTopicDialog(props: {
  repoPath: string;
  worktreePath: string;
  /** The worktree as its Spaces row names it. */
  label: string;
  topics: Topic[];
  onDone: (topic: Topic) => void;
  onCancel: () => void;
}) {
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const [checked, setChecked] = createSignal(false);
  const [topicId, setTopicId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    invoke<string | null>("check_moved_worktree", { repoPath: props.repoPath, worktreePath: props.worktreePath })
      .then((why) => setRefusal(why ?? null))
      // A check that cannot answer must not block: `add_member` runs the same
      // check and its refusal lands in the error line.
      .catch(() => setRefusal(null))
      .finally(() => setChecked(true));
  });

  const sorted = () => [...props.topics].sort(byName);
  const picked = () => props.topics.find((t) => t.id === topicId());
  const existing = () => picked()?.members.find((m) => samePath(m.repoPath, props.repoPath));
  const taken = () => {
    const t = picked();
    const m = existing();
    return t && m && !isReference(m) ? `${m.displayName} is already in ${t.name} with a worktree` : null;
  };
  const canMove = () => checked() && !refusal() && !busy() && !!picked() && !taken();

  async function move() {
    const t = picked();
    if (!t || !canMove()) return;
    setBusy(true);
    setError(null);
    try {
      props.onDone(
        await invoke<Topic>("add_member", {
          topicId: t.id,
          repoPath: props.repoPath,
          worktreePath: props.worktreePath,
        }),
      );
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={`Move ${props.label} to a Topic`}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!canMove()} onClick={() => void move()}>
            {busy() ? "Working…" : "Move to Topic"}
          </Button>
        </>
      }
    >
      <Show when={error() ?? refusal()}>
        {(msg) => (
          <div class={styles.warning} role="alert">
            {msg()}
          </div>
        )}
      </Show>
      <Show when={!refusal()}>
        <Show when={props.topics.length > 0} fallback={<div class={styles.msg}>No Topics yet.</div>}>
          <div>
            <div id={TOPIC_LABEL} class={styles.label}>
              Topic
            </div>
            <Select
              options={sorted().map((t) => ({ value: t.id, label: t.name }))}
              value={topicId()}
              placeholder="Pick a Topic"
              onChange={setTopicId}
              aria-labelledby={TOPIC_LABEL}
            />
            <Show when={taken()}>{(why) => <div class={styles.hint}>{why()}</div>}</Show>
            <Show when={!taken() && existing()}>
              {(m) => <div class={styles.hint}>Replaces the reference to {m().displayName}</div>}
            </Show>
          </div>
          <div class={styles.msg}>
            The worktree keeps its branch and its changes. Nothing in git changes, and it stays in Spaces.
          </div>
        </Show>
      </Show>
    </Dialog>
  );
}
