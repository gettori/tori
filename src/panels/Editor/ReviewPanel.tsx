import { createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  emitWith,
  onWith,
  AGENT_FILES_WRITTEN,
  AGENT_WRITE_DEBOUNCE_MS,
  OPEN_IN_EDITOR,
  PR_OPENED,
  TOAST,
  type PrOpened,
  type AgentFilesWritten,
  type ToastEvent,
  type FsChanged,
} from "../../utils/events";
import { debounce } from "../../utils/debounce";
import {
  gitStateFor,
  stagedFiles,
  changedFiles,
  conflictedFiles,
  pushingIn,
  refreshStatus,
  refreshMeta,
  refreshGit,
  stage as stageFiles,
  unstage as unstageFiles,
  commit as commitStaged,
  headMessage,
  push as pushToOrigin,
  type FileStatus,
} from "../../utils/gitActions";
import { amendRewritesPushed, composeCommitMessage, splitCommitMessage } from "../../utils/commitMessage";
import { DIFF_CONTEXT } from "../../utils/diffHunks";
import { copyText } from "../../utils/clipboard";
import { mentionPath } from "../../utils/pathScope";
import { folderActors } from "../../utils/folderActors";
import { revertGuard } from "../../utils/revertGuard";
import { BLOCKED_REASON, requestSend, type SessionTarget } from "../../utils/safeSend";
import { askAgentToResolve } from "../../utils/conflictAsk";
import { sendBlockedReason } from "../../utils/sendTarget";
import { comparePrUrl } from "../../utils/prUrl";
import { composeDraftRequest, prPath } from "../../utils/createPr";
import { forgeErrorMessage, type AuthState, type PullRequest } from "../../utils/forgeTypes";
import { chromeScale, settings } from "../Settings/settingsStore";
import { REPAIR_LABEL, rootOf, type MemberStateSummary } from "../../utils/features";
import MemberChip from "../../components/MemberChip/MemberChip";
import PanelSection from "../../components/PanelSection/PanelSection";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import Dropdown from "../../components/Menu/Dropdown";
import { MenuRow, MenuSeparator } from "../../components/Menu/rows";
import { changesLayout, OPTIONAL_CHANGES_SECTIONS, type ChangesSection } from "../../utils/changesSections";
import type { MemberRoot } from "../../utils/featureMembers";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import CheckpointTimeline, { type RevertOutcome } from "./CheckpointTimeline";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import CreatePrDialog from "../../components/Dialogs/CreatePrDialog";
import Button from "../../components/Button/Button";
import Checkbox from "../../components/Checkbox/Checkbox";
import IconButton from "../../components/IconButton/IconButton";
import Tooltip from "../../components/Tooltip/Tooltip";
import Icon from "../../components/Icon/Icon";
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  FileCode,
  GitBranch,
  GitPullRequestArrow,
  MessageSquarePlus,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-solid";
import { diffTabId, syntheticId } from "../../utils/syntheticTabs";
import styles from "./ReviewPanel.module.css";

/** What `git_discard_hunks` / `git_discard_files` report back: the backstop that
 *  makes the discard undoable, plus the paths that changed on disk. */
type DiscardOutcome = {
  backstop_ts: number;
  restored: string[];
  deleted: string[];
};

/** One `git stash list` entry, as the backend parsed it: `message` is the user's
 *  own text with its colons intact, not the raw `On main: ...` subject. */
type StashEntry = {
  selector: string;
  message: string;
  branch: string | null;
  relative_date: string;
};
type StashOutcome = { restored: string[]; deleted: string[] };

/** One member's worth of the panel: its own file lists, its own branch, its own
 *  stage / commit / push. A branch unit is the one-section case, and the only
 *  one that draws no header, since there is nothing to say whose it is. */
type Section = { root: string; label?: string; tint?: string; state?: MemberStateSummary };

// Same wording as the file tree's section headers: one member, one vocabulary.

// Map a porcelain XY code to a coarse class for the badge color.
function statusClass(status: string): string {
  if (status.includes("?")) return "untracked";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  return "modified";
}

// The include-untracked checkbox's description. A `<label>` cannot take focus,
// so what used to be a `title` on it is a description on the control inside
// instead - see the call site.
const UNTRACKED_HINT_ID = "review-untracked-hint";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

const SECTION_ORDER: ChangesSection[] = ["changes", "stashes", "checkpoints", "graph"];

// Ahead and behind, as a pill. Escaped rather than literal so the source stays
// ASCII.
const UP = "\u2191";
const DOWN = "\u2193";

/** Changes panel: VS Code-style Staged / Changes sections over git_status's
 *  staged/unstaged split, with per-file stage/unstage, a manual commit box,
 *  and an "ask agent to draft" button routed through safe-send. A row opens the
 *  file's diff as an editor tab (`diffTabId`), where the hunk-level staging and
 *  the per-hunk "Comment" affordance live.
 *
 *  The file list, branch and ahead/behind are read from the shared store in
 *  `utils/gitActions`, not fetched here: this panel is unmounted whenever the
 *  right pane shows anything else, and the command palette's git entries have to
 *  answer the same questions with it closed. Staging from either surface
 *  therefore moves the other. What is still local (the stash list, the PR base
 *  branch) is state only a mounted panel has any use for. */
