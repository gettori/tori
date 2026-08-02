import { createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  emitWith,
  onWith,
  AGENT_FILES_WRITTEN,
  AGENT_WRITE_DEBOUNCE_MS,
  OPEN_IN_EDITOR,
  TOAST,
  type AgentFilesWritten,
  type ToastEvent,
  type FsChanged,
} from "../../utils/events";
import { debounce } from "../../utils/debounce";
import {
  gitState,
  stagedFiles,
  changedFiles,
  conflictedFiles,
  pushing,
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
import { parseDiffHunks } from "../../utils/diffHunks";
import { buildRows, hunkGaps, type Gap } from "../../utils/diffView";
import DiffRows, { diffRowClasses } from "./DiffRows";
import { readSideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import { hunkFingerprint } from "../../utils/hunkFingerprint";
import { copyText } from "../../utils/clipboard";
import { folderActors } from "../../utils/folderActors";
import { revertGuard } from "../../utils/revertGuard";
import { requestSend, type SessionTarget } from "../../utils/safeSend";
import { askAgentToResolve } from "../../utils/conflictAsk";
import { findAgent } from "../../utils/agents";
import { comparePrUrl } from "../../utils/prUrl";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import HunkCommentInput from "./HunkCommentInput";
import CheckpointTimeline, { type RevertOutcome } from "./CheckpointTimeline";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import { History } from "lucide-solid";
import { syntheticId } from "../../utils/syntheticTabs";
import hunkStyles from "./HunkCommentInput.module.css";
import styles from "./ReviewPanel.module.css";

// Mirrors DiffMode in src-tauri/src/git.rs. "head" (the backend default) is
// worktree-vs-HEAD; the panel always asks for one of the other two, since a
// partially-staged file's two rows describe different comparisons.
type DiffMode = "staged" | "unstaged";

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

// Map a porcelain XY code to a coarse class for the badge color.
function statusClass(status: string): string {
  if (status.includes("?")) return "untracked";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  return "modified";
}

// Git's default context, and deliberately not more. Context width decides hunk
// boundaries: at -U24 three edits 20 lines apart merge into one un-splittable
// hunk, which would make hunk staging useless on real code. So the diff stays
// at the granularity `git add -p` uses, and the untouched stretches it omits
// are recovered separately (see `hunkGaps` / `expandGap`).
const DIFF_CONTEXT = 3;

/** Changes panel: VS Code-style Staged / Changes sections over git_status's
 *  staged/unstaged split, with per-file stage/unstage, a manual commit box,
 *  and an "ask agent to draft" button routed through safe-send. Each file's
 *  inline diff toggle (git_diff_text) still carries the per-hunk "Comment"
 *  affordance from phase 1, routed to the sidebar's selected session.
 *
 *  The file list, branch and ahead/behind are read from the shared store in
 *  `utils/gitActions`, not fetched here: this panel is unmounted whenever the
 *  right pane shows anything else, and the command palette's git entries have to
 *  answer the same questions with it closed. Staging from either surface
 *  therefore moves the other. Everything still local (the expanded diff, its
 *  gaps, the PR base branch) is state only a mounted panel has any use for. */
export default function ReviewPanel(props: {
  root: string | null;
  selected: Selection | null;
  onReverted?: (outcome: RevertOutcome) => void;
}) {
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [diff, setDiff] = createSignal<string>("");
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
  const [sideBySide, setSideBySide] = createSignal(readSideBySide());
  // Which file the expanded diff belongs to, and which of its two sections:
  // needed to refetch the right diff after a hunk apply or a disk change.
  const [openDiff, setOpenDiff] = createSignal<{ path: string; staged: boolean } | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [stashes, setStashes] = createSignal<StashEntry[]>([]);
  const [includeUntracked, setIncludeUntracked] = createSignal(false);
  const [panelWidth, setPanelWidth] = createSignal(Infinity);
  // Which collapsed regions the user opened, keyed hunk:row. Cleared whenever a
  // different file expands, so collapse state never leaks between files.
  const [openGaps, setOpenGaps] = createSignal<Set<string>>(new Set());
  // Fetched contents of expanded gaps, keyed the same way.
  const [gapLines, setGapLines] = createSignal<Record<string, string[]>>({});
  // The lines picked for a line-level stage, and the hunk they are picked from.
  //
  // One hunk at a time on purpose: the patch is rebuilt from a single hunk's
  // body, so a selection spanning two of them could not be applied as one
  // request anyway, and picking a line in a second hunk reading as "I meant
  // this one now" is the least surprising of the readings available.
  const [picked, setPicked] = createSignal<{ hunk: number; lines: ReadonlySet<number> } | null>(null);

  // One parse per diff change, shared by every consumer below: the hunk list,
  // the gaps between them, and the per-hunk fingerprints.
  const hunks = createMemo(() => parseDiffHunks(diff()));
  const gaps = createMemo(() => hunkGaps(hunks()));

  // A line selection is indices into one hunk's body, so it means nothing once
  // the hunks move or a different file is showing. Cleared from the diff itself
  // rather than at each of the three places that reset the view, because a
  // fourth would otherwise be one edit away from leaving a selection pointing
  // into lines that are no longer there.
  createEffect(on([expanded, diff], () => setPicked(null)));

  // The persisted preference only applies when there is room for two columns.
  const twoColumn = () => sideBySide() && panelWidth() >= SIDE_BY_SIDE_MIN_WIDTH;

  function toggleSideBySide() {
    const next = !sideBySide();
    setSideBySide(next);
    writeSideBySide(next);
  }

  // Fetch (once) and reveal the file lines behind a collapsed gap. Clicking an
  // open gap closes it again; the fetched lines stay cached so reopening is
  // instant.
  async function expandGap(key: string, path: string, staged: boolean, gap: Gap) {
    if (openGaps().has(key)) {
      setOpenGaps((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    const root = props.root;
    if (!root) return;
    if (!gapLines()[key]) {
      try {
        const lines = await invoke<string[]>("git_file_slice", {
          projectPath: root,
          file: path,
          mode: staged ? "staged" : "unstaged",
          start: gap.start,
          end: gap.end,
        });
        // Rendered as context lines, so they carry the leading space a diff
        // context line would have.
        setGapLines((prev) => ({ ...prev, [key]: lines.map((l) => ` ${l}`) }));
      } catch (e) {
        // Say so rather than leaving a click that visibly does nothing.
        toastError(e);
        return;
      }
    }
    setOpenGaps((prev) => new Set(prev).add(key));
  }

  const files = () => gitState().files;
  const staged = stagedFiles;
  const unstaged = changedFiles;
  const conflicts = conflictedFiles;
  const branch = () => gitState().branch;
  const aheadBehind = () => gitState().aheadBehind;

  function target(): SessionTarget | null {
    const sel = props.selected;
    if (!sel?.sessionId) return null;
    return {
      sessionId: sel.sessionId,
      agent: sel.agent ?? "claude",
      folderPath: sel.folderPath,
      sessionCwd: sel.sessionCwd,
      sessionPath: sel.sessionPath,
      sessionTitle: sel.sessionTitle,
      sessionFile: sel.sessionFile,
    };
  }

  // Capability gate: no session selected, or the selected adapter can't be
  // resumed (empty resume_args - ADAPTERS.md), so safe-send has nowhere to
  // land a queued comment or draft request.
  function disabledReason(): string | null {
    const sel = props.selected;
    if (!sel?.sessionId) return "Select a session first";
    if (findAgent(sel.agent ?? "claude").resume_args.length === 0) return "This agent's sessions can't be resumed";
    return null;
  }

  async function refresh() {
    await refreshStatus(props.root);
  }

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
    try {
      setBaseBranch(await invoke<string | null>("git_default_base_branch", { projectPath: root }));
    } catch {
      setBaseBranch(null);
    }
  }

  async function refreshAll() {
    await Promise.all([refreshGit(props.root), refreshHeader(), loadStashes()]);
  }

  function toastError(e: unknown) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }

  async function stage(path: string) {
    const root = props.root;
    if (root) await stageFiles(root, [path]);
  }

  async function unstage(path: string) {
    const root = props.root;
    if (root) await unstageFiles(root, [path]);
  }

  /** Amend is the one form that needs nothing staged: rewriting only the
   *  message is a normal thing to want. Everything else still does. */
  const canCommit = () => !!commitSubject().trim() && (amend() || !!staged().length);

  function askConfirm(opts: Omit<ConfirmReq, "resolve">): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }

  async function commit() {
    const root = props.root;
    const message = composeCommitMessage(commitSubject(), commitBody());
    if (!root || !message || committing() || !canCommit()) return;
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
      // Scoped to this panel's root: the store is shared and a switch in flight
      // would otherwise answer with another workspace's counts, which fails
      // *open* here (no warning on a pushed commit).
      const ab = gitState().root === root ? aheadBehind() : null;
      if (amend() && amendRewritesPushed(ab)) {
        const ok = await askConfirm({
          title: "Amend a pushed commit?",
          message:
            "This commit looks like it is already on the upstream, so amending rewrites history others may have. That reading is only as fresh as your last fetch.",
          confirmLabel: "Amend anyway",
          danger: true,
        });
        if (!ok) return;
      }
      // The message is cleared only on success, so a rejected commit (an empty
      // author, a failing hook) does not also lose what you typed.
      if (await commitStaged(root, message, amend())) {
        setCommitSubject("");
        setCommitBody("");
        setPreAmendDraft(null);
        setAmend(false);
      }
    } finally {
      setCommitting(false);
    }
  }

  /** Toggling amend on prefills HEAD's message (stashing whatever was typed);
   *  toggling it back off restores that draft. */
  async function toggleAmend(on: boolean) {
    const root = props.root;
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
    const paths = staged().map((f) => f.path);
    if (!t || disabledReason() || !paths.length || drafting()) return;
    setDrafting(true);
    const text = `Draft a commit message for the staged changes: ${paths.join(", ")}`;
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
  async function askToResolve(file: string) {
    const t = target();
    const root = props.root;
    const reason = disabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return;
    }
    if (!t || !root || asking().has(file)) return;
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

  // Keyed by section+path (not path alone): a partially-staged file ("MM")
  // has a row in both the Staged and Changes sections, and each must expand
  // independently rather than sharing one toggle. The two rows also show
  // different diffs, hence the mode carried alongside.
  async function toggleDiff(key: string, path: string, staged: boolean) {
    if (expanded() === key) {
      setExpanded(null);
      setOpenDiff(null);
      return;
    }
    const root = props.root;
    if (!root) return;
    setOpenGaps(new Set<string>());
    setGapLines({});
    setOpenDiff({ path, staged });
    setDiff(await fileDiff(root, path, staged ? "staged" : "unstaged"));
    setExpanded(key);
  }

  async function fileDiff(root: string, path: string, mode?: DiffMode): Promise<string> {
    try {
      return await invoke<string>("git_diff_text", {
        projectPath: root,
        file: path,
        context: DIFF_CONTEXT,
        mode,
      });
    } catch {
      return "";
    }
  }

  // Re-fetch whatever diff is currently expanded. Called after a hunk apply and
  // whenever the open file changes on disk, so the rendered hunks (and the
  // fingerprints derived from them) never lag the file.
  async function refreshExpandedDiff() {
    const root = props.root;
    const open = openDiff();
    if (!root || !open) return;
    setDiff(await fileDiff(root, open.path, open.staged ? "staged" : "unstaged"));
    // The hunks just moved, so the cached gap contents no longer line up with
    // the ranges they were fetched for.
    setOpenGaps(new Set<string>());
    setGapLines({});
  }

  // Stage (or unstage) a single hunk. The fingerprint is the one derived from
  // the hunk as rendered; the backend re-reads the diff and refuses if it no
  // longer matches, so a stale view can never apply the wrong hunk. On any
  // failure the diff is refetched before the error surfaces, so the user is
  // never left looking at hunks that have already moved.
  async function applyHunk(path: string, staged: boolean, index: number, fingerprint: string) {
    const root = props.root;
    if (!root) return;
    await applied(() =>
      invoke("git_apply_hunks", {
        projectPath: root,
        file: path,
        hunkIndices: [index],
        fingerprints: [fingerprint],
        reverse: staged,
        context: DIFF_CONTEXT,
      }),
    );
  }

  /** Run one index-shuffling apply and put the view back in step with it.
   *
   *  Distinct from `busy` below, which holds the flag across a confirm dialog:
   *  this one also refetches. Both the status and the expanded diff have moved
   *  by the time an apply returns, and on failure the refetch happens *before*
   *  the error surfaces, so the user is never left looking at hunks that have
   *  already moved and inviting the same doomed click again. */
  async function applied(run: () => Promise<unknown>) {
    if (applying()) return;
    setApplying(true);
    try {
      await run();
      await Promise.all([refresh(), refreshExpandedDiff()]);
    } catch (e) {
      await refreshExpandedDiff();
      toastError(e);
    } finally {
      setApplying(false);
    }
  }

  /** Toggle one body line of one hunk into the selection.
   *
   *  Picking a line in a different hunk starts that hunk's selection rather than
   *  adding to the old one; see `picked`. Emptying a selection drops it, so the
   *  "N lines" control disappears with the last line rather than lingering as a
   *  disabled button. */
  function pickLine(hunk: number, line: number) {
    setPicked((prev) => {
      const lines = new Set(prev?.hunk === hunk ? prev.lines : []);
      if (!lines.delete(line)) lines.add(line);
      return lines.size ? { hunk, lines } : null;
    });
  }

  /** Stage (or unstage) just the selected lines of one hunk.
   *
   *  The same guarantees as `applyHunk`, one level finer: the fingerprint proves
   *  the hunk is still the one on screen, and the line indices are only
   *  meaningful against that same body, which is why the two travel together. */
  async function applyLines(path: string, staged: boolean, index: number, fingerprint: string, lines: number[]) {
    const root = props.root;
    if (!root) return;
    await applied(() =>
      invoke("git_apply_lines", {
        projectPath: root,
        file: path,
        hunkIndex: index,
        fingerprint,
        lines,
        reverse: staged,
        context: DIFF_CONTEXT,
      }),
    );
  }

  /** Throw away one unstaged hunk.
   *
   *  Unlike staging, this destroys work, so it asks first and says where the
   *  change goes. No `revertGuard` here on purpose: the blast radius is one
   *  hunk of one file the user is looking at, and blocking that on any session
   *  being busy anywhere in the folder would make the control unusable in the
   *  situation it is most wanted. Whole-file discard, which is unscoped, does
   *  consult it. */
  async function discardHunk(path: string, index: number, fingerprint: string) {
    const root = props.root;
    if (!root) return;
    await busy(async () => {
      try {
        const ok = await askConfirm({
          title: "Discard this hunk?",
          message: `This change to ${path} goes away. It is not staged, so git has no other copy of it.\n\nSway saves a snapshot first, so you can bring it back from Undo history in the timeline.`,
          confirmLabel: "Discard hunk",
          danger: true,
        });
        if (!ok) return;
        const outcome = await invoke<DiscardOutcome>("git_discard_hunks", {
          projectPath: root,
          file: path,
          hunkIndices: [index],
          fingerprints: [fingerprint],
          context: DIFF_CONTEXT,
        });
        reportDiscarded(outcome);
        await Promise.all([refresh(), refreshExpandedDiff()]);
      } catch (e) {
        // Refetched before the error surfaces, and this is the only reason this
        // one has its own catch rather than leaving it to `busy`: a refused
        // discard usually means the hunks moved, so leaving the old ones on
        // screen would invite the same doomed click again.
        await refreshExpandedDiff();
        throw e;
      }
    });
  }

  /** Run `action` only once no other session is mid-turn in this worktree.
   *
   *  Shared by whole-file discard and every stash action, because they share the
   *  hazard: each rewrites files across the whole worktree, so an agent mid-turn
   *  here can have its work clobbered or clobber the change a moment later. Two
   *  tiers, the same as a tree revert: a session verifiably Executing blocks
   *  hard, one Sway cannot see inside is overridable. `verb` names the action in
   *  the override, so the question reads as itself rather than as a revert. */
  async function guarded(verb: string, action: () => Promise<void>) {
    const root = props.root;
    if (!root) return;
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
  async function discardFile(path: string, untracked: boolean) {
    const root = props.root;
    if (!root) return;
    await busy(() =>
      guarded("Discard", async () => {
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
        await Promise.all([refresh(), refreshExpandedDiff()]);
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
      guarded("Stash", async () => {
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
        await Promise.all([refresh(), refreshExpandedDiff(), loadStashes()]);
      }),
    );
  }

  async function applyStash(entry: StashEntry, pop: boolean) {
    const root = props.root;
    if (!root) return;
    await busy(() =>
      guarded(pop ? "Pop" : "Apply", async () => {
        const outcome = await invoke<StashOutcome>("git_stash_apply", {
          projectPath: root,
          selector: entry.selector,
          pop,
        });
        // Same channel discard and checkpoint revert use: a stash laid back down
        // over an open buffer must offer Reload / Keep mine, not lose a side.
        props.onReverted?.({ backstop_ts: null, ...outcome });
        await Promise.all([refresh(), refreshExpandedDiff(), loadStashes()]);
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
      guarded("Drop", async () => {
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
  async function copyDiff(path: string) {
    const root = props.root;
    if (!root) return;
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

  function openFile(path: string) {
    const root = props.root;
    if (root) emitWith(OPEN_IN_EDITOR, { path: `${root}/${path}` });
  }

  createEffect(
    on(
      () => props.root,
      () => {
        setExpanded(null);
        setOpenDiff(null);
        setOpenGaps(new Set<string>());
        setGapLines({});
        refreshAll();
      },
    ),
  );

  // "Open PR" (task 3): push first if the branch is unpushed or ahead, then
  // open the provider's compare/new-MR/new-PR page for branch -> base.
  async function openPr() {
    const root = props.root;
    const branchName = branch();
    const org = origin();
    const base = baseBranch();
    if (!root || !branchName || !org || !base || openingPr()) return;
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

  let unlistenFs: UnlistenFn | undefined;
  let offAgentWrites: (() => void) | undefined;
  const agentWritten = new Set<string>();
  const flushAgentWrites = debounce(() => {
    const paths = [...agentWritten];
    agentWritten.clear();
    void refresh();
    const open = openDiff();
    if (open && paths.some((p) => p.endsWith(open.path))) void refreshExpandedDiff();
  }, AGENT_WRITE_DEBOUNCE_MS);
  let unlistenFetchDone: UnlistenFn | undefined;
  let unlistenFetchError: UnlistenFn | undefined;
  onMount(async () => {
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      void refresh();
      // A `git stash` run in a terminal shows up as a working-tree burst like
      // any other, and the entry it created would otherwise stay invisible
      // until a fetch or a window focus. Reading the stash reflog is far cheaper
      // than the status refresh already happening on this line.
      void loadStashes();
      // An agent writing the open file renumbers its hunks, so the expanded
      // diff must refetch or the next stage click would carry a stale
      // fingerprint (which the backend would refuse). Only the open file's own
      // burst does that, and refetching is not free: it also drops the gaps the
      // user expanded (see refreshExpandedDiff), so an unrelated burst would
      // snap them shut. Same predicate as the agent-writes handler below.
      //
      // `open.path` is porcelain's field, not necessarily a path (git.rs keeps
      // a rename's `old -> new` and git's quoting), so this is a suffix test
      // against the watcher's absolute paths rather than a path comparison.
      const open = openDiff();
      if (open && e.payload.paths.some((p) => p.endsWith(open.path))) void refreshExpandedDiff();
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

  // An unchanged stretch between two hunks. Collapsed it is a single clickable
  // row; expanded it shows the real file lines, fetched on demand because the
  // diff (taken at git's default context so a hunk stays a stageable unit)
  // simply does not contain them.
  function gapRow(gap: Gap, gapKey: string, path: string, staged: boolean) {
    const count = gap.end - gap.start + 1;
    return (
      <Show
        when={openGaps().has(gapKey)}
        fallback={
          <div
            class={`${diffRowClasses.line} ${styles.diffGap}`}
            onClick={() => void expandGap(gapKey, path, staged, gap)}
          >
            {`\u22ef ${count} unchanged line${count === 1 ? "" : "s"}`}
          </div>
        }
      >
        <For each={gapLines()[gapKey] ?? []}>
          {(text) =>
            twoColumn() ? (
              <div class={diffRowClasses.sideRow}>
                <div class={diffRowClasses.line}>{text || " "}</div>
                <div class={diffRowClasses.line}>{text || " "}</div>
              </div>
            ) : (
              <div class={diffRowClasses.line}>{text || " "}</div>
            )
          }
        </For>
      </Show>
    );
  }

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
  function conflictRow(f: FileStatus) {
    return (
      <div class={styles.conflictRowWrap}>
        <button
          type="button"
          class={`${styles.reviewRow} ${styles.conflictRow}`}
          onClick={() =>
            props.root && emitWith(OPEN_IN_EDITOR, { path: syntheticId("conflict", props.root, f.path) })
          }
          title={f.path}
        >
          <span class={`${styles.reviewStatus} ${styles.conflicted}`}>{f.status.trim() || "U"}</span>
          <span class={styles.reviewName}>{f.path}</span>
        </button>
        <Button
          size="xs"
          variant="ghost"
          class={styles.askButton}
          disabled={!!disabledReason() || asking().has(f.path)}
          title={disabledReason() ?? "Ask the selected session to resolve this conflict"}
          onClick={() => askToResolve(f.path)}
        >
          Ask agent
        </Button>
      </div>
    );
  }

  function row(f: FileStatus, opts: { staged: boolean }) {
    const key = `${opts.staged ? "staged" : "unstaged"}:${f.path}`;
    return (
      <div>
        <div class={styles.reviewRow} onClick={() => toggleDiff(key, f.path, opts.staged)} title={f.path}>
          <Button
            size="xs"
            variant="ghost"
            class={styles.stageToggle}
            aria-label={opts.staged ? "Unstage" : "Stage"}
            title={opts.staged ? "Unstage" : "Stage"}
            onClick={(e) => {
              e.stopPropagation();
              void (opts.staged ? unstage(f.path) : stage(f.path));
            }}
          >
            {opts.staged ? "−" : "+"}
          </Button>
          <span class={`${styles.reviewStatus} ${styles[statusClass(f.status)]}`}>{f.status.trim() || "?"}</span>
          <span
            class={styles.reviewName}
            onClick={(e) => {
              e.stopPropagation();
              openFile(f.path);
            }}
          >
            {/* A rename names both halves. Only `f.path` is clickable-through
                to a file; the source is gone from the worktree by definition. */}
            <Show when={f.orig_path}>
              <span class={styles.renameFrom}>{f.orig_path} → </span>
            </Show>
            {f.path}
          </span>
          <Button
            size="xs"
            variant="ghost"
            class={styles.rowAction}
            title="Copy diff"
            onClick={(e) => {
              e.stopPropagation();
              void copyDiff(f.path);
            }}
          >
            Copy
          </Button>
          {/* Unstaged rows only. A staged file's changes are safe in the index,
              so there is nothing here to destroy; unstage it and the row moves
              down to where discard lives. */}
          <Show when={!opts.staged}>
            <Button
              size="xs"
              variant="ghost"
              class={styles.rowAction}
              disabled={applying()}
              title={
                f.status.includes("?")
                  ? "Delete this file (it was never committed)"
                  : "Throw away the unstaged changes to this file"
              }
              onClick={(e) => {
                e.stopPropagation();
                void discardFile(f.path, f.status.includes("?"));
              }}
            >
              Discard
            </Button>
          </Show>
        </div>
        <Show when={expanded() === key}>
          <div class={styles.reviewDiff}>
            {/* Gaps are keyed by the hunk they follow (-1 = before the first),
                so they interleave with the hunks rather than living inside
                one. */}
            <For each={gaps().filter((g) => g.afterHunk === -1)}>
              {(gap) => gapRow(gap, `${key}:gap-1`, f.path, opts.staged)}
            </For>
            <For each={hunks()}>
              {(hunk, hi) => (
                <div>
                  {/* The hunk header is the shared control anchor: it renders
                      identically inline and side-by-side, so per-hunk actions
                      land in one place in both modes. */}
                  <div class={`${diffRowClasses.line} ${diffRowClasses.hunk} ${hunkStyles.hunkHeaderRow}`}>
                    <span>{hunk.header}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={applying()}
                      title={opts.staged ? "Unstage this hunk" : "Stage this hunk"}
                      onClick={(e) => {
                        e.stopPropagation();
                        // The fingerprint is derived from the hunk exactly as
                        // rendered, so the backend can prove it is still the
                        // same hunk before applying it.
                        void applyHunk(f.path, opts.staged, hi(), hunkFingerprint(hunk.header, hunk.lines));
                      }}
                    >
                      {opts.staged ? "Unstage hunk" : "Stage hunk"}
                    </Button>
                    {/* Only while this hunk has lines picked, so the header
                        stays the same width it always was until there is
                        something for the control to act on. */}
                    <Show when={picked()?.hunk === hi() ? picked() : null}>
                      {(sel) => (
                        <Button
                          size="xs"
                          disabled={applying()}
                          title={
                            opts.staged
                              ? "Unstage only the selected lines"
                              : "Stage only the selected lines"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            void applyLines(
                              f.path,
                              opts.staged,
                              hi(),
                              hunkFingerprint(hunk.header, hunk.lines),
                              [...sel().lines].sort((a, b) => a - b),
                            );
                          }}
                        >
                          {`${opts.staged ? "Unstage" : "Stage"} ${sel().lines.size} line${
                            sel().lines.size === 1 ? "" : "s"
                          }`}
                        </Button>
                      )}
                    </Show>
                    <Show when={!opts.staged}>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={applying()}
                        title="Throw away this hunk"
                        onClick={(e) => {
                          e.stopPropagation();
                          void discardHunk(f.path, hi(), hunkFingerprint(hunk.header, hunk.lines));
                        }}
                      >
                        Discard hunk
                      </Button>
                    </Show>
                    <HunkCommentInput
                      target={target()}
                      disabledReason={disabledReason()}
                      filePath={props.root ? `${props.root}/${f.path}` : f.path}
                      startLine={hunk.startLine}
                      endLine={hunk.endLine}
                    />
                  </div>
                  <DiffRows
                    rows={buildRows(hunk.lines)}
                    twoColumn={twoColumn()}
                    selection={{
                      has: (i) => picked()?.hunk === hi() && picked()!.lines.has(i),
                      toggle: (i) => pickLine(hi(), i),
                    }}
                  />
                  <For each={gaps().filter((g) => g.afterHunk === hi())}>
                    {(gap) => gapRow(gap, `${key}:gap${hi()}`, f.path, opts.staged)}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  }

  let panelRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!panelRef) return;
    const ro = new ResizeObserver(([entry]) => setPanelWidth(entry.contentRect.width));
    ro.observe(panelRef);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div class={styles.reviewPanel} ref={panelRef}>
      <Show when={props.root && branch()}>
        <div class={styles.headerBar}>
          <span class={styles.branchName} title={branch() ?? ""}>
            {branch()}
          </span>
          <IconButton
            size="xs"
            icon={<Icon icon={History} />}
            title="Show this branch's commit log"
            onClick={() =>
              props.root && emitWith(OPEN_IN_EDITOR, { path: syntheticId("log", props.root) })
            }
          />
          <IconButton
            size="xs"
            active={twoColumn()}
            icon={<span aria-hidden="true">⇹</span>}
            disabled={panelWidth() < SIDE_BY_SIDE_MIN_WIDTH}
            title={
              panelWidth() < SIDE_BY_SIDE_MIN_WIDTH
                ? "Side-by-side needs a wider panel"
                : twoColumn()
                  ? "Switch to inline diff"
                  : "Switch to side-by-side diff"
            }
            onClick={toggleSideBySide}
          />
          <Show
            when={aheadBehind()}
            fallback={<span class={styles.aheadBehind}>-</span>}
          >
            {(ab) => (
              <Button
                size="xs"
                disabled={pushing() || (ab().has_upstream && ab().ahead === 0)}
                title={ab().has_upstream ? "Push" : "Push (sets upstream)"}
                onClick={() => {
                  const root = props.root;
                  const branchName = branch();
                  if (root && branchName) void pushToOrigin(root, branchName);
                }}
              >
                {pushing()
                  ? "Pushing…"
                  : ab().has_upstream
                    ? `↑${ab().ahead} ↓${ab().behind}`
                    : "Unpushed branch"}
              </Button>
            )}
          </Show>
          <Show when={origin() && baseBranch()}>
            <Button size="xs" disabled={openingPr()} onClick={openPr}>
              {openingPr() ? "Opening…" : "Open PR"}
            </Button>
          </Show>
        </div>
      </Show>
      <CheckpointTimeline
        root={props.root}
        sessionId={props.selected?.sessionId ?? null}
        folderPath={props.selected?.folderPath ?? null}
        onReverted={(outcome) => {
          props.onReverted?.(outcome);
          void refreshAll();
        }}
      />
      <Show
        when={files().length}
        fallback={
          <div class="tree-empty">
            <p>No changes yet. Edit a file and it shows up here to stage, commit, and push.</p>
          </div>
        }
      >
        {/* First, because nothing below it can be finished until these are:
            git refuses to commit with unmerged paths in the index. */}
        <Show when={conflicts().length}>
          <div class={styles.sectionHeader}>Conflicts</div>
          <For each={conflicts()}>{(f) => conflictRow(f)}</For>
        </Show>
        <Show when={staged().length}>
          <div class={styles.sectionHeader}>Staged Changes</div>
          <For each={staged()}>{(f) => row(f, { staged: true })}</For>
        </Show>
        <Show when={unstaged().length}>
          <div class={styles.sectionHeader}>Changes</div>
          <For each={unstaged()}>{(f) => row(f, { staged: false })}</For>
        </Show>
      </Show>
      {/* Outside the empty-state Show above: a clean tree can still have
          stashes, and hiding them then would lose the only way back to them. */}
      <Show when={stashes().length}>
        <div class={styles.sectionHeader}>Stashes</div>
        <For each={stashes()}>
          {(s) => (
            <div
              class={styles.stashRow}
              title={`${s.selector}${s.branch ? ` on ${s.branch}` : ""} · ${s.relative_date}`}
            >
              <span class={styles.reviewName}>{s.message}</span>
              <span class={styles.stashMeta}>{s.relative_date}</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={applying()}
                title="Lay this stash back down and keep it in the list"
                onClick={() => void applyStash(s, false)}
              >
                Apply
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={applying()}
                title="Lay this stash back down and remove it from the list"
                onClick={() => void applyStash(s, true)}
              >
                Pop
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={applying()}
                title="Delete this stash without applying it"
                onClick={() => void dropStash(s)}
              >
                Drop
              </Button>
            </div>
          )}
        </For>
      </Show>
      <Show when={files().length}>
        <div class={styles.stashBar}>
          <label
            class={styles.amendRow}
            title="Also stash files git has never seen, which usually means build output and local scratch"
          >
            <input
              type="checkbox"
              checked={includeUntracked()}
              onChange={(e) => setIncludeUntracked(e.currentTarget.checked)}
            />
            include untracked
          </label>
          {/* Off while anything is unmerged: `git stash` refuses such a tree
              outright, so the button would only ever produce git's error. */}
          <Button
            size="xs"
            disabled={applying() || conflicts().length > 0}
            title={
              conflicts().length
                ? "Nothing can be stashed while a merge is unresolved. Finish the conflicts first."
                : "Put every change aside for later, named after the Summary below if you have written one"
            }
            onClick={() => void stashAll()}
          >
            Stash all
          </Button>
        </div>
      </Show>
      <div class={styles.commitBox}>
        <input
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
        <label class={styles.amendRow} title="Rewrite the last commit instead of adding one">
          <input type="checkbox" checked={amend()} onChange={(e) => void toggleAmend(e.currentTarget.checked)} />
          Amend last commit
        </label>
        <div class={styles.commitActions}>
          <Button
            size="sm"
            class={styles.draftButton}
            disabled={!staged().length || !!disabledReason() || drafting()}
            title={disabledReason() ?? "Ask the selected session to draft a commit message"}
            onClick={askAgentToDraft}
          >
            Ask agent to draft
          </Button>
          <Button
            variant="primary"
            size="sm"
            class={styles.commitButton}
            disabled={!canCommit() || committing()}
            title={amend() ? "Amend the last commit" : staged().length ? "Commit staged changes" : "Nothing staged"}
            onClick={commit}
          >
            {amend() ? "Amend" : "Commit"}
          </Button>
        </div>
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
    </div>
  );
}
