import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Search, Tag } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import MemberChip from "../MemberChip/MemberChip";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import SpaceMark from "../SpaceMark/SpaceMark";
import NewTopicDialog from "./NewTopicDialog";
import type { RepoSpace } from "./RepoChecklist";
import { samePath } from "../../panels/LeftSidebar/attempts";
import { matchesTopic } from "../../panels/LeftSidebar/TopicRows";
import { chatsInFolder } from "../../utils/chatSessions";
import { tintedMembers, type SpaceTint } from "../../utils/topicMembers";
import { byName, inSpace, isReference, listsInTopics, type Topic } from "../../utils/topics";

const PICK_NAME = "move-topic-pick";

type Tab = "existing" | "new";
const TABS = [
  { value: "existing" as const, label: "Existing" },
  { value: "new" as const, label: "New" },
];
type Where = "space" | "global";

/** Take a worktree the user already has into a Topic, on the branch it is on:
 *  an existing one, or a new one started from it (`NewTopicDialog` with the
 *  worktree pinned). Nothing in git changes. What the backend would refuse is
 *  said before the click: a worktree it cannot take at all
 *  (`check_moved_worktree`) blocks both tabs, a Topic already holding the repo
 *  with a worktree blocks that Topic. */
export default function MoveToTopicDialog(props: {
  repoPath: string;
  worktreePath: string;
  /** The worktree as its Spaces row names it. */
  label: string;
  branch: string | null;
  space: string;
  topics: Topic[];
  spaces: (RepoSpace & SpaceTint)[];
  onDone: (topic: Topic) => void;
  onCancel: () => void;
}) {
  const own = () => props.topics.filter((t) => inSpace(t, props.space)).sort(byName);
  const global = () =>
    props.topics
      .filter((t) =>
        listsInTopics(
          t,
          props.spaces.map((g) => g.name),
        ),
      )
      .sort(byName);
  const offered = () => [...own(), ...global()];

  const [tab, setTab] = createSignal<Tab>(offered().length > 0 ? "existing" : "new");
  const [where, setWhere] = createSignal<Where>("space");
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const [checked, setChecked] = createSignal(false);
  const [topicId, setTopicId] = createSignal("");
  const [query, setQuery] = createSignal("");
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

  const scope = () => props.spaces.find((g) => g.name === props.space);
  const groups = () =>
    [
      { label: `In ${props.space}`, topics: own() },
      { label: "Topics", topics: global() },
    ]
      .map((g) => ({ ...g, topics: g.topics.filter((t) => matchesTopic(t, query())) }))
      .filter((g) => g.topics.length > 0);

  const picked = () => offered().find((t) => t.id === topicId());
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

  const tabs = () => <SegmentedControl aria-label="Move to" options={TABS} value={tab()} onChange={setTab} />;

  // A started chat keeps the roots it launched with, so it never sees the
  // Topic's other members.
  const chatNote = () => {
    const n = chatsInFolder(props.worktreePath).length;
    if (!n) return null;
    return n === 1
      ? "1 chat here moves with it and keeps working in this repo only. New chats in the Topic see every repo."
      : `${n} chats here move with it and keep working in this repo only. New chats in the Topic see every repo.`;
  };
  const chatHint = () => <Show when={chatNote()}>{(note) => <div class={styles.hint}>{note()}</div>}</Show>;

  const whereControl = () => (
    <div>
      <SegmentedControl
        aria-label="Where"
        options={[
          {
            value: "space" as const,
            label: props.space,
            icon: <SpaceMark name={props.space} icon={scope()?.icon} color={scope()?.color} size="sm" />,
          },
          { value: "global" as const, label: "Topics", icon: <Icon icon={Tag} /> },
        ]}
        value={where()}
        onChange={setWhere}
      />
      <div class={styles.hint}>
        {where() === "space"
          ? `Lives in ${props.space}'s tree. Can hold ${props.space}'s projects only.`
          : "Listed in Topics. Can hold projects from any space."}
      </div>
    </div>
  );

  // Both stay mounted and only one is open, so a tab switch keeps what was
  // typed on New: its state lives in the component, not in the dialog's content.
  const onNew = () => checked() && !refusal() && tab() === "new";

  return (
    <>
      <Dialog
        open={!onNew()}
        size="wide"
        title={`Move ${props.label} to a Topic`}
        onClose={() => props.onCancel()}
        actions={
          <>
            <Button onClick={() => props.onCancel()}>Cancel</Button>
            <Button variant="primary" disabled={!canMove()} onClick={() => void move()}>
              {busy() ? "Working…" : "Move"}
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
        <Show when={checked() && !refusal()}>
          {tabs()}
          <Show when={offered().length > 0} fallback={<div class={styles.msg}>No Topics yet.</div>}>
            <div class={styles.topicFilter}>
              <Icon icon={Search} class={styles.topicFilterIcon} />
              <input
                type="search"
                aria-label="Search Topics"
                placeholder="Search Topics"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
              />
            </div>
            <Show when={groups().length > 0} fallback={<div class={styles.pickedEmpty}>No Topic matches.</div>}>
              <For each={groups()}>
                {(group) => (
                  <div role="radiogroup" aria-label={`${group.label}, ${group.topics.length}`} class={styles.moveGroup}>
                    <div class={styles.repoGroupLabel} aria-hidden="true">
                      {group.label} <span class={styles.repoGroupCount}>{group.topics.length}</span>
                    </div>
                    <For each={group.topics}>
                      {(t) => (
                        <label class={styles.moveRow} data-picked={topicId() === t.id ? "" : undefined}>
                          <input
                            type="radio"
                            name={PICK_NAME}
                            value={t.id}
                            checked={topicId() === t.id}
                            onChange={() => setTopicId(t.id)}
                          />
                          <span class={styles.moveName}>{t.name}</span>
                          <span class={styles.moveChips}>
                            <For each={tintedMembers(t, props.spaces)}>
                              {(m) => (
                                <MemberChip
                                  icon={m.icon}
                                  chipStyle={m.style}
                                  reference={isReference(m.member)}
                                  decorative
                                />
                              )}
                            </For>
                          </span>
                        </label>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
            <Show when={taken()}>{(why) => <div class={styles.hint}>{why()}</div>}</Show>
            <Show when={!taken() && existing()}>
              {(m) => <div class={styles.hint}>Replaces the reference to {m().displayName}</div>}
            </Show>
            <div class={styles.msg}>The worktree keeps its branch and its changes. Nothing in git changes.</div>
            {chatHint()}
          </Show>
        </Show>
      </Dialog>
      <NewTopicDialog
        open={onNew()}
        spaces={props.spaces}
        topics={props.topics}
        space={where() === "space" ? props.space : undefined}
        pinned={{ repoPath: props.repoPath, worktreePath: props.worktreePath, branch: props.branch }}
        confirmLabel="Create and move"
        header={
          <>
            {tabs()}
            {whereControl()}
            {chatHint()}
          </>
        }
        onDone={props.onDone}
        onCancel={props.onCancel}
      />
    </>
  );
}
