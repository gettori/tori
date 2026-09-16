import { createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  emitWith,
  onWith,
  AGENT_FILES_WRITTEN,
  AGENT_WRITE_DEBOUNCE_MS,
  OPEN_IN_EDITOR,
  OPEN_SETTINGS,
  PR_OPENED,
  TOAST,
  type OpenSettings,
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
  stageAll,
  unstageAll,
  fetchIn,
  pull as pullIn,
  commit as commitStaged,
  headMessage,
  push as pushToOrigin,
  type FileStatus,
} from "../../utils/gitActions";
import { amendRewritesPushed } from "../../utils/commitMessage";
import { DIFF_CONTEXT } from "../../utils/diffHunks";
import { compactAge } from "../../utils/compactAge";
import { copyText } from "../../utils/clipboard";
import { mentionPath } from "../../utils/pathScope";
import { mayRewrite } from "../../utils/gitGuard";
import { BLOCKED_REASON, requestSend, type SessionTarget } from "../../utils/safeSend";
import { askAgentToResolve } from "../../utils/conflictAsk";
import { sendBlockedReason } from "../../utils/sendTarget";
import { comparePrUrl } from "../../utils/prUrl";
import { composeDraftRequest, connectHost, prPath } from "../../utils/createPr";
import {
  forgeAccountName,
  forgeErrorMessage,
  type AuthState,
  type PullRequest,
} from "../../utils/forgeTypes";
import { forgeHosts, forgeRepo, pickForgeAccount, resolveForgeRepo } from "../../utils/forgeStatus";
import { chromeScale, settings } from "../Settings/settingsStore";
import { REPAIR_LABEL, rootOf, type MemberStateSummary } from "../../utils/features";
import MemberChip from "../../components/MemberChip/MemberChip";
import MemberChipRow from "../../components/MemberChipRow/MemberChipRow";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import Dropdown from "../../components/Menu/Dropdown";
import { MenuRow, MenuSeparator } from "../../components/Menu/rows";
import {
  changesLayout,
  HISTORY_TABS,
  historyTab,
  setHistoryTab,
  setTabShown,
  tabShown,
  type HistoryTab,
} from "../../utils/changesSections";
import { SECTION_MIN_H } from "../../utils/sectionLayout";
import Resizer from "../../components/Resizer/Resizer";
import type { MemberRoot, TintedMember } from "../../utils/featureMembers";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import CheckpointTimeline, { type RevertOutcome } from "./CheckpointTimeline";
import GraphSection from "./GraphSection";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import CreatePrDialog from "../../components/Dialogs/CreatePrDialog";
import Button from "../../components/Button/Button";
import Checkbox from "../../components/Checkbox/Checkbox";
import IconButton from "../../components/IconButton/IconButton";
import FileIcon from "../../seti/FileIcon";
import CommitFiles from "./CommitFiles";
import Tooltip from "../../components/Tooltip/Tooltip";
import Icon from "../../components/Icon/Icon";
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Ellipsis,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  GitGraph,
  GitPullRequestArrow,
  UserRound,
  Minus,
  Plug,
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
  sha: string;
  message: string;
  branch: string | null;
  relative_date: string;
  committed_at: number;
};
type StashOutcome = { restored: string[]; deleted: string[] };
/** `git diff --numstat`, summed: what the composer's footer says. */

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

/** Where the message box stops growing and starts scrolling. Eight lines holds
 *  a subject, a blank line and a paragraph of body. */
