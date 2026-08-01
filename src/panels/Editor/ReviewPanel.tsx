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
import { requestSend, type SessionTarget } from "../../utils/safeSend";
import { findAgent } from "../../utils/agents";
import { comparePrUrl } from "../../utils/prUrl";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import HunkCommentInput from "./HunkCommentInput";
import CheckpointTimeline, { type RevertOutcome } from "./CheckpointTimeline";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import hunkStyles from "./HunkCommentInput.module.css";
import styles from "./ReviewPanel.module.css";

// Mirrors DiffMode in src-tauri/src/git.rs. "head" (the backend default) is
// worktree-vs-HEAD; the panel always asks for one of the other two, since a
// partially-staged file's two rows describe different comparisons.
type DiffMode = "staged" | "unstaged";

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
  const [origin, setOrigin] = createSignal<string | null>(null);
  const [baseBranch, setBaseBranch] = createSignal<string | null>(null);
  const [openingPr, setOpeningPr] = createSignal(false);
  const [sideBySide, setSideBySide] = createSignal(readSideBySide());
  // Which file the expanded diff belongs to, and which of its two sections:
  // needed to refetch the right diff after a hunk apply or a disk change.
  const [openDiff, setOpenDiff] = createSignal<{ path: string; staged: boolean } | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [panelWidth, setPanelWidth] = createSignal(Infinity);
  // Which collapsed regions the user opened, keyed hunk:row. Cleared whenever a
  // different file expands, so collapse state never leaks between files.
  const [openGaps, setOpenGaps] = createSignal<Set<string>>(new Set());
  // Fetched contents of expanded gaps, keyed the same way.
  const [gapLines, setGapLines] = createSignal<Record<string, string[]>>({});

  // One parse per diff change, shared by every consumer below: the hunk list,
  // the gaps between them, and the per-hunk fingerprints.
  const hunks = createMemo(() => parseDiffHunks(diff()));
  const gaps = createMemo(() => hunkGaps(hunks()));

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
    await Promise.all([refreshGit(props.root), refreshHeader()]);
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
    if (!root || applying()) return;
    setApplying(true);
    try {
      await invoke("git_apply_hunks", {
        projectPath: root,
        file: path,
        hunkIndices: [index],
        fingerprints: [fingerprint],
        reverse: staged,
        context: DIFF_CONTEXT,
      });
      await Promise.all([refresh(), refreshExpandedDiff()]);
    } catch (e) {
      await refreshExpandedDiff();
      toastError(e);
    } finally {
      setApplying(false);
    }
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
                    <HunkCommentInput
                      target={target()}
                      disabledReason={disabledReason()}
                      filePath={props.root ? `${props.root}/${f.path}` : f.path}
                      startLine={hunk.startLine}
                      endLine={hunk.endLine}
                    />
                  </div>
                  <DiffRows rows={buildRows(hunk.lines)} twoColumn={twoColumn()} />
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
        <Show when={staged().length}>
          <div class={styles.sectionHeader}>Staged Changes</div>
          <For each={staged()}>{(f) => row(f, { staged: true })}</For>
        </Show>
        <Show when={unstaged().length}>
          <div class={styles.sectionHeader}>Changes</div>
          <For each={unstaged()}>{(f) => row(f, { staged: false })}</For>
        </Show>
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