export default function ReviewPanel(props: {
  root: string | null;
  /** The Feature's members, in member order. Absent for a branch unit, which is
   *  the single-section case. Same list the file tree and search panel take. */
  roots?: MemberRoot[];
  /** The active editor tab's path, which is what "the member you are working
   *  in" means when nothing has been chosen by hand. */
  activePath?: string | null;
  selected: Selection | null;
  onReverted?: (outcome: RevertOutcome) => void;
  onRepair?: (path: string) => void;
}) {
  const [commitSubject, setCommitSubject] = createSignal("");
  const [commitBody, setCommitBody] = createSignal("");
  const [amend, setAmend] = createSignal(false);
  // What was typed before amend prefilled HEAD's message over it, so toggling
  // amend off gives it back rather than leaving HEAD's wording behind.
  const [preAmendDraft, setPreAmendDraft] = createSignal<{ subject: string; body: string } | null>(null);
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  const [committing, setCommitting] = createSignal(false);
  const [drafting, setDrafting] = createSignal(false);
  // The conflicted paths currently being handed to the agent. A set rather than
  // one path, so each row's button reports its own request: two conflicted files
  // are two questions, and neither should be waiting on the other.
  const [asking, setAsking] = createSignal<ReadonlySet<string>>(new Set());
  const [origin, setOrigin] = createSignal<string | null>(null);
  const [baseBranch, setBaseBranch] = createSignal<string | null>(null);
  const [openingPr, setOpeningPr] = createSignal(false);
  // The in-app create-PR form. Only reachable on a signed-in github.com remote;
  // every other case still opens the provider's compare page (see `prPath`).
  const [prForm, setPrForm] = createSignal(false);
  const [prTitle, setPrTitle] = createSignal("");
  const [prBody, setPrBody] = createSignal("");
  // The form's own base, seeded from the repo default when the form opens.
  // Separate from `baseBranch` on purpose: that one is what
  // `git_default_base_branch` reported, and the compare-URL fallback reads it
  // too, so letting the dialog write to it would leave a cancelled edit
  // retargeting the compare page.
  const [prBase, setPrBase] = createSignal("");
  const [prDrafting, setPrDrafting] = createSignal(false);
  const [authState, setAuthState] = createSignal<AuthState>({ kind: "signedOut" });
  const [applying, setApplying] = createSignal(false);
  const [stashes, setStashes] = createSignal<StashEntry[]>([]);
  const [includeUntracked, setIncludeUntracked] = createSignal(false);

  // One section per member inside a Feature, one unnamed section for a branch
  // unit. Member order, which is the order the tree and the search panel draw
  // them in, so the three surfaces agree about what "second member" means.
  const sections = createMemo<Section[]>(() =>
    props.roots?.length
      ? props.roots.map((m) => ({ root: m.path, label: m.label, tint: m.tint, state: m.state }))
      : props.root
        ? [{ root: props.root }]
        : [],
  );
  /** Whether sections carry a header. Only a Feature's do: with one root on
   *  screen there is nothing for a header to distinguish it from. */
  const headed = () => !!props.roots?.length;
  const anyFiles = () => sections().some((s) => gitStateFor(s.root).files.length);

  // The header bar, the PR paths and the stash list are all one-repo surfaces,
  // and the repo they are about is the member in front.
  const branch = () => gitStateFor(props.root).branch;
  const aheadBehind = () => gitStateFor(props.root).aheadBehind;

  // Which member the commit box, its draft request and the timeline are about.
  //
  // Chosen by hand where a section's Commit button was clicked, and that choice
  // sticks: it is the one thing on screen saying which repo the message lands
  // in, so having it move under you would be worse than having to click again.
  // Otherwise the member holding the file in front, which is the one whose
  // changes you are looking at; the member in front is the fallback, and the
  // only answer a branch unit has.
  const [commitTarget, setCommitTarget] = createSignal<string | null>(null);
  const targetMember = () =>
    commitTarget() ?? rootOf(props.activePath, sections().map((s) => s.root)) ?? props.root;

  /** Members the chips have been unticked for. A set of exclusions rather than
   *  of choices, so a member that stages something later joins the commit
   *  instead of being silently left out of one made before it had changes. */
  const [unticked, setUnticked] = createSignal<ReadonlySet<string>>(new Set());
  const memberRoots = () => sections().map((s) => s.root);
  const stagedRoots = () => memberRoots().filter((r) => stagedFiles(r).length);

  /**
   * Where Commit lands.
   *
   * A Feature is one branch across N repos, so a change that touched three of
   * them is one message in each rather than three trips through the composer.
   * Amend is the exception and takes exactly one member: the composer is
   * prefilled from that member's HEAD, and rewriting several repos' last
   * commits to one message would be a different operation wearing this one's
   * button.
   */
  const commitRoots = () => {
    if (amend()) {
      const one = targetMember();
      return one ? [one] : [];
    }
    const out = stagedRoots().filter((r) => !unticked().has(r));
    return out;
  };
  const commitStagedFiles = () => commitRoots().flatMap((r) => stagedFiles(r));

  function target(): SessionTarget | null {
    const sel = props.selected;
    if (!sel?.sessionId) return null;
    return {
      sessionId: sel.sessionId,
      agent: sel.agent ?? "claude",
      profile: sel.profile,
      folderPath: sel.folderPath,
      sessionCwd: sel.sessionCwd,
      sessionPath: sel.sessionPath,
      sessionTitle: sel.sessionTitle,
      sessionFile: sel.sessionFile,
    };
  }

  // Capability gate: no session selected, an adapter that can't be resumed
  // (empty resume_args - ADAPTERS.md), or an agent this install does not offer,
  // so safe-send has nowhere to land a queued comment or draft request. The
  // shared gate, so the three panels asking it cannot word it three ways.
  const disabledReason = () => sendBlockedReason(props.selected ?? null);

  // Header state. Branch and ahead/behind live in the shared store (the palette
  // needs them too); origin and the PR base branch stay here, since nothing
  // outside the "Open PR" button has ever asked for them.
  async function refreshHeader() {
    const root = props.root;
    if (!root) {
      setOrigin(null);
      setBaseBranch(null);
      return;
    }
    await refreshMeta(root);
    try {
      setOrigin(await invoke<string | null>("git_origin", { projectPath: root }));
    } catch {
      setOrigin(null);
    }
    // Read alongside the base branch rather than once at mount: signing in from
    // Settings must change what "Open PR" does without a restart, and this
    // already runs whenever the panel's project changes or the tree refreshes.
    try {
      setAuthState(await invoke<AuthState>("github_auth_state"));
    } catch {
      setAuthState({ kind: "signedOut" });
    }
    try {
      setBaseBranch(await invoke<string | null>("git_default_base_branch", { projectPath: root }));
    } catch {
      setBaseBranch(null);
    }
  }

  // Every section, not just the member in front: this runs on window focus and
  // after a revert, and a commit made in a background member from a terminal
  // has no other way in (`.git` is watcher-filtered).
  async function refreshAll() {
    await Promise.all([...sections().map((s) => refreshGit(s.root)), refreshHeader(), loadStashes()]);
  }

  function toastError(e: unknown) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }

  async function stage(root: string, path: string) {
    await stageFiles(root, [path]);
  }

  async function unstage(root: string, path: string) {
    await unstageFiles(root, [path]);
  }

  /** Stage everything this member has, conflicts excluded: git refuses `add` on
   *  an unmerged path, so including them would fail the whole call. */
  async function stageAll(root: string) {
    const paths = changedFiles(root).map((f) => f.path);
    if (paths.length) await stageFiles(root, paths);
  }

  /** Unstage everything this member has in the index. */
  async function unstageAll(root: string | null) {
    if (!root) return;
    const paths = stagedFiles(root).map((f) => f.path);
    if (paths.length) await unstageFiles(root, paths);
  }

  /** Throw away every unstaged change in this member. Guarded, unlike a single
   *  hunk: this one rewrites files across the whole worktree. */
  async function discardAllChanges(root: string | null) {
    if (!root) return;
    const files = changedFiles(root).map((f) => f.path);
    if (!files.length) return;
    await busy(() =>
      guarded("Discard", root, async () => {
        const ok = await askConfirm({
          title: `Discard changes to ${plural(files.length, "file")}?`,
          message:
            "Every unstaged change in this repo goes back to how it is staged. Anything already staged is kept.\n\nSway saves a snapshot first, so you can bring it back from Undo history in the timeline.",
          confirmLabel: "Discard changes",
          danger: true,
        });
        if (!ok) return;
        const outcome = await invoke<DiscardOutcome>("git_discard_files", {
          projectPath: root,
          files,
        });
        reportDiscarded(outcome);
        await refreshStatus(root);
      }),
    );
  }

  /** Ask the remote what it has. The answer arrives as `git://fetch-done`,
   *  which `refreshAll` is already listening for. */
  async function fetchRemote(root: string | null) {
    if (!root) return;
    try {
      await invoke("git_fetch", { repo: root });
    } catch (e) {
      toastError(e);
    }
  }

  /** Whether this member has somewhere to push and something to push there. */
  function canPushIn(root: string | null): boolean {
    if (!root || pushingIn(root)) return false;
    const ab = gitStateFor(root).aheadBehind;
    if (!ab) return false;
    return !ab.has_upstream || ab.ahead > 0;
  }

  function pushMember(root: string | null) {
    if (!root) return;
    const branchName = gitStateFor(root).branch;
    if (branchName) void pushToOrigin(root, branchName);
  }

  /** Point the commit box at a member and put the cursor in it, so the click
   *  that chose the member is also the click that starts the message. */
  function commitIn(root: string) {
    setCommitTarget(root);
    subjectRef?.focus();
  }

  /** Amend is the one form that needs nothing staged: rewriting only the
   *  message is a normal thing to want. Everything else still does. */
  const canCommit = () => !!commitSubject().trim() && !!commitRoots().length;

  /** Every member's changed and staged rows, for the section's count badge. */
  const totalChanged = () =>
    sections().reduce(
      (n, sec) =>
        n +
        changedFiles(sec.root).length +
        stagedFiles(sec.root).length +
        conflictedFiles(sec.root).length,
      0,
    );

  /** The button says how many repos it is about, because inside a Feature one
   *  click can land in several and the count is the only warning of that. */
  const commitLabel = () => {
    const n = commitRoots().length;
    const verb = amend() ? "Amend" : "Commit";
    return n > 1 ? `${verb} in ${n} repos` : verb;
  };
  const commitLabelHint = () => {
    const roots = commitRoots();
    if (roots.length <= 1) return "Commit staged changes";
    const names = roots.map((r) => sections().find((x) => x.root === r)?.label ?? r);
    return `Commit the same message in ${names.join(", ")}`;
  };

  function askConfirm(opts: Omit<ConfirmReq, "resolve">): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }

  async function commit(thenPush = false) {
    const roots = commitRoots();
    const message = composeCommitMessage(commitSubject(), commitBody());
    if (!roots.length || !message || committing() || !canCommit()) return;
    // Held across the confirm too, not just the invoke: the dialog is awaited,
    // and an enabled button behind it would let a second click open a second
    // dialog, orphaning the first one's promise and committing twice.
    setCommitting(true);
    try {
      // Amending a commit the upstream already has rewrites shared history. The
      // check reads the remote-tracking ref, which is only as fresh as the last
      // fetch, so it asks rather than refuses - and says so, since a stale ref
      // is the reason to trust your own judgement over this warning.
      //
      // Each member's own numbers, not the panel's: amending in a background
      // member has to warn about that member's upstream. Amend is one member by
      // construction, so this asks at most once.
      if (amend() && roots.some((r) => amendRewritesPushed(gitStateFor(r).aheadBehind))) {
        const ok = await askConfirm({
          title: "Amend a pushed commit?",
          message:
            "This commit looks like it is already on the upstream, so amending rewrites history others may have. That reading is only as fresh as your last fetch.",
          confirmLabel: "Amend anyway",
          danger: true,
        });
        if (!ok) return;
      }
      // One at a time rather than in parallel: each write takes that repo's
      // lock, and a failure part-way through has to leave the repos behind it
      // untouched rather than half-committed under a message the user can no
      // longer see.
      const landed: string[] = [];
      for (const root of roots) {
        if (!(await commitStaged(root, message, amend()))) break;
        landed.push(root);
      }
      // Cleared only when every repo took it, so a rejected commit (an empty
      // author, a failing hook) does not also lose what you typed.
      if (landed.length === roots.length) {
        setCommitSubject("");
        setCommitBody("");
        setPreAmendDraft(null);
        setAmend(false);
        setUnticked(new Set<string>());
      }
      if (thenPush) {
        for (const root of landed) {
          const branchName = gitStateFor(root).branch;
          if (branchName) void pushToOrigin(root, branchName);
        }
      }
    } finally {
      setCommitting(false);
    }
  }

  /** Toggling amend on prefills HEAD's message (stashing whatever was typed);
   *  toggling it back off restores that draft. */
  async function toggleAmend(on: boolean) {
    const root = targetMember();
    setAmend(on);
    if (!on) {
      const saved = preAmendDraft();
      setCommitSubject(saved?.subject ?? "");
      setCommitBody(saved?.body ?? "");
      setPreAmendDraft(null);
      return;
    }
    setPreAmendDraft({ subject: commitSubject(), body: commitBody() });
    if (!root) return;
    const { subject, body } = splitCommitMessage(await headMessage(root));
    // A late answer must not overwrite a toggle-off that happened meanwhile.
    if (!amend()) return;
    setCommitSubject(subject);
    setCommitBody(body);
  }

  // Routes a draft request naming the currently staged files through
  // safe-send, sharing its capability gate and insert-only behavior - the
  // agent proposes a commit message at its own prompt, unsubmitted.
  async function askAgentToDraft() {
    const t = target();
    // The first repo the commit lands in. Naming every member's files would
    // make the request about a diff no single checkout holds.
    const root = commitRoots()[0] ?? targetMember();
    const paths = root ? stagedFiles(root).map((f) => f.path) : [];
    if (!t || !root || disabledReason() || !paths.length || drafting()) return;
    setDrafting(true);
    // Named against the session's own cwd, the same rule every other mention
    // follows: relative while the agent is running in this member, absolute
    // when the message is about the member next door. Not by rewriting the
    // target's cwd, which would claim the session moved when it did not.
    const cwd = t.sessionCwd || t.folderPath;
    const named = paths.map((rel) => mentionPath(`${root.replace(/\/+$/, "")}/${rel}`, cwd));
    const text = `Draft a commit message for the staged changes: ${named.join(", ")}`;
    const result = await requestSend({ ...t, text });
    setDrafting(false);
    if (result.kind === "timeout") {
      emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
    }
  }

  // The Conflicts row's half of "ask agent to resolve" (phase 13). The banner
  // over the buffer offers the same thing, and both go through the one composer
  // in conflictAsk.ts so they ask for the same file in the same words.
  //
  // The refusal is a toast rather than a silent no-op: the button is disabled
  // for the same reason, but a disabled button that never says why is how the
  // capability gate reads as a broken control.
  async function askToResolve(root: string, file: string) {
    const t = target();
    const reason = disabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return;
    }
    if (!t || asking().has(file)) return;
    setAsking((prev) => new Set(prev).add(file));
    try {
      await askAgentToResolve(t, root, file);
    } finally {
      setAsking((prev) => {
        const next = new Set(prev);
        next.delete(file);
        return next;
      });
    }
  }

  /** The file's whole patch against HEAD, which is what Copy hands over: the
   *  two halves of a partially staged file are the diff tab's business. */
  async function fileDiff(root: string, path: string): Promise<string> {
    try {
      return await invoke<string>("git_diff_text", {
        projectPath: root,
        file: path,
        context: DIFF_CONTEXT,
      });
    } catch {
      return "";
    }
  }

  /** Run `action` only once no other session is mid-turn in this worktree.
   *
   *  Shared by whole-file discard and every stash action, because they share the
   *  hazard: each rewrites files across the whole worktree, so an agent mid-turn
   *  here can have its work clobbered or clobber the change a moment later. Two
   *  tiers, the same as a tree revert: a session verifiably Executing blocks
   *  hard, one Sway cannot see inside is overridable. `verb` names the action in
   *  the override, so the question reads as itself rather than as a revert. */
  async function guarded(verb: string, root: string, action: () => Promise<void>) {
    const candidates = await folderActors(root);
    const verdict = revertGuard(candidates, { folderPath: root });
    if (!verdict.allow) {
      if (!verdict.overridable) {
        toastError(verdict.reason);
        return;
      }
      const go = await askConfirm({
        title: "Another session may be running here",
        message: `${verdict.reason}\n\n${verb} anyway?`,
        confirmLabel: `${verb} anyway`,
        danger: true,
      });
      if (!go) return;
      if (!revertGuard(candidates, { folderPath: root, allowDetached: true }).allow) return;
    }
    await action();
  }

  /** Hold the busy flag across everything, confirms included.
   *
   *  Setting it only around the invoke would leave the buttons live behind the
   *  modal, and the confirm dialog is a singleton: a second click replaces the
   *  pending question instead of queueing, so you answer about one thing
   *  believing you answered about another. */
  async function busy(action: () => Promise<void>) {
    if (applying()) return;
    setApplying(true);
    try {
      await action();
    } catch (e) {
      toastError(e);
    } finally {
      setApplying(false);
    }
  }

  /** Throw away every unstaged change to a whole file.
   *
   *  Unscoped in the sense the revert guard cares about: an agent mid-turn in
   *  this folder may be writing the very file about to be rolled back. */
  async function discardFile(root: string, path: string, untracked: boolean) {
    await busy(() =>
      guarded("Discard", root, async () => {
        const ok = await askConfirm({
          title: untracked ? `Delete ${path}?` : `Discard changes to ${path}?`,
          message: untracked
            ? `1 file is deleted. It was never committed, so git has no copy of it.\n\nSway saves a snapshot first, so you can bring it back from Undo history in the timeline.`
            : `1 file goes back to how it is staged. Unstaged changes to it are lost; anything already staged is kept.\n\nSway saves a snapshot first, so you can bring it back from Undo history in the timeline.`,
          confirmLabel: untracked ? "Delete file" : "Discard changes",
          danger: true,
        });
        if (!ok) return;

        const outcome = await invoke<DiscardOutcome>("git_discard_files", {
          projectPath: root,
          files: [path],
        });
        reportDiscarded(outcome);
        await refreshStatus(root);
      }),
    );
  }

  // --- stash ---------------------------------------------------------------

  /** Stash the working tree.
   *
   *  The Summary field doubles as the stash name when it has something in it: a
   *  stash you meant to come back to needs a label, and "WIP on main" is not
   *  one. Left empty, git writes its own subject, same as `git stash` alone. */
  async function stashAll() {
    const root = props.root;
    if (!root) return;
    await busy(() =>
      guarded("Stash", root, async () => {
        const created = await invoke<boolean>("git_stash_push", {
          projectPath: root,
          message: commitSubject().trim() || null,
          includeUntracked: includeUntracked(),
        });
        if (!created) {
          // git exits 0 on a clean tree, so silence here would read as success.
          emitWith<ToastEvent>(TOAST, { message: "Nothing to stash.", kind: "info" });
          return;
        }
        // Both fields, not just the subject: the draft described the work that
        // has now moved into the stash, and a body left behind would attach
        // itself to whatever gets committed next.
        setCommitSubject("");
        setCommitBody("");
        await Promise.all([refreshStatus(root), loadStashes()]);
      }),
    );
  }

  async function applyStash(entry: StashEntry, pop: boolean) {
    const root = props.root;
    if (!root) return;
    await busy(() =>
      guarded(pop ? "Pop" : "Apply", root, async () => {
        const outcome = await invoke<StashOutcome>("git_stash_apply", {
          projectPath: root,
          selector: entry.selector,
          pop,
        });
        // Same channel discard and checkpoint revert use: a stash laid back down
        // over an open buffer must offer Reload / Keep mine, not lose a side.
        props.onReverted?.({ backstop_ts: null, ...outcome });
        await Promise.all([refreshStatus(root), loadStashes()]);
      }),
    );
  }

  /** Drop a stash. The one action here with no way back: the entry is not in the
   *  working tree, so no snapshot of that tree contains it. The confirm says so
   *  rather than implying the safety net the discard dialogs can promise. */
  async function dropStash(entry: StashEntry) {
    const root = props.root;
    if (!root) return;
    await busy(() =>
      guarded("Drop", root, async () => {
        const ok = await askConfirm({
          title: "Drop this stash?",
          message: `"${entry.message}" is deleted. Unlike discarding a change, this cannot be undone from the timeline: a stash is not part of the working tree, so no snapshot of it holds a copy.`,
          confirmLabel: "Drop stash",
          danger: true,
        });
        if (!ok) return;
        await invoke("git_stash_drop", { projectPath: root, selector: entry.selector });
        await loadStashes();
      }),
    );
  }

  async function loadStashes() {
    const root = props.root;
    if (!root) {
      setStashes([]);
      return;
    }
    const list = await invoke<StashEntry[]>("git_stash_list", { projectPath: root }).catch(() => []);
    setStashes(Array.isArray(list) ? list : []);
  }

  /** Tell the editor which files just changed underneath it.
   *
   *  The same channel a checkpoint revert uses (`handleReverted` in Editor.tsx),
   *  so a buffer open on a discarded file offers keep-mine / take-disk instead
   *  of quietly writing the discarded content back on the next save. */
  function reportDiscarded(outcome: DiscardOutcome) {
    props.onReverted?.({
      backstop_ts: outcome.backstop_ts,
      restored: outcome.restored,
      deleted: outcome.deleted,
    });
  }

  // Copies the file's unified patch. Fetched fresh rather than read off the
  // expanded diff, so the action works from a collapsed row too.
  async function copyDiff(root: string, path: string) {
    const text = await fileDiff(root, path);
    if (!text) {
      emitWith<ToastEvent>(TOAST, { message: "No diff to copy.", kind: "error" });
      return;
    }
    const ok = await copyText(text);
    emitWith<ToastEvent>(TOAST, {
      message: ok ? `Copied diff for ${path}` : "Couldn't copy to the clipboard.",
      kind: ok ? "info" : "error",
    });
  }

  function openFile(root: string, path: string) {
    emitWith(OPEN_IN_EDITOR, { path: `${root}/${path}` });
  }

  // Keyed on the member set rather than the member in front: moving between
  // members inside a Feature leaves every section's numbers standing, so
  // re-reading all of them would be a switch that did not happen. A repaired
  // member joining is a real one.
  createEffect(
    on(
      () => sections().map((s) => s.root).join("\n"),
      () => {
        setCommitTarget(null);
        refreshAll();
      },
    ),
  );

  // "Open PR": one button, three paths. A signed-in github.com remote opens the
  // in-app form; anything else (another provider, GitHub Enterprise, signed out,
  // or the integration switched off) still pushes and opens the provider's own
  // compare page, exactly as it did before the API existed. The decision lives
  // in `prPath` so the button and the submit cannot disagree about it.
  async function openPr() {
    const org = origin();
    if (openingPr()) return;
    if (prPath(org, authState(), settings.github.enabled) === "form") {
      setPrTitle("");
      setPrBody("");
      setPrBase(baseBranch() ?? "");
      setPrForm(true);
      return;
    }
    await openCompare();
  }

  // The unauthenticated path, unchanged: push first if the branch is unpushed or
  // ahead, then open the provider's compare/new-MR/new-PR page for branch -> base.
  async function openCompare() {
    const root = props.root;
    const branchName = branch();
    const org = origin();
    const base = baseBranch();
    if (!root || !branchName || !org || !base) return;
    const url = comparePrUrl(org, base, branchName);
    if (!url) {
      toastError("This origin isn't a recognized GitHub/GitLab/Bitbucket host.");
      return;
    }
    setOpeningPr(true);
    const ab = aheadBehind();
    const needsPush = !ab || !ab.has_upstream || ab.ahead > 0;
    if (needsPush && !(await pushToOrigin(root, branchName))) {
      setOpeningPr(false);
      return;
    }
    setOpeningPr(false);
    window.open(url, "_blank");
  }

  // Asks the agent for a title and body, through the same safe-send gate the
  // commit-message draft uses. Insert-only: the agent proposes at its own
  // prompt, unsubmitted, and the user copies what they want into the form.
  async function askAgentToDraftPr() {
    const t = target();
    const branchName = branch();
    // The form's base, not the repo default: a title for "wave-3 into main" is
    // a different sentence from one for "wave-3 into release".
    const base = prBase();
    if (!t || disabledReason() || !branchName || !base || prDrafting()) return;
    setPrDrafting(true);
    const paths = [...stagedFiles(props.root), ...changedFiles(props.root)].map((f) => f.path);
    const result = await requestSend({ ...t, text: composeDraftRequest(branchName, base, paths) });
    setPrDrafting(false);
    // A blocked session is refused outright rather than queued: the user has to
    // answer that permission prompt first, and saying so is the difference
    // between a gate and a button that silently did nothing.
    if (result.kind === "blocked") {
      emitWith<ToastEvent>(TOAST, { message: BLOCKED_REASON, kind: "error" });
    } else if (result.kind === "timeout") {
      emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
    }
  }

  // Pushes, then creates. Always through the push-then-create command rather
  // than checking ahead/behind first: an up-to-date push is a no-op, while a
  // stale ahead/behind reading would open a PR against a head the remote has
  // never seen.
  async function submitPr(opts: { draft: boolean }) {
    const root = props.root;
    const branchName = branch();
    const base = prBase().trim();
    if (!root || !branchName || !base || openingPr()) return;
    setOpeningPr(true);
    try {
      const pr = await invoke<PullRequest>("github_push_and_create_pr", {
        projectPath: root,
        remote: "origin",
        newPr: {
          title: prTitle().trim(),
          body: prBody().trim(),
          head: branchName,
          base,
          draft: opts.draft,
        },
      });
      setPrForm(false);
      emitWith<ToastEvent>(TOAST, { message: `Opened #${pr.number}`, kind: "info" });
      // The Pull Requests panel holds its own listing, so the write-through that
      // makes the sidebar chip flip does not reach it. Without this the PR the
      // user just opened is absent from the list until they hit Refresh.
      emitWith<PrOpened>(PR_OPENED, { projectPath: root });
      await refreshMeta(root);
    } catch (e) {
      // The form stays open with the typed title and body intact: most of these
      // failures are fixable in place (a base that does not exist, a PR that is
      // already open), and losing the description to retype it is its own insult.
      // `forgeErrorMessage` because a rejected forge command hands back an
      // object, which `String(e)` would render as "[object Object]".
      emitWith<ToastEvent>(TOAST, { message: forgeErrorMessage(e), kind: "error" });
    } finally {
      setOpeningPr(false);
    }
  }

  let unlistenFs: UnlistenFn | undefined;
  let offAgentWrites: (() => void) | undefined;
  const agentWritten = new Set<string>();
  const flushAgentWrites = debounce(() => {
    agentWritten.clear();
    // Ahead of the watcher's own debounce, so this one still drives the status
    // read; it names no root, so every section takes it.
    for (const s of sections()) void refreshStatus(s.root);
  }, AGENT_WRITE_DEBOUNCE_MS);
  let unlistenFetchDone: UnlistenFn | undefined;
  let unlistenFetchError: UnlistenFn | undefined;
  onMount(async () => {
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      const from = e.payload.root;
      // The status refresh is the store's now (`startGitWatch`), so that it
      // happens with this panel closed and for every member at once. The stash
      // list is the one thing left that only a mounted panel holds.
      //
      // A `git stash` run in a terminal shows up as a working-tree burst like
      // any other, and the entry it created would otherwise stay invisible
      // until a fetch or a window focus. Reading the stash reflog is cheap.
      if (!from || from === props.root) void loadStashes();
    });
    // A chat session's own report of what it just wrote, ahead of the watcher's
    // debounce. Same two refreshes the watcher drives, and both are re-entrant,
    // so the echo that follows is a second read rather than a second opinion.
    //
    // Debounced, because this event is per tool call where the watcher's is per
    // burst: a turn making fifty edits would otherwise run fifty `git status`
    // refreshes. Shorter than the watcher's own window so the panel still moves
    // well inside the budget, long enough that a burst collapses into one. The
    // paths accumulate across the window rather than the last event winning,
    // or an edit to the open file early in a burst would lose its refresh.
    offAgentWrites = onWith<AgentFilesWritten>(AGENT_FILES_WRITTEN, ({ paths }) => {
      for (const p of paths) agentWritten.add(p);
      flushAgentWrites();
    });
    // .git is watcher-filtered (gotchas), so a terminal-side commit/stage/push
    // emits no fs://changed - window focus and the askpass-bridge git events
    // (fetch here, push above) pick up the slack.
    unlistenFetchDone = await listen("git://fetch-done", () => refreshAll());
    unlistenFetchError = await listen("git://fetch-error", () => refreshAll());
    window.addEventListener("focus", refreshAll);
  });
  onCleanup(() => {
    unlistenFs?.();
    offAgentWrites?.();
    unlistenFetchDone?.();
    unlistenFetchError?.();
    window.removeEventListener("focus", refreshAll);
  });

  /** A conflicted file's row: open the three-way view, or hand the conflict to
   *  the agent.
   *
   *  Deliberately not `row()` with the buttons hidden. Every control there acts
   *  on one version of the file, and an unmerged path has three; git refuses
   *  stage, unstage and discard on it alike. The two things that do make sense
   *  on an unmerged path are reading it and delegating it.
   *
   *  It opens the three-way view rather than the file. The file on disk is
   *  git's marker-riddled attempt at a merge; the three versions behind it are
   *  what the reader has to choose between, and going via the file means
   *  finding the banner and clicking again.
   *
   *  A `<button>` rather than the `<div onClick>` its siblings are: opening the
   *  view is the row's main action, so a div would make the whole section
   *  mouse-only, which is the reason the commit views' rows are buttons too.
   *  The ask sits *beside* it rather than inside it, because a button nested in
   *  a button is neither valid nor clickable in its own right. */
  function conflictRow(f: FileStatus, root: string) {
    return (
      <div class={styles.conflictRowWrap}>
        <Tooltip
          as="button"
          type="button"
          class={`${styles.reviewRow} ${styles.conflictRow}`}
          onClick={() => emitWith(OPEN_IN_EDITOR, { path: syntheticId("conflict", root, f.path) })}
          label={f.path}
        >
          <span class={`${styles.reviewStatus} ${styles.conflicted}`}>{f.status.trim() || "U"}</span>
          <span class={styles.reviewName}>{f.path}</span>
        </Tooltip>
        <Button
          size="xs"
          variant="ghost"
          class={styles.askButton}
          disabled={!!disabledReason() || asking().has(f.path)}
          // `disabledReason()` IS the reason it is greyed out, so it has to stay
          // reachable while it is.
          tooltipWhenDisabled
          tooltip={disabledReason() ?? "Ask the selected session to resolve this conflict"}
          onClick={() => askToResolve(root, f.path)}
        >
          Ask agent
        </Button>
      </div>
    );
  }

  /** One changed file. VS Code's shape: the name, its folder dimmed beside it,
   *  the hover actions, then the status letter last, so a column of letters
   *  lines up down the right edge whatever the names are doing. */
  function row(f: FileStatus, opts: { staged: boolean; root: string }) {
    const untracked = () => f.status.includes("?");
    return (
      <div
        class={styles.reviewRow}
        // The two rows of a partially staged file open two tabs: they are
        // different comparisons, so one tab could only ever show one of them.
        onClick={() => emitWith(OPEN_IN_EDITOR, { path: diffTabId(opts.root, f.path, opts.staged) })}
        title={f.path}
      >
        <span class={styles.reviewName}>
          {/* A rename names both halves. Only `f.path` is clickable-through to
              a file; the source is gone from the worktree by definition. */}
          <Show when={f.orig_path}>
            <span class={styles.renameFrom}>{f.orig_path} -&gt; </span>
          </Show>
          {baseName(f.path)}
        </span>
        <Show when={dirName(f.path)}>
          <span class={styles.reviewDir}>{dirName(f.path)}</span>
        </Show>
        <span class={styles.rowEnd}>
          <IconButton
            size="xs"
            icon={<Icon icon={FileCode} />}
            aria-label="Open file"
            tooltip="Open the file itself"
            onClick={(e) => {
              e.stopPropagation();
              openFile(opts.root, f.path);
            }}
          />
          <IconButton
            size="xs"
            icon={<Icon icon={Copy} />}
            aria-label="Copy diff"
            tooltip="Copy diff"
            onClick={(e) => {
              e.stopPropagation();
              void copyDiff(opts.root, f.path);
            }}
          />
          {/* Unstaged rows only. A staged file's changes are safe in the index,
              so there is nothing here to destroy; unstage it and the row moves
              down to where discard lives. */}
          <Show when={!opts.staged}>
            <IconButton
              size="xs"
              icon={<Icon icon={Undo2} />}
              disabled={applying()}
              aria-label={untracked() ? "Delete" : "Discard"}
              tooltip={
                untracked()
                  ? "Delete this file (it was never committed)"
                  : "Throw away the unstaged changes to this file"
              }
              onClick={(e) => {
                e.stopPropagation();
                void discardFile(opts.root, f.path, untracked());
              }}
            />
          </Show>
          <IconButton
            size="xs"
            icon={<Icon icon={opts.staged ? Minus : Plus} />}
            aria-label={opts.staged ? "Unstage" : "Stage"}
            tooltip={opts.staged ? "Unstage" : "Stage"}
            onClick={(e) => {
              e.stopPropagation();
              void (opts.staged ? unstage(opts.root, f.path) : stage(opts.root, f.path));
            }}
          />
        </span>
        <span class={`${styles.reviewStatus} ${styles[statusClass(f.status)]}`}>
          {f.status.trim() || "?"}
        </span>
      </div>
    );
  }

  /** A member's header: whose section this is, where its branch stands, and the
   *  two things you do to one repo. A member that cannot be opened says so here
   *  and offers its repair instead of a file list.
   *
   *  The branch name is not repeated here. A Feature checks one branch out in
   *  every member, so the top row names it once for all of them; what differs
   *  per member, and stays, is how far ahead that checkout is. */
  function memberHeader(sec: Section) {
    const meta = () => gitStateFor(sec.root);
    const usable = () => sec.state?.usable !== false;
    return (
      <div class={styles.memberHeader}>
        <MemberChip
          member={{ displayName: sec.label ?? "", repoPath: sec.root }}
          tint={sec.tint}
          data-chip={sec.root}
          decorative
        />
        <span class={styles.memberName}>{sec.label}</span>
        <Show
          when={usable()}
          fallback={
            <>
              {/* The reason reads out rather than hiding in a `title`: this is
                  the only account of why a member has no changes to show. */}
              <span class={styles.stateBadge}>
                {sec.state?.reason ? `${sec.state.label}: ${sec.state.reason}` : sec.state?.label}
              </span>
              <Show when={sec.state?.action}>
                {(action) => (
                  <Button size="xs" variant="ghost" data-repair={sec.root} onClick={() => props.onRepair?.(sec.root)}>
                    {REPAIR_LABEL[action()]}
                  </Button>
                )}
              </Show>
            </>
          }
        >
          <Show when={meta().aheadBehind}>
            {(ab) => (
              <Tooltip
                as="button"
                type="button"
                class={styles.aheadPill}
                disabled={!canPushIn(sec.root)}
                label={ab().has_upstream ? "Push" : "Push (sets upstream)"}
                onClick={() => pushMember(sec.root)}
              >
                {pushingIn(sec.root)
                  ? "Pushing"
                  : ab().has_upstream
                    ? `${UP}${ab().ahead} ${DOWN}${ab().behind}`
                    : "Unpushed"}
              </Tooltip>
            )}
          </Show>
          <span class={styles.rowEnd}>
            <IconButton
              size="xs"
              icon={<Icon icon={Plus} />}
              disabled={applying() || !changedFiles(sec.root).length}
              aria-label="Stage all"
              tooltip="Stage every change in this member"
              onClick={() => void stageAll(sec.root)}
            />
            <IconButton
              size="xs"
              icon={<Icon icon={MessageSquarePlus} />}
              // Named apart from the composer's own Commit: they are two
              // controls a word apart, and only one of them commits anything.
              aria-label={`Commit in ${sec.label}`}
              tooltip="Point the commit box at this member"
              onClick={() => commitIn(sec.root)}
            />
          </span>
        </Show>
      </div>
    );
  }

  /** One member's three lists. Empty ones draw nothing, as they always have. */
  function sectionLists(sec: Section) {
    return (
      <>
        {/* First, because nothing below it can be finished until these are:
            git refuses to commit with unmerged paths in the index. */}
        <Show when={conflictedFiles(sec.root).length}>
          <div class={styles.groupHeader}>Conflicts</div>
          <For each={conflictedFiles(sec.root)}>{(f) => conflictRow(f, sec.root)}</For>
        </Show>
        <Show when={stagedFiles(sec.root).length}>
          <div class={styles.groupHeader}>Staged Changes</div>
          <For each={stagedFiles(sec.root)}>{(f) => row(f, { staged: true, root: sec.root })}</For>
        </Show>
        <Show when={changedFiles(sec.root).length}>
          <div class={styles.groupHeader}>Changes</div>
          <For each={changedFiles(sec.root)}>{(f) => row(f, { staged: false, root: sec.root })}</For>
        </Show>
      </>
    );
  }

  let subjectRef: HTMLInputElement | undefined;

  const shown = changesLayout.shown;
  const filler = () => {
    if (changesLayout.open("changes")) return "changes";
    const open = SECTION_ORDER.filter((s) => shown(s) && changesLayout.open(s));
    return open[open.length - 1];
  };
  let stackEl: HTMLDivElement | undefined;
  // Room for the fill section's header plus a few rows, whatever is dragged.
  const maxH = () => (stackEl?.clientHeight ?? 0) - 120 * chromeScale();

  /** The one-repo actions the dots offer. Inside a Feature they act on the
   *  member the composer is pointed at, which is the member whose chip is lit
   *  and whose branch the header names. */
  const menuRoot = () => commitRoots()[0] ?? targetMember();

  const menu = () => (
    <>
      <MenuRow
        disabled={applying() || !changedFiles(menuRoot()).length}
        onClick={() => void stageAll(menuRoot())}
      >
        Stage All Changes
      </MenuRow>
      <MenuRow
        disabled={applying() || !stagedFiles(menuRoot()).length}
        onClick={() => void unstageAll(menuRoot())}
      >
        Unstage All Changes
      </MenuRow>
      <MenuRow
        disabled={applying() || !changedFiles(menuRoot()).length}
        onClick={() => void discardAllChanges(menuRoot())}
      >
        Discard All Changes...
      </MenuRow>
      <MenuSeparator />
      <MenuRow onClick={() => void fetchRemote(menuRoot())}>Fetch</MenuRow>
      <MenuRow disabled={!canPushIn(menuRoot())} onClick={() => pushMember(menuRoot())}>
        Push
      </MenuRow>
      <MenuSeparator />
      <MenuRow
        disabled={applying() || conflictedFiles(menuRoot()).length > 0}
        onClick={() => void stashAll()}
      >
        Stash All Changes
      </MenuRow>
      <MenuSeparator />
      <For each={OPTIONAL_CHANGES_SECTIONS}>
        {(sec) => (
          <MenuRow onClick={() => changesLayout.setShown(sec.id, !shown(sec.id))}>
            <span class={styles.checkSlot}>
              <Show when={shown(sec.id)}>
                <Icon icon={Check} />
              </Show>
            </span>
            {sec.label}
          </MenuRow>
        )}
      </For>
      <MenuSeparator />
      <MenuRow
        disabled={!menuRoot()}
        onClick={() => {
          const root = menuRoot();
          if (root) emitWith(OPEN_IN_EDITOR, { path: syntheticId("log", root) });
        }}
      >
        Show Commit Log
      </MenuRow>
    </>
  );

  /** What the split Commit button offers beside its own verb. */
  const commitMenu = () => (
    <>
      <MenuRow disabled={!canCommit() || committing()} onClick={() => void commit()}>
        {amend() ? "Amend" : "Commit"}
      </MenuRow>
      <MenuRow disabled={committing()} onClick={() => void toggleAmend(!amend())}>
        {amend() ? "Stop amending" : "Commit (Amend)"}
      </MenuRow>
      <MenuSeparator />
      <MenuRow disabled={!canCommit() || committing()} onClick={() => void commit(true)}>
        {amend() ? "Amend & Push" : "Commit & Push"}
      </MenuRow>
    </>
  );

  return (
    <div class={styles.reviewPanel}>
      {/* One row, the same height the Files and Search tabs open with. A
          Feature's members share one branch name (`feat/<slug>`, frozen at
          creation), so it is named once here; their ahead/behind and their
          pushes differ, and stay in the member headers. */}
      <div class={styles.topBar}>
        <Show when={branch()}>
          <Icon icon={GitBranch} />
          <span class={styles.branchName} title={branch() ?? ""}>
            {branch()}
          </span>
        </Show>
        <Show when={!headed() && aheadBehind()}>
          {(ab) => (
            <Tooltip
              as="button"
              type="button"
              class={styles.aheadPill}
              disabled={!canPushIn(props.root)}
              label={ab().has_upstream ? "Push" : "Push (sets upstream)"}
              onClick={() => pushMember(props.root)}
            >
              {pushingIn(props.root)
                ? "Pushing"
                : ab().has_upstream
                  ? `${UP}${ab().ahead} ${DOWN}${ab().behind}`
                  : "Unpushed"}
            </Tooltip>
          )}
        </Show>
        <span class={styles.spacer} />
        <Show when={origin() && baseBranch()}>
          <IconButton
            size="sm"
            icon={<Icon icon={GitPullRequestArrow} />}
            disabled={openingPr()}
            aria-label="Open PR"
            tooltip={openingPr() ? "Opening a pull request" : "Open a pull request"}
            onClick={openPr}
          />
        </Show>
        <IconButton
          size="sm"
          icon={<Icon icon={RefreshCw} />}
          tooltip="Refresh"
          onClick={() => void refreshAll()}
        />
        <Dropdown as="span" wrapper menu={menu()} placement="bottom-end">
          <IconButton size="sm" tooltip="Views and More Actions" icon={<Icon icon={Ellipsis} />} />
        </Dropdown>
      </div>

      {/* The composer first, because committing is what this tab is for. */}
      <div class={styles.commitBox}>
        {/* Which repos this message lands in. Only inside a Feature: with one
            member there is nothing to pick between. Unticking is how a commit
            is narrowed when the work in two members really is separate. */}
        <Show when={headed() && (amend() ? memberRoots().length : stagedRoots().length) > 1}>
          <div class={styles.commitTarget}>
            <For each={amend() ? memberRoots() : stagedRoots()}>
              {(root) => {
                const sec = () => sections().find((x) => x.root === root);
                const on = () => (amend() ? targetMember() === root : !unticked().has(root));
                return (
                  <Tooltip
                    as="button"
                    type="button"
                    class={styles.chip}
                    aria-pressed={on()}
                    label={
                      amend()
                        ? `Amend the last commit in ${sec()?.label}`
                        : on()
                          ? `Leave ${sec()?.label} out of this commit`
                          : `Include ${sec()?.label} in this commit`
                    }
                    onClick={() => {
                      // Amend is one member, so a chip picks rather than toggles.
                      if (amend()) {
                        setCommitTarget(root);
                        return;
                      }
                      setUnticked((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(root)) next.add(root);
                        return next;
                      });
                    }}
                  >
                    <MemberChip
                      member={{ displayName: sec()?.label ?? "", repoPath: root }}
                      tint={sec()?.tint}
                      decorative
                    />
                  </Tooltip>
                );
              }}
            </For>
          </div>
        </Show>
        <input
          ref={subjectRef}
          class={styles.commitInput}
          type="text"
          placeholder="Summary"
          value={commitSubject()}
          onInput={(e) => setCommitSubject(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter commits from the subject (the one-line case, unchanged);
            // the body is a textarea, where Enter has to mean a newline.
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <textarea
          class={styles.commitBodyInput}
          rows={3}
          placeholder="Description (optional)"
          value={commitBody()}
          onInput={(e) => setCommitBody(e.currentTarget.value)}
        />
        <div class={styles.commitActions}>
          <Button
            size="sm"
            variant="ghost"
            class={styles.draftButton}
            disabled={!commitStagedFiles().length || !!disabledReason() || drafting()}
            tooltipWhenDisabled
            tooltip={disabledReason() ?? "Ask the selected session to draft a commit message"}
            onClick={askAgentToDraft}
          >
            Ask agent to draft
          </Button>
          {/* A split button: the verb on the left, its variants behind the
              chevron, so Amend and Commit & Push cost one click each without
              standing on the row as three primary buttons. */}
          <span class={styles.splitButton}>
            <Button
              variant="primary"
              size="sm"
              class={styles.commitButton}
              disabled={!canCommit() || committing()}
              // "Nothing staged" is the whole explanation for a greyed-out
              // Commit, and it is the branch that only ever shows while it is.
              tooltipWhenDisabled
              tooltip={
                amend()
                  ? "Amend the last commit"
                  : commitStagedFiles().length
                    ? commitLabelHint()
                    : "Nothing staged"
              }
              onClick={() => void commit()}
            >
              {commitLabel()}
            </Button>
            <Dropdown as="span" wrapper menu={commitMenu()} placement="top-end">
              <IconButton
                size="sm"
                class={styles.splitMore}
                tooltip="More commit actions"
                icon={<Icon icon={ChevronDown} />}
              />
            </Dropdown>
          </span>
        </div>
      </div>

      <div class={styles.stack} ref={stackEl}>
        <PanelSection
          layout={changesLayout}
          id="changes"
          fill={filler() === "changes"}
          maxH={maxH}
          title={
            <>
              Changes
              <Show when={totalChanged()}>
                <span class={styles.count}>{totalChanged()}</span>
              </Show>
            </>
          }
        >
          {/* A Feature keeps its member headers on a clean tree: they are where
              its branches, their ahead/behind and their pushes live, and a
              panel-wide empty note would take all three away. */}
          <Show
            when={headed() || anyFiles()}
            fallback={
              <div class="tree-empty">
                <p>No changes yet. Edit a file and it shows up here to stage, commit, and push.</p>
              </div>
            }
          >
            <OverlayScroll class={styles.sectionScroll}>
              <For each={sections()}>
                {(sec) => (
                  <div class={styles.memberSection} data-root={sec.root}>
                    <Show when={headed()}>{memberHeader(sec)}</Show>
                    {/* A member that cannot be opened has no repo to read, so
                        its header's state badge is the whole of its section. */}
                    <Show when={sec.state?.usable !== false}>
                      {sectionLists(sec)}
                      <Show when={headed() && !gitStateFor(sec.root).files.length}>
                        <div class={styles.memberEmpty}>No changes</div>
                      </Show>
                    </Show>
                  </div>
                )}
              </For>
            </OverlayScroll>
          </Show>
        </PanelSection>

        <Show when={shown("stashes")}>
          <PanelSection
            layout={changesLayout}
            id="stashes"
            fill={filler() === "stashes"}
            maxH={maxH}
            title={
              <>
                Stashes
                <Show when={stashes().length}>
                  <span class={styles.count}>{stashes().length}</span>
                </Show>
              </>
            }
            actions={
              <>
                <Checkbox
                  class={styles.untrackedBox}
                  aria-describedby={UNTRACKED_HINT_ID}
                  checked={includeUntracked()}
                  onChange={setIncludeUntracked}
                  label="untracked"
                />
                <span id={UNTRACKED_HINT_ID} class={styles.srOnly}>
                  Also stash files git has never seen, which usually means build output and local
                  scratch
                </span>
                {/* Off while anything is unmerged: `git stash` refuses such a
                    tree outright, so the button would only ever produce git's
                    error. */}
                <IconButton
                  size="sm"
                  icon={<Icon icon={Archive} />}
                  disabled={applying() || conflictedFiles(menuRoot()).length > 0}
                  aria-label="Stash all"
                  tooltipWhenDisabled
                  tooltip={
                    conflictedFiles(menuRoot()).length
                      ? "Nothing can be stashed while a merge is unresolved. Finish the conflicts first."
                      : "Put every change aside for later, named after the Summary above if you have written one"
                  }
                  onClick={() => void stashAll()}
                />
              </>
            }
          >
            <Show
              when={stashes().length}
              fallback={<div class="tree-empty">Nothing stashed.</div>}
            >
              <OverlayScroll class={styles.sectionScroll}>
                <For each={stashes()}>
                  {(st) => (
                    <div
                      class={styles.stashRow}
                      title={`${st.selector}${st.branch ? ` on ${st.branch}` : ""} - ${st.relative_date}`}
                    >
                      <span class={styles.reviewName}>{st.message}</span>
                      <span class={styles.stashMeta}>{st.relative_date}</span>
                      <span class={styles.rowEnd}>
                        <IconButton
                          size="xs"
                          icon={<Icon icon={ArchiveRestore} />}
                          disabled={applying()}
                          aria-label="Apply stash"
                          tooltip="Lay this stash back down and keep it in the list"
                          onClick={() => void applyStash(st, false)}
                        />
                        <IconButton
                          size="xs"
                          icon={<Icon icon={ArchiveX} />}
                          disabled={applying()}
                          aria-label="Pop stash"
                          tooltip="Lay this stash back down and remove it from the list"
                          onClick={() => void applyStash(st, true)}
                        />
                        <IconButton
                          size="xs"
                          icon={<Icon icon={Trash2} />}
                          disabled={applying()}
                          aria-label="Drop stash"
                          tooltip="Delete this stash without applying it"
                          onClick={() => void dropStash(st)}
                        />
                      </span>
                    </div>
                  )}
                </For>
              </OverlayScroll>
            </Show>
          </PanelSection>
        </Show>

        <Show when={shown("checkpoints")}>
          <PanelSection
            layout={changesLayout}
            id="checkpoints"
            fill={filler() === "checkpoints"}
            maxH={maxH}
            title="Checkpoints"
          >
            {/* Both fields name the target member: the refs it reads, the chats
                it lists and the revert paths it resolves all have to name one
                repo, and a `root` that moved while `folderPath` stayed would
                list the member in front's sessions against another member's
                checkpoints. */}
            <OverlayScroll class={styles.sectionScroll}>
              <CheckpointTimeline
                root={targetMember()}
                sessionId={props.selected?.sessionId ?? null}
                folderPath={targetMember()}
                onReverted={(outcome) => {
                  props.onReverted?.(outcome);
                  void refreshAll();
                }}
              />
            </OverlayScroll>
          </PanelSection>
        </Show>
      </div>
      <Show when={confirmReq()}>
        <ConfirmDialog
          title={confirmReq()!.title}
          message={confirmReq()!.message}
          confirmLabel={confirmReq()!.confirmLabel}
          danger={confirmReq()!.danger}
          onConfirm={() => {
            confirmReq()!.resolve(true);
            setConfirmReq(null);
          }}
          onCancel={() => {
            confirmReq()!.resolve(false);
            setConfirmReq(null);
          }}
        />
      </Show>
      <Show when={prForm()}>
        <CreatePrDialog
          head={branch() ?? ""}
          base={prBase()}
          busy={openingPr()}
          drafting={prDrafting()}
          draftDisabledReason={disabledReason()}
          title={prTitle()}
          body={prBody()}
          onTitleChange={setPrTitle}
          onBodyChange={setPrBody}
          onBaseChange={setPrBase}
          onDraft={() => void askAgentToDraftPr()}
          onConfirm={(opts) => void submitPr(opts)}
          onCancel={() => setPrForm(false)}
        />
      </Show>
    </div>
  );
}
