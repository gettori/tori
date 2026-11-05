import { createEffect, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { pushToast } from "../../components/Toasts/Toasts";
import type { MenuItem } from "../../components/Menu/rows";
import type { MemberRisk } from "../../components/Dialogs/ConfirmDeleteTopic";
import type { SweepChoice, SweepMember } from "../../components/Dialogs/TopicWorktreeSweepDialog";
import {
  isReference,
  memberRoot,
  memberState,
  type Topic,
  type Member,
  type RepairAction,
  topicKey,
  newTopicDraft,
  LAST_MEMBER,
} from "../../utils/topics";
import { applyTopic, dropTopic, onPromoted, topicsReloaded } from "../../utils/topicStore";
import { finishedPr } from "../../utils/prRelation";
import { syncFor } from "../../utils/branchSync";
import { moveKey } from "../../utils/dragReorder";
import { pull } from "../../utils/gitActions";
import { emitWith, ROOT_MOVED, DRAFT_INTO_NEW, type RootMoved, type DraftIntoNew } from "../../utils/events";
import { demoteMemberWorktree, removeMemberWorktree } from "../../utils/memberWorktree";
import { purgeWorkspace } from "../../utils/purgeWorkspace";

export type TopicActionsHost = {
  activeId: () => string | null | undefined;
  /** `moved` names a member root that changed folder, so the active root can
   *  follow it rather than fall back to the first member. */
  onSelect?: (topic: Topic, moved?: { from: string; to: string }) => void;
  onCreated?: (topic: Topic) => void;
  onMoved?: (topic: Topic) => void;
  /** The selected Topic was deleted; the shell drops the selection. */
  onDeleted?: (topic: Topic) => void;
  /** The sidebar owns the live-tab list, so it answers this rather than the
   *  actions holding a second copy of the attribution rule. Absent means zero. */
  countRunning?: (path: string) => Promise<number> | undefined;
  /** The Topics whose member list is open, for the forge poller. */
  onExpanded?: (ids: string[]) => void;
};

const LS_EXPANDED = "tori.topics-expanded.v1";

function loadExpanded(): Record<string, boolean> {
  try {
    const ids = JSON.parse(localStorage.getItem(LS_EXPANDED) ?? "[]") as string[];
    return Object.fromEntries(ids.map((id) => [id, true]));
  } catch {
    return {};
  }
}

export type TopicActions = ReturnType<typeof createTopicActions>;

/** Add repositories to a Topic, or make one, in a space or global. */
export type DialogReq = { topic: Topic } | { space?: string };

/** One instance per window, so a row in Global and one in a named space's tree
 *  open the same dialog and see the same open rows. */
export function createTopicActions(host: TopicActionsHost) {
  const [error, setError] = createSignal<string | null>(null);
  const [dialog, setDialog] = createSignal<DialogReq | null>(null);
  const [renameReq, setRenameReq] = createSignal<Topic | null>(null);
  const [moveReq, setMoveReq] = createSignal<Topic | null>(null);
  // The delete confirm and the sweep that follows it, both carrying the same
  // per-member risk rows: the confirm fetches them, the sweep inherits them
  // rather than asking git the same question twice in a row.
  const [deleteReq, setDeleteReq] = createSignal<{
    topic: Topic;
    members: MemberRisk[];
    running: Record<string, number>;
    busy: boolean;
  } | null>(null);
  const [sweepReq, setSweepReq] = createSignal<{
    topic: Topic;
    members: SweepMember[];
    busy: boolean;
    failures: Record<string, string>;
    /** Live tabs under each worktree, so a row says what removal stops. */
    running: Record<string, number>;
  } | null>(null);
  const [memberRenameReq, setMemberRenameReq] = createSignal<{ topic: Topic; member: Member } | null>(null);
  // The worktree offer that follows a Remove repository, or a Remove worktree
  // (`demote`) that keeps the member and its branch. `worktreePath` is held
  // beside the member because the record no longer carries it by the time this
  // opens, and it is what the async fills key on so a second removal started
  // meanwhile cannot land its status on this one.
  const [wtReq, setWtReq] = createSignal<{
    topic: Topic;
    member: Member;
    worktreePath: string;
    demote: boolean;
    dirty: boolean | null;
    unpushed: boolean | null;
    hasRemote: boolean | null;
    ignoredWork: string[];
    runningCount: number;
    busy: boolean;
  } | null>(null);
  // Kept here rather than on the row: applying a record replaces the object the
  // `<For>` keys on, so a row's own open state would not survive a rename.
  // In localStorage so a restart reopens the rows that were open.
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>(loadExpanded());
  createEffect(() => {
    const open = Object.keys(expanded()).filter((id) => expanded()[id]);
    host.onExpanded?.(open);
    try {
      localStorage.setItem(LS_EXPANDED, JSON.stringify(open));
    } catch {
      // ignore quota
    }
  });

  createEffect(() => {
    topicsReloaded();
    setError(null);
  });
  onCleanup(onPromoted((p) => promoted(p.topic, p.from, p.to)));

  async function retry(topic: Topic, member: Member) {
    try {
      const next = await invoke<Topic>("retry_member", {
        topicId: topic.id,
        repoPath: member.repoPath,
      });
      if (next) applyTopic(next);
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
      if (next) applyTopic(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // The dialog resolves with the settled record. A member the backend could
  // not build stays on the chip as a badge and gets one toast naming it, with
  // Retry running every failed member again.
  function settled(topic: Topic) {
    const req = dialog();
    const created = !!req && !("topic" in req);
    if (created) setExpanded((prev) => ({ ...prev, [topic.id]: true }));
    setDialog(null);
    applyTopic(topic);
    if (created) {
      host.onCreated?.(topic);
      const draft = newTopicDraft(topic);
      if (draft) emitWith<DraftIntoNew>(DRAFT_INTO_NEW, draft);
    }
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
      if (next) applyTopic(next);
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

  function moved(topic: Topic) {
    setMoveReq(null);
    applyTopic(topic);
    host.onMoved?.(topic);
  }

  async function renameMember(topic: Topic, member: Member, name: string) {
    setMemberRenameReq(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === member.displayName) return;
    await mutate("rename_member", { topicId: topic.id, repoPath: member.repoPath, displayName: trimmed });
  }

  const reorder = (topic: Topic, repoPaths: string[]) => mutate("reorder_members", { topicId: topic.id, repoPaths });

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
    if (host.activeId() === topic.id) host.onSelect?.(next);
    // Only a usable member is offered its worktree. `reconcile_member` never
    // clears `worktree_path`, so a broken one still carries a folder git cannot
    // reach through its repo, and the dialog would confirm a removal that fails.
    const worktreePath = member.worktreePath;
    if (!worktreePath || !memberState(member.state).usable) return;
    offerWorktreeRemoval(next, member, worktreePath, false);
  }

  function offerWorktreeRemoval(topic: Topic, member: Member, worktreePath: string, demote: boolean) {
    setWtReq({
      topic,
      member,
      worktreePath,
      demote,
      dirty: null,
      unpushed: null,
      hasRemote: null,
      ignoredWork: [],
      runningCount: 0,
      busy: false,
    });
    const forThis = (fn: (r: NonNullable<ReturnType<typeof wtReq>>) => typeof r) =>
      setWtReq((r) => (r && r.worktreePath === worktreePath ? fn(r) : r));
    void host.countRunning?.(worktreePath)?.then((n) => forThis((r) => ({ ...r, runningCount: n })));
    invoke<{ dirty: boolean; unpushed: boolean; hasRemote: boolean; ignoredWork: string[] }>("worktree_status", {
      path: worktreePath,
    })
      .then((s) =>
        forThis((r) => ({
          ...r,
          dirty: s.dirty,
          unpushed: s.unpushed,
          hasRemote: s.hasRemote,
          ignoredWork: s.ignoredWork,
        })),
      )
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
    if (req.demote) {
      try {
        const next = await demoteMemberWorktree(req.topic.id, { ...req.member, worktreePath: req.worktreePath });
        demoted(req.topic, next, req.member.repoPath, req.worktreePath);
      } catch (e) {
        setError(String(e));
      }
      return setWtReq(null);
    }
    // A worktree moved in keeps a branch Tori never made, so it is never offered.
    const branch = req.member.keepsBranch ? null : req.topic.branch;
    if (branch && opts.deleteRemote) {
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

  const rootIn = (topic: Topic, repoPath: string) => {
    const m = topic.members.find((x) => x.repoPath === repoPath);
    return m ? memberRoot(m) : null;
  };

  // Clean tabs and the active root follow the member into its new worktree;
  // the reference's folder stays, so nothing there closes.
  async function promote(topic: Topic, member: Member) {
    const from = memberRoot(member);
    const next = await mutate("promote_member", { topicId: topic.id, repoPath: member.repoPath });
    if (next) promoted(next, from, rootIn(next, member.repoPath));
  }

  function promoted(next: Topic, from: string | null, to: string | null) {
    const moved = from && to ? { from, to } : undefined;
    if (moved) emitWith<RootMoved>(ROOT_MOVED, { workspace: topicKey(next.id), ...moved });
    if (host.activeId() === next.id) host.onSelect?.(next, moved);
  }

  function demote(topic: Topic, member: Member) {
    if (member.worktreePath && memberState(member.state).usable) {
      return offerWorktreeRemoval(topic, member, member.worktreePath, true);
    }
    // Nothing on disk to remove, so nothing to confirm: only the mode flips.
    void mutate("demote_member", { topicId: topic.id, repoPath: member.repoPath, force: false }).then(
      (next) => next && demoted(topic, next, member.repoPath, null),
    );
  }

  function demoted(topic: Topic, next: Topic, repoPath: string, from: string | null) {
    applyTopic(next);
    if (host.activeId() !== topic.id) return;
    const to = rootIn(next, repoPath);
    host.onSelect?.(next, from && to ? { from, to } : undefined);
  }

  /** Member repo paths in the order the record holds them. */
  const orderOf = (topic: Topic) => [...topic.members].sort((a, b) => a.order - b.order).map((m) => m.repoPath);

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
        keepsBranch: m.keepsBranch,
        branch: isReference(m) ? (m.checkout?.branch ?? null) : m.keepsBranch ? (m.branch ?? null) : topic.branch,
        reference: isReference(m),
        merged: !isReference(m) && isMerged(m, topic.branch),
      }));

  const isMerged = (m: Member, branch: string) => {
    const root = memberRoot(m);
    const b = m.keepsBranch ? (m.branch ?? branch) : branch;
    return finishedPr(root, b, syncFor(root, b))?.state === "merged";
  };

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
    setDeleteReq({ topic, members: risks(topic), running: {}, busy: false });
    const fold = (repoPath: string, s: { dirty: boolean; unpushed: boolean }) => {
      statuses[repoPath] = s;
      const same = (r: { topic: Topic } | null) => !!r && r.topic.id === topic.id;
      setDeleteReq((r) => (same(r) ? { ...r!, members: withStatuses(r!.members) } : r));
      setSweepReq((r) => (same(r) ? { ...r!, members: withStatuses(r!.members) } : r));
    };
    for (const m of risks(topic)) {
      if (!m.worktreePath) continue;
      void host
        .countRunning?.(m.worktreePath)
        ?.then((n) =>
          setDeleteReq((r) =>
            r && r.topic.id === topic.id ? { ...r, running: { ...r.running, [m.repoPath]: n } } : r,
          ),
        );
      invoke<{ dirty: boolean; unpushed: boolean }>("worktree_status", { path: m.worktreePath })
        .then((s) => fold(m.repoPath, { dirty: s.dirty, unpushed: s.unpushed }))
        .catch(() => fold(m.repoPath, { dirty: false, unpushed: false }));
    }
  }

  // The record goes first, and only then the worktrees chosen in the same
  // dialog: removing them before a delete that is then refused would leave a
  // Topic pointing at worktrees that are gone. A removal that fails reopens on
  // its own row in the sweep, with git's reason.
  async function remove(topic: Topic, members: MemberRisk[], choices: SweepChoice[]) {
    setDeleteReq((r) => (r ? { ...r, busy: true } : r));
    try {
      await discard(topic);
    } catch (e) {
      setDeleteReq(null);
      setError(String(e));
      return;
    }
    const failures = await removeWorktrees(topic.branch, choices);
    setDeleteReq(null);
    const stuck = withStatuses(members).filter((m): m is SweepMember => !!m.worktreePath && !!failures[m.repoPath]);
    if (stuck.length) setSweepReq({ topic, members: stuck, busy: false, failures, running: {} });
  }

  async function discard(topic: Topic) {
    await invoke("delete_topic", { topicId: topic.id });
    dropTopic(topic.id);
    // The debug stores key on member roots, not on the Topic key.
    purgeWorkspace(
      topicKey(topic.id),
      // Never a reference's folder: that is the user's own checkout, and the
      // keys under it belong to its Spaces unit as much as to this Topic.
      topic.members.filter((m) => !isReference(m)).map((m) => m.worktreePath ?? m.repoPath),
    );
    host.onDeleted?.(topic);
  }

  // Every row through the same purge-then-remove helper as Remove repository,
  // concurrently and settled rather than raced: one repo refusing must not keep
  // the others' worktrees. Answers why each failed one did, by repo path.
  async function removeWorktrees(branch: string, choices: SweepChoice[]): Promise<Record<string, string>> {
    const results = await Promise.allSettled(
      choices.map((c) =>
        removeMemberWorktree(
          { repoPath: c.repoPath, worktreePath: c.worktreePath },
          { branch, deleteBranch: c.deleteBranch },
        ),
      ),
    );
    const failures: Record<string, string> = {};
    results.forEach((r, i) => {
      if (r.status === "rejected") failures[choices[i].repoPath] = String(r.reason);
    });
    return failures;
  }

  // The retry for what the delete could not remove. What failed again stays on
  // screen with git's reason.
  async function sweep(choices: SweepChoice[]) {
    const req = sweepReq();
    if (!req) return;
    setSweepReq({ ...req, busy: true, failures: {} });
    const failures = await removeWorktrees(req.topic.branch, choices);
    const stuck = req.members.filter((m) => failures[m.repoPath]);
    // "Keep all" stays live while the removals run, so a dismissed dialog must
    // not be reopened by a row that failed after the user had walked away.
    if (!sweepReq() || !stuck.length) return setSweepReq(null);
    setSweepReq({ ...req, members: stuck, busy: false, failures });
  }

  const menu = (topic: Topic): MenuItem[] => [
    { label: "Rename…", onClick: () => setRenameReq(topic) },
    { label: "Move to…", onClick: () => setMoveReq(topic) },
    { label: "Add repository…", onClick: () => setDialog({ topic }) },
    { separator: true },
    { label: "Delete…", danger: true, onClick: () => openDelete(topic) },
  ];

  // Refusing rather than disabled for the last member: the row stays reachable
  // by arrow key, and the reason the backend would answer with is drawn on it
  // here instead of arriving as an error after the click.
  const memberMenu =
    (topic: Topic) =>
    (member: Member): MenuItem[] => {
      const keys = orderOf(topic);
      const i = keys.indexOf(member.repoPath);
      const last = topic.members.length <= 1;
      // A reference reads the user's own checkout, which goes stale unless it is
      // pulled; pulling is the one git write it takes.
      const root = isReference(member) ? memberRoot(member) : null;
      return [
        ...(root ? [{ label: "Pull", onClick: () => void pull(root, false, true) }, { separator: true as const }] : []),
        // A worktree moved in has no Remove worktree: promoting it back would
        // land on the Topic branch, not the one it came with.
        ...(isReference(member)
          ? [{ label: "Create worktree", onClick: () => void promote(topic, member) }]
          : member.keepsBranch
            ? []
            : [{ label: "Remove worktree…", onClick: () => demote(topic, member) }]),
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

  return {
    error,
    dialog,
    setDialog,
    openNew: (space?: string) => setDialog(space ? { space } : {}),
    renameReq,
    setRenameReq,
    moveReq,
    setMoveReq,
    moved,
    memberRenameReq,
    setMemberRenameReq,
    deleteReq,
    setDeleteReq,
    sweepReq,
    setSweepReq,
    wtReq,
    setWtReq,
    expanded,
    setExpanded,
    settled,
    repair,
    reorder,
    rename,
    renameMember,
    confirmRemoveWorktree,
    remove,
    discard,
    sweep,
    openDelete,
    keepInGlobal: (topic: Topic) => void mutate("set_topic_space", { topicId: topic.id, space: null }),
    /** Take a repo out of a Topic without offering its worktree: the folder is
     *  being forgotten, and its worktree stays where it is. */
    dropRepo: (topic: Topic, repoPath: string) => mutate("remove_member", { topicId: topic.id, repoPath }),
    menu,
    memberMenu,
  };
}
