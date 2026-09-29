import { createSignal, For, Show, onMount, onCleanup, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TopicItem, { type SpaceTint } from "./TopicItem";
import Button from "../../components/Button/Button";
import NewTopicDialog from "../../components/Dialogs/NewTopicDialog";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDeleteTopic, { type MemberRisk } from "../../components/Dialogs/ConfirmDeleteTopic";
import TopicWorktreeSweepDialog, {
  type SweepChoice,
  type SweepMember,
} from "../../components/Dialogs/TopicWorktreeSweepDialog";
import WorktreeRemoveDialog from "../../components/Dialogs/WorktreeRemoveDialog";
import { pushToast } from "../../components/Toasts/Toasts";
import type { MenuItem } from "../../components/Menu/rows";
import type { RepoSpace } from "../../components/Dialogs/RepoChecklist";
import {
  isReference,
  memberBranch,
  memberRoot,
  memberState,
  type Topic,
  type Member,
  type RepairAction,
  topicKey,
  LAST_MEMBER,
} from "../../utils/topics";
import { moveKey } from "../../utils/dragReorder";
import { syncFor } from "../../utils/branchSync";
import { pull } from "../../utils/gitActions";
import { finishedPr } from "../../utils/prRelation";
import { on as onEvent, NEW_TOPIC } from "../../utils/events";
import { removeMemberWorktree } from "../../utils/memberWorktree";
import { purgeWorkspace } from "../../utils/purgeWorkspace";
import styles from "./TopicList.module.css";

/** What the list needs from a Space: the tint for a chip and the projects for
 *  the creation checklist. The sidebar's own `Space` satisfies it as is. */
export type TopicSpace = SpaceTint & RepoSpace;

/** The sidebar's Topics mode: every Topic as a row, the dialogs that make
 *  or change one, and the toast for a creation that left a member failed.
 *  Mounted only in that mode, so it owns its own fetch and its own listeners;
 *  the sidebar hands it the Spaces and the shared filter string.
 *
 *  Two feeds keep it current. `topics://changed` carries a whole Topic
 *  after every step of a creation, and is applied as is, no refetch, so chips
 *  flip one by one. `config://changed` fires once at the end (and whenever
 *  the tree changes for any other reason), and that one refetches. */
// The order `projects.list` serves topics in, so a client drawing from the
// socket lists them the way this does.
const lower = (t: Topic) => t.name.toLowerCase();
const byName = (a: Topic, b: Topic) =>
  lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export default function TopicList(props: {
  spaces: TopicSpace[];
  query: string;
  class?: string;
  /** The selected Topic's id, so exactly one row reads as active. */
  activeId?: string | null;
  onSelect?: (topic: Topic) => void;
  /** The selected Topic was deleted; the shell drops the selection. */
  onDeleted?: (topic: Topic) => void;
  /** Live shell/agent tabs under a folder, for the removal confirm's warning.
   *  The sidebar owns the live-tab list, so it answers this rather than the
   *  list holding a second copy of the attribution rule. Absent means zero. */
  countRunning?: (path: string) => Promise<number>;
}) {
  const [topics, setTopics] = createSignal<Topic[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [dialog, setDialog] = createSignal<{ topic?: Topic } | null>(null);
  const [renameReq, setRenameReq] = createSignal<Topic | null>(null);
  // The delete confirm and the sweep that follows it, both carrying the same
  // per-member risk rows: the confirm fetches them, the sweep inherits them
  // rather than asking git the same question twice in a row.
  const [deleteReq, setDeleteReq] = createSignal<{ topic: Topic; members: MemberRisk[] } | null>(null);
  const [sweepReq, setSweepReq] = createSignal<{
    topic: Topic;
    members: SweepMember[];
    busy: boolean;
    failures: Record<string, string>;
    /** Live tabs under each worktree, so a row says what removal stops. */
    running: Record<string, number>;
  } | null>(null);
  const [memberRenameReq, setMemberRenameReq] = createSignal<{ topic: Topic; member: Member } | null>(null);
  // The worktree offer that follows a Remove repository. `worktreePath` is held
  // beside the member because the record no longer carries it by the time this
  // opens, and it is what the async fills key on so a second removal started
  // meanwhile cannot land its status on this one.
  const [wtReq, setWtReq] = createSignal<{
    topic: Topic;
    member: Member;
    worktreePath: string;
    dirty: boolean | null;
    unpushed: boolean | null;
    hasRemote: boolean | null;
    runningCount: number;
    busy: boolean;
  } | null>(null);
  // Kept here rather than on the row: applying a record replaces the object the
  // `<For>` keys on, so a row's own open state would not survive a rename.
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  // Latest request wins: a refetch started later must not be overwritten by
  // an earlier one that resolved later.
  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const list = (await invoke<Topic[] | null>("list_topics")) ?? [];
      if (mine !== seq) return;
      setTopics(list);
      setError(null);
    } catch (e) {
      if (mine !== seq) return;
      setError(String(e));
    }
  }

  function apply(topic: Topic) {
    setTopics((prev) => {
      const i = prev.findIndex((f) => f.id === topic.id);
      if (i < 0) return [...prev, topic];
      const next = prev.slice();
      next[i] = topic;
      return next;
    });
  }

  // The head row's `+` lives in the sidebar, one component up, and this is what
  // it reaches. Registered outside `onMount` so the listener exists before the
  // first fetch resolves.
  onCleanup(onEvent(NEW_TOPIC, () => setDialog({})));

  let unlistenTopics: UnlistenFn | undefined;
  let unlistenConfig: UnlistenFn | undefined;
  onMount(async () => {
    await load();
    unlistenTopics = await listen<Topic>("topics://changed", (e) => apply(e.payload));
    unlistenConfig = await listen("config://changed", () => load());
  });
  onCleanup(() => {
    unlistenTopics?.();
    unlistenConfig?.();
  });

  async function retry(topic: Topic, member: Member) {
    try {
      const next = await invoke<Topic>("retry_member", {
        topicId: topic.id,
        repoPath: member.repoPath,
      });
      if (next) apply(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // Which repair a broken member gets is `memberState`'s call, made once in the
  // row; this only routes it. Locate is the one that asks first, and a cancelled
  // picker answers null, which must leave the record exactly as it was.
  async function repair(topic: Topic, member: Member, action: RepairAction) {
    if (action !== "locate") return retry(topic, member);
    try {
      const newRepoPath = await invoke<string | null>("pick_folder");
      if (!newRepoPath) return;
      const next = await invoke<Topic>("relocate_member", {
        topicId: topic.id,
        repoPath: member.repoPath,
        newRepoPath,
      });
      if (next) apply(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // The dialog resolves with the settled record. A member the backend could
  // not build stays on the chip as a badge and gets one toast naming it, with
  // Retry running every failed member again.
  function settled(topic: Topic) {
    setDialog(null);
    apply(topic);
    const failed = topic.members.filter((m) => memberState(m.state).action === "retry");
    if (failed.length === 0) return;
    const names = failed.map((m) => m.displayName).join(", ");
    pushToast(`${topic.name}: no worktree for ${names}`, "error", {
      label: "Retry",
      run: () => failed.forEach((m) => void retry(topic, m)),
    });
  }

  // Every record-only command answers with the reloaded Topic and emits
  // `topics://changed` for the surfaces outside this list; applying the
  // answer here is only what keeps the row from waiting on the round trip.
  async function mutate(command: string, args: Record<string, unknown>): Promise<Topic | null> {
    try {
      const next = await invoke<Topic>(command, args);
      if (next) apply(next);
      return next ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  async function rename(topic: Topic, name: string) {
    setRenameReq(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === topic.name) return;
    await mutate("rename_topic", { topicId: topic.id, name: trimmed });
  }

  async function renameMember(topic: Topic, member: Member, name: string) {
    setMemberRenameReq(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === member.displayName) return;
    await mutate("rename_member", { topicId: topic.id, repoPath: member.repoPath, displayName: trimmed });
  }

  const reorder = (topic: Topic, repoPaths: string[]) =>
    mutate("reorder_members", { topicId: topic.id, repoPaths });

  // The record detaches first, as the ticket specifies, and only then is the
  // worktree offered: the member has already left the Topic by the time the
  // dialog opens, which is why declining there reads "Keep worktree".
  async function removeMember(topic: Topic, member: Member) {
    const next = await mutate("remove_member", { topicId: topic.id, repoPath: member.repoPath });
    if (!next) return;
    // The Selection still names the departed root. Re-resolving it from the
    // record drops that root and, when it was the active one, moves `activeRoot`
    // to the first that remains, before anything touches the folder. Only for
    // the open Topic: a removal elsewhere must not switch the workspace to it.
    if (props.activeId === topic.id) props.onSelect?.(next);
    // Only a usable member is offered its worktree. `reconcile_member` never
    // clears `worktree_path`, so a broken one still carries a folder git cannot
    // reach through its repo, and the dialog would confirm a removal that fails.
    const worktreePath = member.worktreePath;
    if (!worktreePath || !memberState(member.state).usable) return;
    setWtReq({
      topic: next,
      member,
      worktreePath,
      dirty: null,
      unpushed: null,
      hasRemote: null,
      runningCount: 0,
      busy: false,
    });
    const forThis = (fn: (r: NonNullable<ReturnType<typeof wtReq>>) => typeof r) =>
      setWtReq((r) => (r && r.worktreePath === worktreePath ? fn(r) : r));
    void props.countRunning?.(worktreePath).then((n) => forThis((r) => ({ ...r, runningCount: n })));
    invoke<{ dirty: boolean; unpushed: boolean; hasRemote: boolean }>("worktree_status", { path: worktreePath })
      .then((s) => forThis((r) => ({ ...r, dirty: s.dirty, unpushed: s.unpushed, hasRemote: s.hasRemote })))
      .catch(() => forThis((r) => ({ ...r, dirty: false, unpushed: false, hasRemote: false })));
  }

  // Confirmed: `removeMemberWorktree` carries the purge-then-remove contract.
  // The remote delete goes first while the local branch's tracking config can
  // still resolve it, and a failure there is reported without aborting, exactly
  // as it is for a plain worktree unit.
  async function confirmRemoveWorktree(opts: { deleteLocal: boolean; deleteRemote: boolean }) {
    const req = wtReq();
    if (!req) return;
    setWtReq({ ...req, busy: true });
    const branch = req.topic.branch;
    if (opts.deleteRemote) {
      try {
        await invoke("delete_remote_branch", { repo: req.member.repoPath, branch });
      } catch (e) {
        setError(`Remote branch not deleted: ${String(e)}`);
      }
    }
    try {
      await removeMemberWorktree(
        { repoPath: req.member.repoPath, worktreePath: req.worktreePath },
        { branch, deleteBranch: opts.deleteLocal },
      );
    } catch (e) {
      setError(String(e));
    }
    setWtReq(null);
  }

  /** Member repo paths in the order the record holds them. */
  const orderOf = (topic: Topic) =>
    [...topic.members].sort((a, b) => a.order - b.order).map((m) => m.repoPath);

  function move(topic: Topic, member: Member, by: -1 | 1) {
    const keys = orderOf(topic);
    const target = keys[keys.indexOf(member.repoPath) + by];
    if (target) void reorder(topic, moveKey(keys, member.repoPath, target));
  }

  /** Every member as the delete flow shows it, before git has answered. */
  const risks = (topic: Topic): MemberRisk[] =>
    [...topic.members]
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        repoPath: m.repoPath,
        label: m.displayName,
        worktreePath: memberState(m.state).usable ? m.worktreePath : null,
        state: memberState(m.state).label,
        dirty: null,
        unpushed: null,
      }));

  // What git said about each member's worktree, by repo path. Kept beside the two
  // signals rather than only in them: the confirm closes before `delete_topic`
  // answers and the sweep opens after, so a status resolving in that gap has no
  // dialog to land on and the row would reach the sweep stuck on "checking...".
  let statuses: Record<string, { dirty: boolean; unpushed: boolean }> = {};
  const withStatuses = <T extends MemberRisk>(members: T[]): T[] =>
    members.map((m) => (statuses[m.repoPath] ? { ...m, ...statuses[m.repoPath] } : m));

  // Open the confirm, then ask git about each member's worktree so the rows can
  // say what is about to be at risk. A member with nothing usable on disk is
  // asked nothing: its row shows its state instead.
  function openDelete(topic: Topic) {
    statuses = {};
    setDeleteReq({ topic, members: risks(topic) });
    const fold = (repoPath: string, s: { dirty: boolean; unpushed: boolean }) => {
      statuses[repoPath] = s;
      const same = (r: { topic: Topic } | null) => !!r && r.topic.id === topic.id;
      setDeleteReq((r) => (same(r) ? { ...r!, members: withStatuses(r!.members) } : r));
      setSweepReq((r) => (same(r) ? { ...r!, members: withStatuses(r!.members) } : r));
    };
    for (const m of risks(topic)) {
      if (!m.worktreePath) continue;
      invoke<{ dirty: boolean; unpushed: boolean }>("worktree_status", { path: m.worktreePath })
        .then((s) => fold(m.repoPath, { dirty: s.dirty, unpushed: s.unpushed }))
        .catch(() => fold(m.repoPath, { dirty: false, unpushed: false }));
    }
  }

  // The record is gone; so is every store keyed by it, before the selection
  // changes, so nothing persists the key back on the way out. Only then are the
  // worktrees offered: a sweep opened before the delete could be answered for a
  // Topic the delete then refused to remove.
  async function remove(topic: Topic, members: MemberRisk[]) {
    setDeleteReq(null);
    try {
      await invoke("delete_topic", { topicId: topic.id });
    } catch (e) {
      setError(String(e));
      return;
    }
    setTopics((prev) => prev.filter((f) => f.id !== topic.id));
    // The member roots go with the key: the three debug stores key on one, and
    // `delete_topic` has already taken the record they could be read back
    // from. Same rule as `tintedMember.key`, so the sweep names the folder the
    // panels wrote under.
    purgeWorkspace(
      topicKey(topic.id),
      // Never a reference's folder: that is the user's own checkout, and the
      // keys under it belong to its Spaces unit as much as to this Topic.
      topic.members.filter((m) => !isReference(m)).map((m) => m.worktreePath ?? m.repoPath),
    );
    props.onDeleted?.(topic);
    const left = withStatuses(members).filter((m): m is SweepMember => !!m.worktreePath);
    if (!left.length) return;
    setSweepReq({ topic, members: left, busy: false, failures: {}, running: {} });
    // Asked once the sweep exists rather than with the confirm: the count is
    // about what a removal stops, and the confirm removes nothing.
    for (const m of left) {
      void props.countRunning?.(m.worktreePath).then((n) =>
        setSweepReq((r) =>
          r && r.topic.id === topic.id ? { ...r, running: { ...r.running, [m.repoPath]: n } } : r,
        ),
      );
    }
  }

  // Every row through the same purge-then-remove helper as Remove repository,
  // concurrently and settled rather than raced: one repo refusing must not keep
  // the others' worktrees. What failed stays on screen with git's reason.
  async function sweep(choices: SweepChoice[]) {
    const req = sweepReq();
    if (!req) return;
    setSweepReq({ ...req, busy: true, failures: {} });
    const results = await Promise.allSettled(
      choices.map((c) =>
        removeMemberWorktree(
          { repoPath: c.repoPath, worktreePath: c.worktreePath },
          { branch: req.topic.branch, deleteBranch: c.deleteBranch },
        ),
      ),
    );
    const failures: Record<string, string> = {};
    results.forEach((r, i) => {
      if (r.status === "rejected") failures[choices[i].repoPath] = String(r.reason);
    });
    const stuck = req.members.filter((m) => failures[m.repoPath]);
    // "Keep all" stays live while the removals run, so a dismissed dialog must
    // not be reopened by a row that failed after the user had walked away.
    if (!sweepReq() || !stuck.length) return setSweepReq(null);
    setSweepReq({ ...req, members: stuck, busy: false, failures });
  }

  const menu = (topic: Topic): MenuItem[] => [
    { label: "Rename…", onClick: () => setRenameReq(topic) },
    { label: "Add repository…", onClick: () => setDialog({ topic }) },
    { separator: true },
    { label: "Delete…", danger: true, onClick: () => openDelete(topic) },
  ];

  // Refusing rather than disabled for the last member: the row stays reachable
  // by arrow key, and the reason the backend would answer with is drawn on it
  // here instead of arriving as an error after the click.
  const memberMenu = (topic: Topic) => (member: Member): MenuItem[] => {
    const keys = orderOf(topic);
    const i = keys.indexOf(member.repoPath);
    const last = topic.members.length <= 1;
    // A reference reads the user's own checkout, which goes stale unless it is
    // pulled; pulling is the one git write it takes.
    const root = isReference(member) ? memberRoot(member) : null;
    return [
      ...(root ? [{ label: "Pull", onClick: () => void pull(root, false, true) }, { separator: true as const }] : []),
      { label: "Rename…", onClick: () => setMemberRenameReq({ topic, member }) },
      { label: "Move up", disabled: i <= 0, onClick: () => move(topic, member, -1) },
      { label: "Move down", disabled: i < 0 || i >= keys.length - 1, onClick: () => move(topic, member, 1) },
      { separator: true },
      {
        label: "Remove repository",
        danger: true,
        refusing: last,
        note: last ? LAST_MEMBER : undefined,
        onClick: () => void removeMember(topic, member),
      },
    ];
  };

  const visible = createMemo(() => {
    const q = props.query.trim().toLowerCase();
    const all = [...topics()].sort(byName);
    if (!q) return all;
    return all.filter(
      (f) => f.name.toLowerCase().includes(q) || f.members.some((m) => m.displayName.toLowerCase().includes(q)),
    );
  });

  return (
    <div class={styles.list} classList={{ [props.class ?? ""]: !!props.class }} data-topic-list>
      <Show when={error()}>{(msg) => <p class={styles.error}>{msg()}</p>}</Show>
      <Show
        when={visible().length > 0}
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
      >
        <ul class={styles.items} data-no-window-drag>
          <For each={visible()}>
            {(f) => (
              <TopicItem
                topic={f}
                spaces={props.spaces}
                active={props.activeId === f.id}
                onSelect={props.onSelect}
                onRepair={(m, action) => void repair(f, m, action)}
                menu={menu(f)}
                memberMenu={memberMenu(f)}
                memberSync={(m) => syncFor(memberRoot(m), memberBranch(m, f.branch))}
                memberFinished={(m) =>
                  // A reference sits on the repo's default branch, whose PRs are
                  // not this Topic's.
                  isReference(m) ? null : finishedPr(memberRoot(m), f.branch, syncFor(memberRoot(m), f.branch))
                }
                onReorder={(repoPaths) => void reorder(f, repoPaths)}
                expanded={!!expanded()[f.id]}
                onExpand={(open) => setExpanded((prev) => ({ ...prev, [f.id]: open }))}
              />
            )}
          </For>
        </ul>
      </Show>

      <Show when={dialog()}>
        {(req) => (
          <NewTopicDialog
            spaces={props.spaces}
            topics={topics()}
            topic={req().topic}
            onDone={settled}
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
            onSubmit={(v) => void rename(f(), v)}
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
            onSubmit={(v) => void renameMember(req().topic, req().member, v)}
            onCancel={() => setMemberRenameReq(null)}
          />
        )}
      </Show>

      <Show when={wtReq()}>
        {(req) => (
          <WorktreeRemoveDialog
            label={req().member.displayName}
            path={req().worktreePath}
            branch={req().topic.branch}
            dirty={req().dirty}
            unpushed={req().unpushed}
            hasRemote={req().hasRemote}
            runningCount={req().runningCount}
            busy={req().busy}
            keepLabel="Keep worktree"
            onConfirm={(opts) => void confirmRemoveWorktree(opts)}
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
            onConfirm={() => void remove(req().topic, req().members)}
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
            onApply={(choices) => void sweep(choices)}
            onClose={() => setSweepReq(null)}
          />
        )}
      </Show>
    </div>
  );
}
