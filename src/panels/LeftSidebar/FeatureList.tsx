import { createSignal, For, Show, onMount, onCleanup, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import FeatureItem, { type SpaceTint } from "./FeatureItem";
import Button from "../../components/Button/Button";
import NewFeatureDialog from "../../components/Dialogs/NewFeatureDialog";
import PromptModal from "../../components/Dialogs/PromptModal";
import ConfirmDeleteFeature, { type MemberRisk } from "../../components/Dialogs/ConfirmDeleteFeature";
import FeatureWorktreeSweepDialog, {
  type SweepChoice,
  type SweepMember,
} from "../../components/Dialogs/FeatureWorktreeSweepDialog";
import WorktreeRemoveDialog from "../../components/Dialogs/WorktreeRemoveDialog";
import { pushToast } from "../../components/Toasts/Toasts";
import type { MenuItem } from "../../components/Menu/rows";
import type { RepoSpace } from "../../components/Dialogs/RepoChecklist";
import { memberState, type Feature, type Member, type RepairAction, featureKey, LAST_MEMBER } from "../../utils/features";
import { moveKey } from "../../utils/dragReorder";
import { gitStateFor } from "../../utils/gitActions";
import { removeMemberWorktree } from "../../utils/memberWorktree";
import { purgeWorkspace } from "../../utils/purgeWorkspace";
import styles from "./FeatureList.module.css";

/** What the list needs from a Space: the tint for a chip and the projects for
 *  the creation checklist. The sidebar's own `Space` satisfies it as is. */
export type FeatureSpace = SpaceTint & RepoSpace;

/** The sidebar's Features mode: every Feature as a row, the dialogs that make
 *  or change one, and the toast for a creation that left a member failed.
 *  Mounted only in that mode, so it owns its own fetch and its own listeners;
 *  the sidebar hands it the Spaces and the shared filter string.
 *
 *  Two feeds keep it current. `features://changed` carries a whole Feature
 *  after every step of a creation, and is applied as is, no refetch, so chips
 *  flip one by one. `config://changed` fires once at the end (and whenever
 *  the tree changes for any other reason), and that one refetches. */
export default function FeatureList(props: {
  spaces: FeatureSpace[];
  query: string;
  class?: string;
  /** The selected Feature's id, so exactly one row reads as active. */
  activeId?: string | null;
  onSelect?: (feature: Feature) => void;
  /** The selected Feature was deleted; the shell drops the selection. */
  onDeleted?: (feature: Feature) => void;
  /** Live shell/agent tabs under a folder, for the removal confirm's warning.
   *  The sidebar owns the live-tab list, so it answers this rather than the
   *  list holding a second copy of the attribution rule. Absent means zero. */
  countRunning?: (path: string) => Promise<number>;
}) {
  const [features, setFeatures] = createSignal<Feature[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [dialog, setDialog] = createSignal<{ feature?: Feature } | null>(null);
  const [renameReq, setRenameReq] = createSignal<Feature | null>(null);
  // The delete confirm and the sweep that follows it, both carrying the same
  // per-member risk rows: the confirm fetches them, the sweep inherits them
  // rather than asking git the same question twice in a row.
  const [deleteReq, setDeleteReq] = createSignal<{ feature: Feature; members: MemberRisk[] } | null>(null);
  const [sweepReq, setSweepReq] = createSignal<{
    feature: Feature;
    members: SweepMember[];
    busy: boolean;
    failures: Record<string, string>;
    /** Live tabs under each worktree, so a row says what removal stops. */
    running: Record<string, number>;
  } | null>(null);
  const [memberRenameReq, setMemberRenameReq] = createSignal<{ feature: Feature; member: Member } | null>(null);
  // The worktree offer that follows a Remove repository. `worktreePath` is held
  // beside the member because the record no longer carries it by the time this
  // opens, and it is what the async fills key on so a second removal started
  // meanwhile cannot land its status on this one.
  const [wtReq, setWtReq] = createSignal<{
    feature: Feature;
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
      const list = (await invoke<Feature[] | null>("list_features")) ?? [];
      if (mine !== seq) return;
      setFeatures(list);
      setError(null);
    } catch (e) {
      if (mine !== seq) return;
      setError(String(e));
    }
  }

  function apply(feature: Feature) {
    setFeatures((prev) => {
      const i = prev.findIndex((f) => f.id === feature.id);
      if (i < 0) return [...prev, feature];
      const next = prev.slice();
      next[i] = feature;
      return next;
    });
  }

  let unlistenFeatures: UnlistenFn | undefined;
  let unlistenConfig: UnlistenFn | undefined;
  onMount(async () => {
    await load();
    unlistenFeatures = await listen<Feature>("features://changed", (e) => apply(e.payload));
    unlistenConfig = await listen("config://changed", () => load());
  });
  onCleanup(() => {
    unlistenFeatures?.();
    unlistenConfig?.();
  });

  async function retry(feature: Feature, member: Member) {
    try {
      const next = await invoke<Feature>("retry_member", {
        featureId: feature.id,
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
  async function repair(feature: Feature, member: Member, action: RepairAction) {
    if (action !== "locate") return retry(feature, member);
    try {
      const newRepoPath = await invoke<string | null>("pick_folder");
      if (!newRepoPath) return;
      const next = await invoke<Feature>("relocate_member", {
        featureId: feature.id,
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
  function settled(feature: Feature) {
    setDialog(null);
    apply(feature);
    const failed = feature.members.filter((m) => memberState(m.state).action === "retry");
    if (failed.length === 0) return;
    const names = failed.map((m) => m.displayName).join(", ");
    pushToast(`${feature.name}: no worktree for ${names}`, "error", {
      label: "Retry",
      run: () => failed.forEach((m) => void retry(feature, m)),
    });
  }

  // Every record-only command answers with the reloaded Feature and emits
  // `features://changed` for the surfaces outside this list; applying the
  // answer here is only what keeps the row from waiting on the round trip.
  async function mutate(command: string, args: Record<string, unknown>): Promise<Feature | null> {
    try {
      const next = await invoke<Feature>(command, args);
      if (next) apply(next);
      return next ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  async function rename(feature: Feature, name: string) {
    setRenameReq(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === feature.name) return;
    await mutate("rename_feature", { featureId: feature.id, name: trimmed });
  }

  async function renameMember(feature: Feature, member: Member, name: string) {
    setMemberRenameReq(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === member.displayName) return;
    await mutate("rename_member", { featureId: feature.id, repoPath: member.repoPath, displayName: trimmed });
  }

  const reorder = (feature: Feature, repoPaths: string[]) =>
    mutate("reorder_members", { featureId: feature.id, repoPaths });

  // The record detaches first, as the ticket specifies, and only then is the
  // worktree offered: the member has already left the Feature by the time the
  // dialog opens, which is why declining there reads "Keep worktree".
  async function removeMember(feature: Feature, member: Member) {
    const next = await mutate("remove_member", { featureId: feature.id, repoPath: member.repoPath });
    if (!next) return;
    // The Selection still names the departed root. Re-resolving it from the
    // record drops that root and, when it was the active one, moves `activeRoot`
    // to the first that remains, before anything touches the folder. Only for
    // the open Feature: a removal elsewhere must not switch the workspace to it.
    if (props.activeId === feature.id) props.onSelect?.(next);
    // Only a usable member is offered its worktree. `reconcile_member` never
    // clears `worktree_path`, so a broken one still carries a folder git cannot
    // reach through its repo, and the dialog would confirm a removal that fails.
    const worktreePath = member.worktreePath;
    if (!worktreePath || !memberState(member.state).usable) return;
    setWtReq({
      feature: next,
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
    const branch = req.feature.branch;
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
  const orderOf = (feature: Feature) =>
    [...feature.members].sort((a, b) => a.order - b.order).map((m) => m.repoPath);

  function move(feature: Feature, member: Member, by: -1 | 1) {
    const keys = orderOf(feature);
    const target = keys[keys.indexOf(member.repoPath) + by];
    if (target) void reorder(feature, moveKey(keys, member.repoPath, target));
  }

  /** Every member as the delete flow shows it, before git has answered. */
  const risks = (feature: Feature): MemberRisk[] =>
    [...feature.members]
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
  // signals rather than only in them: the confirm closes before `delete_feature`
  // answers and the sweep opens after, so a status resolving in that gap has no
  // dialog to land on and the row would reach the sweep stuck on "checking...".
  let statuses: Record<string, { dirty: boolean; unpushed: boolean }> = {};
  const withStatuses = <T extends MemberRisk>(members: T[]): T[] =>
    members.map((m) => (statuses[m.repoPath] ? { ...m, ...statuses[m.repoPath] } : m));

  // Open the confirm, then ask git about each member's worktree so the rows can
  // say what is about to be at risk. A member with nothing usable on disk is
  // asked nothing: its row shows its state instead.
  function openDelete(feature: Feature) {
    statuses = {};
    setDeleteReq({ feature, members: risks(feature) });
    const fold = (repoPath: string, s: { dirty: boolean; unpushed: boolean }) => {
      statuses[repoPath] = s;
      const same = (r: { feature: Feature } | null) => !!r && r.feature.id === feature.id;
      setDeleteReq((r) => (same(r) ? { ...r!, members: withStatuses(r!.members) } : r));
      setSweepReq((r) => (same(r) ? { ...r!, members: withStatuses(r!.members) } : r));
    };
    for (const m of risks(feature)) {
      if (!m.worktreePath) continue;
      invoke<{ dirty: boolean; unpushed: boolean }>("worktree_status", { path: m.worktreePath })
        .then((s) => fold(m.repoPath, { dirty: s.dirty, unpushed: s.unpushed }))
        .catch(() => fold(m.repoPath, { dirty: false, unpushed: false }));
    }
  }

  // The record is gone; so is every store keyed by it, before the selection
  // changes, so nothing persists the key back on the way out. Only then are the
  // worktrees offered: a sweep opened before the delete could be answered for a
  // Feature the delete then refused to remove.
  async function remove(feature: Feature, members: MemberRisk[]) {
    setDeleteReq(null);
    try {
      await invoke("delete_feature", { featureId: feature.id });
    } catch (e) {
      setError(String(e));
      return;
    }
    setFeatures((prev) => prev.filter((f) => f.id !== feature.id));
    // The member roots go with the key: the three debug stores key on one, and
    // `delete_feature` has already taken the record they could be read back
    // from. Same rule as `tintedMember.key`, so the sweep names the folder the
    // panels wrote under.
    purgeWorkspace(
      featureKey(feature.id),
      feature.members.map((m) => m.worktreePath ?? m.repoPath),
    );
    props.onDeleted?.(feature);
    const left = withStatuses(members).filter((m): m is SweepMember => !!m.worktreePath);
    if (!left.length) return;
    setSweepReq({ feature, members: left, busy: false, failures: {}, running: {} });
    // Asked once the sweep exists rather than with the confirm: the count is
    // about what a removal stops, and the confirm removes nothing.
    for (const m of left) {
      void props.countRunning?.(m.worktreePath).then((n) =>
        setSweepReq((r) =>
          r && r.feature.id === feature.id ? { ...r, running: { ...r.running, [m.repoPath]: n } } : r,
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
          { branch: req.feature.branch, deleteBranch: c.deleteBranch },
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

  // Asked per member rather than of the slot map as a whole: the editor only
  // enters the open Feature's roots, so every other row sums to nothing on its
  // own, and no row can be handed a number the member beside it measured.
  const changedIn = (feature: Feature) =>
    feature.members.reduce((n, m) => n + gitStateFor(m.worktreePath).files.length, 0);

  const menu = (feature: Feature): MenuItem[] => [
    { label: "Rename…", onClick: () => setRenameReq(feature) },
    { label: "Add repository…", onClick: () => setDialog({ feature }) },
    { separator: true },
    { label: "Delete…", danger: true, onClick: () => openDelete(feature) },
  ];

  // Refusing rather than disabled for the last member: the row stays reachable
  // by arrow key, and the reason the backend would answer with is drawn on it
  // here instead of arriving as an error after the click.
  const memberMenu = (feature: Feature) => (member: Member): MenuItem[] => {
    const keys = orderOf(feature);
    const i = keys.indexOf(member.repoPath);
    const last = feature.members.length <= 1;
    return [
      { label: "Rename…", onClick: () => setMemberRenameReq({ feature, member }) },
      { label: "Move up", disabled: i <= 0, onClick: () => move(feature, member, -1) },
      { label: "Move down", disabled: i < 0 || i >= keys.length - 1, onClick: () => move(feature, member, 1) },
      { separator: true },
      {
        label: "Remove repository",
        danger: true,
        refusing: last,
        note: last ? LAST_MEMBER : undefined,
        onClick: () => void removeMember(feature, member),
      },
    ];
  };

  const visible = createMemo(() => {
    const q = props.query.trim().toLowerCase();
    const all = [...features()].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return all;
    return all.filter(
      (f) => f.name.toLowerCase().includes(q) || f.members.some((m) => m.displayName.toLowerCase().includes(q)),
    );
  });

  return (
    <div class={styles.list} classList={{ [props.class ?? ""]: !!props.class }} data-feature-list>
      <div class={styles.header}>
        <Button size="sm" onClick={() => setDialog({})}>
          New Feature
        </Button>
      </div>
      <Show when={error()}>{(msg) => <p class={styles.error}>{msg()}</p>}</Show>
      <Show
        when={visible().length > 0}
        fallback={
          <div class="tree-empty">
            <Show when={features().length === 0} fallback={<p>No Feature matches the filter.</p>}>
              <p>No Features yet.</p>
              <Button size="sm" variant="ghost" onClick={() => setDialog({})}>
                Create a Feature
              </Button>
            </Show>
          </div>
        }
      >
        <ul class={styles.items}>
          <For each={visible()}>
            {(f) => (
              <FeatureItem
                feature={f}
                spaces={props.spaces}
                active={props.activeId === f.id}
                changed={changedIn(f)}
                onSelect={props.onSelect}
                onRepair={(m, action) => void repair(f, m, action)}
                menu={menu(f)}
                memberMenu={memberMenu(f)}
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
          <NewFeatureDialog
            spaces={props.spaces}
            features={features()}
            feature={req().feature}
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
            onSubmit={(v) => void renameMember(req().feature, req().member, v)}
            onCancel={() => setMemberRenameReq(null)}
          />
        )}
      </Show>

      <Show when={wtReq()}>
        {(req) => (
          <WorktreeRemoveDialog
            label={req().member.displayName}
            path={req().worktreePath}
            branch={req().feature.branch}
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
          <ConfirmDeleteFeature
            featureName={req().feature.name}
            branch={req().feature.branch}
            members={req().members}
            onConfirm={() => void remove(req().feature, req().members)}
            onCancel={() => setDeleteReq(null)}
          />
        )}
      </Show>

      <Show when={sweepReq()}>
        {(req) => (
          <FeatureWorktreeSweepDialog
            featureName={req().feature.name}
            branch={req().feature.branch}
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