const MSG_MAX_ROWS = 8;

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
  /** The same members as chips can draw them. Empty outside a Feature, which is
   *  how the tab knows to name itself instead. */
  members?: readonly TintedMember[];
  /** The active editor tab's path, which is what "the member you are working
   *  in" means when nothing has been chosen by hand. */
  activePath?: string | null;
  selected: Selection | null;
  onReverted?: (outcome: RevertOutcome) => void;
  onRepair?: (path: string) => void;
}) {
  const [commitText, setCommitText] = createSignal("");
  const [amend, setAmend] = createSignal(false);
  // What was typed before amend prefilled HEAD's message over it, so toggling
  // amend off gives it back rather than leaving HEAD's wording behind.
  const [preAmendDraft, setPreAmendDraft] = createSignal<string | null>(null);
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
  // The in-app create-PR form. Only reachable on a signed-in, registered host;
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
  // The account "Open PR" acts as, read through the poll store so a pick made
  // from the sidebar lands here too.
  const forgeAccount = () => forgeRepo(viewedRoot());
  const accountAuth = (): AuthState => {
    const repo = forgeAccount();
    return repo?.kind === "account" ? repo.auth : { kind: "signedOut" };
  };
  const pickState = () => {
    const repo = forgeAccount();
    return repo?.kind === "pick" ? repo : null;
  };
  const connectable = () => (settings.forge.enabled ? connectHost(origin(), forgeHosts()) : null);
  // Accounts changing clears every resolution in the store, so ask again.
  createEffect(() => {
    const root = viewedRoot();
    if (root && !forgeAccount()) void resolveForgeRepo(root);
  });
  const [applying, setApplying] = createSignal(false);
  const [stashes, setStashes] = createSignal<StashEntry[]>([]);
  // Which stashes show their files, by sha: a selector shifts as entries come
  // and go, so an open row would follow the wrong stash.
  const [openStashes, setOpenStashes] = createSignal<ReadonlySet<string>>(new Set());

  function toggleStash(sha: string) {
    setOpenStashes((prev) => {
      const next = new Set(prev);
      if (!next.delete(sha)) next.add(sha);
      return next;
    });
  }
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
  /** Inside a Feature, where the chips pick which member is on screen. A branch
   *  unit has one repo and names itself instead. */
  const headed = () => !!props.roots?.length;

  /** The chip the user pressed, by member key. Sticks once set: it is the one
   *  thing on screen saying whose changes these are, so having it move under
   *  you would be worse than having to click again. */
  const [picked, setPicked] = createSignal<string | null>(null);
  const memberOf = (key: string | null) => props.members?.find((m) => m.key === key);
  /** The member on screen: the chip pressed, else the one holding the file in
   *  front, else the first. */
  const viewed = () =>
    memberOf(picked()) ??
    memberOf(rootOf(props.activePath, (props.members ?? []).map((m) => m.key))) ??
    props.members?.[0];
  /** The root every list below is about. One member at a time: a stack of every
   *  member's changes is a list nobody reads.
   *
   *  Falls back to `root` rather than to null, because `headed()` reads `roots`
   *  while the chips read `members`: a caller that passes one and not the other
   *  would otherwise blank the whole panel instead of showing one repo. */
  const viewedRoot = () => (headed() ? (viewed()?.key ?? props.root) : props.root);
  const viewedSection = () => sections().find((sec) => sec.root === viewedRoot());
  const anyFiles = () => !!gitStateFor(viewedRoot()).files.length;

  // The branch, the PR paths and the stash list are all one-repo surfaces, and
  // the repo they are about is the one on screen.
  const branch = () => gitStateFor(viewedRoot()).branch;
  const aheadBehind = () => gitStateFor(viewedRoot()).aheadBehind;

  // Which member the commit box, its draft request and the timeline are about.
  //
  // Chosen by hand where a section's Commit button was clicked, and that choice
  // sticks: it is the one thing on screen saying which repo the message lands
  // in, so having it move under you would be worse than having to click again.
  // Otherwise the member holding the file in front, which is the one whose
  // changes you are looking at; the member in front is the fallback, and the
  // only answer a branch unit has.
  const [commitTarget, setCommitTarget] = createSignal<string | null>(null);
  const targetMember = () => commitTarget() ?? viewedRoot();

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
    const root = viewedRoot();
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
    await resolveForgeRepo(root);
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
            "Every unstaged change in this repo goes back to how it is staged. Anything already staged is kept.\n\nTori saves a snapshot first, so you can bring it back from Undo history in the timeline.",
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

  // What the commit would hold: staged when anything is, else the working tree,
  // which is what you are about to stage.
  const statsLabel = () => {
    const root = viewedRoot();
    const staged = stagedFiles(root).length;
    const n = staged || changedFiles(root).length + conflictedFiles(root).length;
    return n ? plural(n, "file") : "Nothing to commit";
  };

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
    const message = commitText().trim();
    if (committing()) return;
    // The button stays live and the click says what is missing: a greyed-out
    // Commit with the reason in a tooltip is the control people report as broken.
    if (!message) {
      emitWith<ToastEvent>(TOAST, { message: "Write a commit message first.", kind: "info" });
      msgRef?.focus();
      return;
    }
    if (!roots.length) {
      emitWith<ToastEvent>(TOAST, { message: "Nothing staged to commit.", kind: "info" });
      return;
    }
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
        setMessage("");
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
      setMessage(preAmendDraft() ?? "");
      setPreAmendDraft(null);
      return;
    }
    setPreAmendDraft(commitText());
    if (!root) return;
    const head = (await headMessage(root)).replace(/\r\n/g, "\n").trim();
    // A late answer must not overwrite a toggle-off that happened meanwhile.
    if (!amend()) return;
    setMessage(head);
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
   *  hard, one Tori cannot see inside is overridable. `verb` names the action in
   *  the override, so the question reads as itself rather than as a revert. */
  async function guarded(verb: string, root: string, action: () => Promise<void>) {
    const ok = await mayRewrite(verb, root, {
      confirm: askConfirm,
      refuse: (reason) => toastError(reason),
    });
    if (ok) await action();
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
            ? `1 file is deleted. It was never committed, so git has no copy of it.\n\nTori saves a snapshot first, so you can bring it back from Undo history in the timeline.`
            : `1 file goes back to how it is staged. Unstaged changes to it are lost; anything already staged is kept.\n\nTori saves a snapshot first, so you can bring it back from Undo history in the timeline.`,
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
   *  The message's first line doubles as the stash name when it has something in
   *  it: a stash you meant to come back to needs a label, and "WIP on main" is
   *  not one. Left empty, git writes its own subject, same as `git stash`
   *  alone. The first line only, because a stash list shows one line per entry
   *  and a whole paragraph there is unreadable. */
  async function stashAll() {
    const root = viewedRoot();
    if (!root) return;
    await busy(() =>
      guarded("Stash", root, async () => {
        const created = await invoke<boolean>("git_stash_push", {
          projectPath: root,
          message: commitText().trim().split("\n")[0] || null,
          includeUntracked: includeUntracked(),
        });
        if (!created) {
          // git exits 0 on a clean tree, so silence here would read as success.
          emitWith<ToastEvent>(TOAST, { message: "Nothing to stash.", kind: "info" });
          return;
        }
        // The whole message, not just the line that named the stash: the draft
        // described the work that has now moved into the stash, and what was
        // left behind would attach itself to whatever gets committed next.
        setMessage("");
        await Promise.all([refreshStatus(root), loadStashes()]);
      }),
    );
  }

  async function applyStash(entry: StashEntry, pop: boolean) {
    const root = viewedRoot();
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
    const root = viewedRoot();
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
    const root = viewedRoot();
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

  // A chip switch changes which repo the one-repo surfaces are about, and two
  // of them are read here rather than from the store: the stash reflog, and the
  // origin plus base branch the "Open PR" button needs. The file lists are the
  // store's and every member's slot is already filled, so those just re-read.
  createEffect(
    on(viewedRoot, () => {
      void refreshHeader();
      void loadStashes();
    }),
  );

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

  // The decision lives in `prPath` so the button and the submit cannot disagree
  // about it.
  async function openPr() {
    const org = origin();
    if (openingPr()) return;
    if (prPath(org, forgeHosts(), accountAuth(), settings.forge.enabled) === "form") {
      setPrTitle("");
      setPrBody("");
      setPrBase(baseBranch() ?? "");
      setPrForm(true);
      return;
    }
    await openCompare();
  }

  async function pickAccount(accountId: string) {
    const root = viewedRoot();
    if (!root) return;
    try {
      await pickForgeAccount(root, accountId);
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: forgeErrorMessage(e), kind: "error" });
    }
  }

  // The unauthenticated path, unchanged: push first if the branch is unpushed or
  // ahead, then open the provider's compare/new-MR/new-PR page for branch -> base.
  async function openCompare() {
    const root = viewedRoot();
    const branchName = branch();
    const org = origin();
    const base = baseBranch();
    if (!root || !branchName || !org || !base) return;
    const url = comparePrUrl(org, base, branchName, forgeHosts());
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
    const paths = [...stagedFiles(viewedRoot()), ...changedFiles(viewedRoot())].map((f) => f.path);
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
    const root = viewedRoot();
    const branchName = branch();
    const base = prBase().trim();
    if (!root || !branchName || !base || openingPr()) return;
    setOpeningPr(true);
    try {
      const pr = await invoke<PullRequest>("forge_push_and_create_pr", {
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
      if (!from || from === viewedRoot()) void loadStashes();
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

  /** One changed file, in the file tree's shape: icon, name, the hover actions,
   *  then the status letter last, so a column of letters lines up down the
   *  right edge whatever the names are doing. The folder is on the `title`,
   *  not beside the name; a sidebar has no room for both. */
  function row(f: FileStatus, opts: { staged: boolean; root: string }) {
    const untracked = () => f.status.includes("?");
    const tab = () => diffTabId(opts.root, f.path, opts.staged);
    return (
      <div
        class={styles.reviewRow}
        classList={{ [styles.active]: props.activePath === tab() }}
        // The two rows of a partially staged file open two tabs: they are
        // different comparisons, so one tab could only ever show one of them.
        onClick={() => emitWith(OPEN_IN_EDITOR, { path: tab() })}
        title={f.path}
      >
        <FileIcon name={baseName(f.path)} />
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
          {/* Only when there is a group above to tell it apart from: alone,
              the section's own title already says "Changes". */}
          <Show when={stagedFiles(sec.root).length || conflictedFiles(sec.root).length}>
            <div class={styles.groupHeader}>Changes</div>
          </Show>
          <For each={changedFiles(sec.root)}>{(f) => row(f, { staged: false, root: sec.root })}</For>
        </Show>
      </>
    );
  }

  let msgRef: HTMLTextAreaElement | undefined;

  /**
   * Grow the message box to its content, between one line and eight. Past that
   * it scrolls: a commit message longer than eight lines is being written, not
   * read back, and a box that keeps growing pushes the file list off screen.
   *
   * Shrinking is the only case that has to measure from small, so typing costs
   * one layout rather than two (`Composer.fit` carries the same reasoning).
   */
  function fitMessage() {
    const el = msgRef;
    if (!el) return;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight);
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    if (!Number.isFinite(line) || line <= 0) return;
    const wanted = () =>
      Math.min(MSG_MAX_ROWS, Math.max(1, Math.round((el.scrollHeight - pad) / line)));
    if (el.scrollHeight > el.clientHeight) {
      el.rows = wanted();
      return;
    }
    if (el.rows <= 1) return;
    el.rows = 1;
    el.rows = wanted();
  }

  /** Set the message from code (amend, clearing after a commit or a stash) and
   *  resize the box, which only `input` would otherwise do. */
  function setMessage(text: string) {
    setCommitText(text);
    queueMicrotask(fitMessage);
  }

  let stackEl: HTMLDivElement | undefined;
  // Room for the file list above the history: its rows plus some air.
  const maxH = () => (stackEl?.clientHeight ?? 0) - 120 * chromeScale();
  const historyOpen = () => changesLayout.open("history");
  const historyHeight = () => changesLayout.size("history") * chromeScale();

  /** A tab always opens the section: only the chevron closes it, so a click
   *  on the tab you are on is never a surprise collapse. */
  function showHistory(tab: HistoryTab) {
    setHistoryTab(tab);
    changesLayout.setOpen("history", true);
  }

  const shownTabs = () => HISTORY_TABS.filter((t) => tabShown(t.id));
  /** The picked tab, or the first left once the ... menu has hidden it. */
  const tab = (): HistoryTab | undefined =>
    shownTabs().some((t) => t.id === historyTab()) ? historyTab() : shownTabs()[0]?.id;

  const [allBranches, setAllBranches] = createSignal(false);
  const [checkpointCount, setCheckpointCount] = createSignal(0);
  const tabCount = (tab: HistoryTab) =>
    tab === "stashes" ? stashes().length : tab === "checkpoints" ? checkpointCount() : 0;

  /** The repo the one-repo surfaces are about: the member the chips name. */
  const menuRoot = () => viewedRoot();

  /** Row two's dots: what you do to the repo on screen. The rarer commands are
   *  `Git:` entries in the palette. */
  const gitMenu = () => (
    <>
      <MenuRow
        disabled={applying() || !changedFiles(menuRoot()).length}
        onClick={() => menuRoot() && void stageAll(menuRoot()!)}
      >
        Stage All Changes
      </MenuRow>
      <MenuRow
        disabled={applying() || !stagedFiles(menuRoot()).length}
        onClick={() => menuRoot() && void unstageAll(menuRoot()!)}
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
      <MenuRow onClick={() => menuRoot() && void fetchIn(menuRoot()!)}>Fetch</MenuRow>
      <MenuRow onClick={() => menuRoot() && void pullIn(menuRoot()!)}>Pull</MenuRow>
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
      <For each={HISTORY_TABS}>
        {(t) => (
          <MenuRow onClick={() => setTabShown(t.id, !tabShown(t.id))}>
            <span class={styles.checkSlot}>
              <Show when={tabShown(t.id)}>
                <Icon icon={Check} />
              </Show>
            </span>
            {t.label}
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
      <MenuRow disabled={committing()} onClick={() => void commit()}>
        {amend() ? "Amend" : "Commit"}
      </MenuRow>
      <MenuRow disabled={committing()} onClick={() => void toggleAmend(!amend())}>
        {amend() ? "Stop amending" : "Commit (Amend)"}
      </MenuRow>
      <MenuSeparator />
      <MenuRow disabled={committing()} onClick={() => void commit(true)}>
        {amend() ? "Amend & Push" : "Commit & Push"}
      </MenuRow>
    </>
  );

  return (
    <div class={styles.reviewPanel}>
      {/* Row one, the shape the Files and Search tabs open with: who this tab
          is about, then the dots. Inside a Feature the chips pick one member,
          the way the file tree's do. */}
      <div class={styles.topBar}>
        <Show when={headed()} fallback={<span class={styles.title}>Source Control</span>}>
          <MemberChipRow
            bare
            cap={4}
            members={props.members ?? []}
            activeRoot={props.root}
            activeKey={viewed()?.key ?? null}
            onPick={(m) => setPicked(m.key)}
          />
        </Show>
        <span class={styles.spacer} />
        <IconButton
          size="sm"
          icon={<Icon icon={RefreshCw} />}
          tooltip="Refresh"
          onClick={() => void refreshAll()}
        />
        <Dropdown as="span" wrapper menu={gitMenu()} placement="bottom-end">
          <IconButton
            size="sm"
            tooltip="More Actions"
            icon={<Icon icon={Ellipsis} />}
          />
        </Dropdown>
      </div>

      {/* Row two, the repo on screen: its branch, and what you do to it. Every
          answer here is one repo's, and the chip above says which. */}
      <div class={styles.branchBar}>
        <Show when={branch()}>
          <Icon icon={GitBranch} />
          <span class={styles.branchName} title={branch() ?? ""}>
            {branch()}
          </span>
        </Show>
        <span class={styles.spacer} />
        <Show when={aheadBehind()}>
          {(ab) => (
            <Tooltip
              as="button"
              type="button"
              class={styles.aheadPill}
              disabled={!canPushIn(viewedRoot())}
              label={ab().has_upstream ? "Push" : "Push (sets upstream)"}
              onClick={() => pushMember(viewedRoot())}
            >
              {pushingIn(viewedRoot())
                ? "Pushing"
                : ab().has_upstream
                  ? `${UP}${ab().ahead}${ab().behind ? ` ${DOWN}${ab().behind}` : ""}`
                  : "Unpushed"}
            </Tooltip>
          )}
        </Show>
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
        <Show when={pickState()}>
          {(pick) => (
            <Dropdown
              as="span"
              wrapper
              items={[
                { heading: `${pick().host} account` },
                ...pick().candidates.map((a) => ({
                  label: forgeAccountName(a),
                  onClick: () => void pickAccount(a.id),
                })),
              ]}
              placement="bottom-end"
            >
              <IconButton
                size="sm"
                icon={<Icon icon={UserRound} />}
                aria-label="Pick account"
                tooltip={`Pick which ${pick().host} account this repo uses`}
              />
            </Dropdown>
          )}
        </Show>
        <Show when={connectable()}>
          {(host) => (
            <IconButton
              size="sm"
              icon={<Icon icon={Plug} />}
              aria-label={`Add an account for ${host()}`}
              tooltip={`Add an account for ${host()} in Settings`}
              onClick={() => emitWith<OpenSettings>(OPEN_SETTINGS, { entry: "forge" })}
            />
          )}
        </Show>
      </div>

      {/* The composer, as one card: the message, then what the commit would
          hold and the buttons that make it, so the numbers sit beside the
          verb they qualify. */}
      <div class={styles.commitCard}>
        <Show when={headed() && (amend() ? memberRoots().length : stagedRoots().length) > 1}>
          <div class={styles.commitTarget}>
            <For each={amend() ? memberRoots() : stagedRoots()}>
              {(root) => {
                const sec = () => sections().find((x) => x.root === root);
                const on = () => (amend() ? targetMember() === root : !unticked().has(root));
                const action = () =>
                  amend()
                    ? `Amend the last commit in ${sec()?.label}`
                    : on()
                      ? `Leave ${sec()?.label} out of this commit`
                      : `Include ${sec()?.label} in this commit`;
                return (
                  <Tooltip
                    as="button"
                    type="button"
                    class={styles.chip}
                    aria-pressed={on()}
                    aria-label={action()}
                    label={action()}
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
        <textarea
          ref={msgRef}
          class={styles.commitInput}
          rows={1}
          placeholder="Message"
          value={commitText()}
          onInput={(e) => {
            setCommitText(e.currentTarget.value);
            fitMessage();
          }}
          onKeyDown={(e) => {
            // Enter still commits, as it did from the subject field, and
            // Shift+Enter is the newline - the chat composer's bargain, so one
            // key does not mean two things in one app.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div class={styles.commitFooter}>
          <span class={styles.commitStats}>{statsLabel()}</span>
          <div class={styles.commitActions}>
            <Button
              size="sm"
              variant="ghost"
              disabled={!commitStagedFiles().length || !!disabledReason() || drafting()}
              tooltipWhenDisabled
              tooltip={disabledReason() ?? "Ask the selected session to draft a commit message"}
              onClick={askAgentToDraft}
            >
              AI Draft
            </Button>
            {/* A split button: the verb on the left, its variants behind the
                chevron, so Amend and Commit & Push cost one click each without
                standing on the row as three primary buttons. */}
            <span class={styles.splitButton}>
              <Button
                variant="primary"
                size="sm"
                class={styles.commitButton}
                disabled={committing()}
                tooltip={amend() ? "Amend the last commit" : commitLabelHint()}
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
      </div>

      <div class={styles.stack} ref={stackEl}>
        <div class={styles.changesBody}>
          {/* One member, the one the chips name. A member that cannot be opened
              has no repo to read, so its state and its repair are the whole of
              what this section can show. */}
          <Show
            when={viewedSection()?.state?.usable !== false}
            fallback={
              <div class={styles.unusable}>
                <span>
                  {viewedSection()?.state?.reason
                    ? `${viewedSection()?.state?.label}: ${viewedSection()?.state?.reason}`
                    : viewedSection()?.state?.label}
                </span>
                <Show when={viewedSection()?.state?.action}>
                  {(action) => (
                    <Button
                      size="xs"
                      variant="ghost"
                      data-repair={viewedRoot()}
                      onClick={() => viewedRoot() && props.onRepair?.(viewedRoot()!)}
                    >
                      {REPAIR_LABEL[action()]}
                    </Button>
                  )}
                </Show>
              </div>
            }
          >
            <Show
              when={anyFiles()}
              fallback={
                <div class="tree-empty">
                  <p>No changes yet. Edit a file and it shows up here to stage, commit, and push.</p>
                </div>
              }
            >
              <OverlayScroll class={styles.sectionScroll}>
                <div class={styles.memberSection} data-root={viewedRoot()}>
                  {sectionLists({ root: viewedRoot()! })}
                </div>
              </OverlayScroll>
            </Show>
          </Show>
        </div>

        {/* History, one tab at a time: the graph, the stashes or the
            checkpoints. The strip is the section's header; collapsed, it is
            all that is left of the section, pinned under the file list. */}
        <Show when={shownTabs().length}>
          <section
            class={styles.history}
            classList={{ [styles.historyOpen]: historyOpen() }}
            style={historyOpen() ? { flex: `0 1 ${historyHeight()}px` } : undefined}
            data-section="history"
          >
            <Show when={historyOpen()}>
              <div class={styles.sash}>
                <Resizer
                  axis="y"
                  side="after"
                  value={historyHeight()}
                  min={SECTION_MIN_H * chromeScale()}
                  max={Math.max(SECTION_MIN_H * chromeScale(), maxH())}
                  onInput={(h) => changesLayout.setSize("history", h / chromeScale())}
                  onCommit={changesLayout.saveSizes}
                />
              </div>
            </Show>
            <div class={styles.tabStrip}>
              <div class={styles.tabs} role="tablist" aria-label="History">
                <For each={shownTabs()}>
                  {(t) => (
                    <button
                      type="button"
                      role="tab"
                      id={`review-tab-${t.id}`}
                      class={styles.tab}
                      aria-selected={tab() === t.id}
                      aria-controls={`review-panel-${t.id}`}
                      onClick={() => showHistory(t.id)}
                    >
                      <span>{t.label}</span>
                      <Show when={tabCount(t.id)}>
                        <span class={styles.tabCount}>{tabCount(t.id)}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
              <span class={styles.spacer} />
              <IconButton
                size="sm"
                icon={<Icon icon={historyOpen() ? ChevronDown : ChevronUp} />}
                aria-expanded={historyOpen()}
                tooltip={historyOpen() ? "Collapse" : "Expand"}
                onClick={() => changesLayout.setOpen("history", !historyOpen())}
              />
            </div>
            {/* What the showing tab offers, on its own line under the strip, so
                the tabs keep one shape whichever is up. Checkpoints offers
                nothing, so it draws no line. */}
            <Show when={historyOpen() && tab() !== "checkpoints"}>
              <div class={styles.tabActions}>
                <span class={styles.spacer} />
                <Show when={historyOpen() && tab() === "graph"}>
                  <Tooltip
                    as="button"
                    type="button"
                    class={styles.stripToggle}
                    aria-pressed={allBranches()}
                    label={allBranches() ? "Show this branch only" : "Show every branch"}
                    onClick={() => setAllBranches(!allBranches())}
                  >
                    <Icon icon={GitBranch} />
                    all branches
                  </Tooltip>
                  <IconButton
                    size="sm"
                    icon={<Icon icon={GitGraph} />}
                    disabled={!menuRoot()}
                    aria-label="Open Graph"
                    tooltip="Open the full graph in the editor"
                    onClick={() => {
                      const root = menuRoot();
                      if (root) emitWith(OPEN_IN_EDITOR, { path: syntheticId("graph", root) });
                    }}
                  />
                </Show>
                <Show when={historyOpen() && tab() === "stashes"}>
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
                        : "Put every change aside for later, named after the message above if you have written one"
                    }
                    onClick={() => void stashAll()}
                  />
                </Show>
              </div>
            </Show>
            {/* All three stay mounted: switching tabs keeps an expanded commit
                or a picked checkpoint, and the counts on the strip are live
                before a tab is ever shown. */}
            <div class={styles.historyBody} hidden={!historyOpen()}>
              <div
                id="review-panel-graph"
                role="tabpanel"
                aria-labelledby="review-tab-graph"
                class={styles.tabPanel}
                hidden={tab() !== "graph"}
              >
                <GraphSection root={menuRoot()} all={allBranches()} base={baseBranch()} />
              </div>
              <div
                id="review-panel-stashes"
                role="tabpanel"
                aria-labelledby="review-tab-stashes"
                class={styles.tabPanel}
                hidden={tab() !== "stashes"}
              >
              <Show
                when={stashes().length}
                fallback={<div class="tree-empty">Nothing stashed.</div>}
              >
                <OverlayScroll class={styles.sectionScroll}>
                  <For each={stashes()}>
                    {(st) => (
                      <>
                        <div
                          class={styles.stashRow}
                          classList={{ [styles.active]: openStashes().has(st.sha) }}
                          title={`${st.selector}${st.branch ? ` on ${st.branch}` : ""} - ${st.relative_date}`}
                          onClick={() => toggleStash(st.sha)}
                        >
                          <span class={styles.stashIcon} aria-hidden="true">
                            <Icon icon={Archive} />
                          </span>
                          <span class={styles.reviewName}>{st.message}</span>
                          <span class={styles.stashMeta}>{compactAge(st.committed_at)}</span>
                          <span class={styles.rowEnd}>
                            {/* A stash is a commit, so the commit view shows what
                                it holds; nothing here has to know how to diff one. */}
                            <IconButton
                              size="xs"
                              icon={<Icon icon={GitCommitHorizontal} />}
                              aria-label="Open stash"
                              tooltip="Open this stash as a commit"
                              onClick={(e) => {
                                e.stopPropagation();
                                emitWith(OPEN_IN_EDITOR, { path: syntheticId("commit", viewedRoot()!, st.sha) });
                              }}
                            />
                            <IconButton
                              size="xs"
                              icon={<Icon icon={ArchiveRestore} />}
                              disabled={applying()}
                              aria-label="Apply stash"
                              tooltip="Lay this stash back down and keep it in the list"
                              onClick={(e) => {
                                e.stopPropagation();
                                void applyStash(st, false);
                              }}
                            />
                            <IconButton
                              size="xs"
                              icon={<Icon icon={ArchiveX} />}
                              disabled={applying()}
                              aria-label="Pop stash"
                              tooltip="Lay this stash back down and remove it from the list"
                              onClick={(e) => {
                                e.stopPropagation();
                                void applyStash(st, true);
                              }}
                            />
                            <IconButton
                              size="xs"
                              icon={<Icon icon={Trash2} />}
                              disabled={applying()}
                              aria-label="Drop stash"
                              tooltip="Delete this stash without applying it"
                              onClick={(e) => {
                                e.stopPropagation();
                                void dropStash(st);
                              }}
                            />
                          </span>
                        </div>
                        <Show when={openStashes().has(st.sha)}>
                          <CommitFiles root={viewedRoot()!} sha={st.sha} />
                        </Show>
                      </>
                    )}
                  </For>
                </OverlayScroll>
              </Show>
              </div>
              <div
                id="review-panel-checkpoints"
                role="tabpanel"
                aria-labelledby="review-tab-checkpoints"
                class={styles.tabPanel}
                hidden={tab() !== "checkpoints"}
              >
                {/* Both fields name the target member: the refs it reads, the
                    chats it lists and the revert paths it resolves all have to
                    name one repo. */}
                <OverlayScroll class={styles.sectionScroll}>
                <CheckpointTimeline
                  root={targetMember()}
                  sessionId={props.selected?.sessionId ?? null}
                  folderPath={targetMember()}
                  onReverted={(outcome) => {
                    props.onReverted?.(outcome);
                    void refreshAll();
                  }}
                  onCount={setCheckpointCount}
                />
                </OverlayScroll>
              </div>
            </div>
          </section>
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
