import { createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { parseDiffHunks } from "../../utils/diffHunks";
import { buildRows, hunkGaps, toSideBySide, type DiffRow, type Gap } from "../../utils/diffView";
import { hunkFingerprint } from "../../utils/hunkFingerprint";
import { copyText } from "../../utils/clipboard";
import { requestSend, type SessionTarget } from "../../utils/safeSend";
import { findAgent } from "../../utils/agents";
import { comparePrUrl } from "../../utils/prUrl";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import HunkCommentInput from "./HunkCommentInput";
import CheckpointTimeline, { type RevertOutcome } from "./CheckpointTimeline";
import hunkStyles from "./HunkCommentInput.module.css";
import styles from "./ReviewPanel.module.css";

type FileStatus = { status: string; path: string; staged: boolean; unstaged: boolean };
// Mirrors DiffMode in src-tauri/src/git.rs. "head" (the backend default) is
// worktree-vs-HEAD; the panel always asks for one of the other two, since a
// partially-staged file's two rows describe different comparisons.
type DiffMode = "staged" | "unstaged";
type BranchInfo = { name: string; current: boolean };
type AheadBehind = { ahead: number; behind: number; has_upstream: boolean };

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
// Below this the two columns are too narrow to read, so side-by-side falls
// back to inline regardless of the persisted preference.
const SIDE_BY_SIDE_MIN_WIDTH = 640;
const SIDE_BY_SIDE_KEY = "sway.review.sideBySide";

function rowClass(row: DiffRow): string {
  if (row.kind === "add") return "add";
  if (row.kind === "del") return "del";
  if (row.kind === "meta") return "meta";
  return "";
}

/** Changes panel: VS Code-style Staged / Changes sections over git_status's
 *  staged/unstaged split, with per-file stage/unstage, a manual commit box,
 *  and an "ask agent to draft" button routed through safe-send. Each file's
 *  inline diff toggle (git_diff_text) still carries the per-hunk "Comment"
 *  affordance from phase 1, routed to the sidebar's selected session. */
export default function ReviewPanel(props: {
  root: string | null;
  selected: Selection | null;
  onReverted?: (outcome: RevertOutcome) => void;
}) {
  const [files, setFiles] = createSignal<FileStatus[]>([]);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [diff, setDiff] = createSignal<string>("");
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [drafting, setDrafting] = createSignal(false);
  const [branch, setBranch] = createSignal<string | null>(null);
  const [aheadBehind, setAheadBehind] = createSignal<AheadBehind | null>(null);
  const [origin, setOrigin] = createSignal<string | null>(null);
  const [baseBranch, setBaseBranch] = createSignal<string | null>(null);
  const [pushing, setPushing] = createSignal(false);
  const [openingPr, setOpeningPr] = createSignal(false);
  const [sideBySide, setSideBySide] = createSignal(localStorage.getItem(SIDE_BY_SIDE_KEY) === "1");
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
    localStorage.setItem(SIDE_BY_SIDE_KEY, next ? "1" : "0");
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

  const staged = () => files().filter((f) => f.staged);
  const unstaged = () => files().filter((f) => f.unstaged);

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
    const root = props.root;
    if (!root) {
      setFiles([]);
      return;
    }
    try {
      setFiles(await invoke<FileStatus[]>("git_status", { projectPath: root }));
    } catch {
      setFiles([]);
    }
  }

  // Header state (current branch, ahead/behind, origin, PR base branch) -
  // kept separate from the file list since it has its own set of backend
  // calls; refreshed alongside `refresh()` at every trigger point.
  async function refreshHeader() {
    const root = props.root;
    if (!root) {
      setBranch(null);
      setAheadBehind(null);
      setOrigin(null);
      setBaseBranch(null);
      return;
    }
    try {
      const branches = await invoke<BranchInfo[]>("list_branches", { path: root });
      setBranch(branches.find((b) => b.current)?.name ?? null);
    } catch {
      setBranch(null);
    }
    try {
      setAheadBehind(await invoke<AheadBehind>("git_ahead_behind", { projectPath: root }));
    } catch {
      setAheadBehind(null);
    }
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
    await Promise.all([refresh(), refreshHeader()]);
  }

  function toastError(e: unknown) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }

  async function stage(path: string) {
    const root = props.root;
    if (!root) return;
    try {
      await invoke("git_stage", { projectPath: root, paths: [path] });
      await refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function unstage(path: string) {
    const root = props.root;
    if (!root) return;
    try {
      await invoke("git_unstage", { projectPath: root, paths: [path] });
      await refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function commit() {
    const root = props.root;
    const message = commitMsg().trim();
    if (!root || !message || committing() || !staged().length) return;
    setCommitting(true);
    try {
      await invoke("git_commit", { projectPath: root, message });
      setCommitMsg("");
      await refreshAll();
    } catch (e) {
      toastError(e);
    } finally {
      setCommitting(false);
    }
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

  // Resolves once `git://push-done|error` fires for `repo`, so a caller can
  // await a push before proceeding (e.g. "Open PR" pushing first). One-shot:
  // both listeners are torn down as soon as either fires.
  function waitForPush(repo: string): Promise<{ ok: boolean; error: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let unDone: UnlistenFn | undefined;
      let unError: UnlistenFn | undefined;
      const finish = (result: { ok: boolean; error: string }) => {
        if (settled) return;
        settled = true;
        unDone?.();
        unError?.();
        resolve(result);
      };
      listen<{ repo: string }>("git://push-done", (e) => {
        if (e.payload.repo === repo) finish({ ok: true, error: "" });
      }).then((un) => (settled ? un() : (unDone = un)));
      listen<{ repo: string; error: string }>("git://push-error", (e) => {
        if (e.payload.repo === repo) finish({ ok: false, error: e.payload.error });
      }).then((un) => (settled ? un() : (unError = un)));
    });
  }

  // Pushes `branch` to origin and waits for the result, toasting on failure
  // and refreshing the header (ahead/behind, upstream) on success.
  async function pushBranch(root: string, branchName: string): Promise<boolean> {
    if (pushing()) return false;
    setPushing(true);
    const result = waitForPush(root);
    try {
      await invoke("git_push", { repo: root, remote: "origin", branch: branchName });
    } catch (e) {
      setPushing(false);
      toastError(e);
      return false;
    }
    const { ok, error } = await result;
    setPushing(false);
    if (!ok) {
      toastError(error || "Push failed");
      return false;
    }
    await refreshHeader();
    return true;
  }

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
    if (needsPush && !(await pushBranch(root, branchName))) {
      setOpeningPr(false);
      return;
    }
    setOpeningPr(false);
    window.open(url, "_blank");
  }

  let unlistenFs: UnlistenFn | undefined;
  let unlistenFetchDone: UnlistenFn | undefined;
  let unlistenFetchError: UnlistenFn | undefined;
  onMount(async () => {
    unlistenFs = await listen("fs://changed", (e) => {
      void refresh();
      // An agent writing the open file renumbers its hunks, so the expanded
      // diff must refetch or the next stage click would carry a stale
      // fingerprint (which the backend would refuse).
      const changed = (e.payload as { path?: string } | null)?.path;
      const open = openDiff();
      if (!open || !changed || changed.endsWith(open.path)) void refreshExpandedDiff();
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
    unlistenFetchDone?.();
    unlistenFetchError?.();
    window.removeEventListener("focus", refreshAll);
  });

  // A line's text, with the changed tokens wrapped when the row was paired.
  function lineContent(r: DiffRow) {
    const segs = (r.kind === "del" || r.kind === "add") && r.segs;
    if (!segs) return "text" in r ? r.text || " " : " ";
    return (
      <For each={segs}>{(s) => (s.changed ? <span class={styles.wordChanged}>{s.text}</span> : <>{s.text}</>)}</For>
    );
  }

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
            class={`${styles.diffLine} ${styles.diffGap}`}
            onClick={() => void expandGap(gapKey, path, staged, gap)}
          >
            {`\u22ef ${count} unchanged line${count === 1 ? "" : "s"}`}
          </div>
        }
      >
        <For each={gapLines()[gapKey] ?? []}>
          {(text) =>
            twoColumn() ? (
              <div class={styles.sideRow}>
                <div class={styles.diffLine}>{text || " "}</div>
                <div class={styles.diffLine}>{text || " "}</div>
              </div>
            ) : (
              <div class={styles.diffLine}>{text || " "}</div>
            )
          }
        </For>
      </Show>
    );
  }

  function renderHunkBody(rows: DiffRow[]) {
    return (
      <Show
        when={twoColumn()}
        fallback={
          <For each={rows}>
            {(r) => <div class={`${styles.diffLine} ${styles[rowClass(r)] ?? ""}`}>{lineContent(r)}</div>}
          </For>
        }
      >
        {/* Side-by-side: one scroll container holding both columns, so the two
            sides scroll together by construction rather than by syncing. */}
        <div class={styles.sideBySide}>
          <For each={toSideBySide(rows)}>
            {(side) => (
              <div class={styles.sideRow}>
                <div class={`${styles.diffLine} ${side.left ? (styles[rowClass(side.left)] ?? "") : styles.sideEmpty}`}>
                  {side.left ? lineContent(side.left) : " "}
                </div>
                <div class={`${styles.diffLine} ${side.right ? (styles[rowClass(side.right)] ?? "") : styles.sideEmpty}`}>
                  {side.right ? lineContent(side.right) : " "}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    );
  }

  function row(f: FileStatus, opts: { staged: boolean }) {
    const key = `${opts.staged ? "staged" : "unstaged"}:${f.path}`;
    return (
      <div>
        <div class={styles.reviewRow} onClick={() => toggleDiff(key, f.path, opts.staged)} title={f.path}>
          <button
            type="button"
            class={styles.stageToggle}
            title={opts.staged ? "Unstage" : "Stage"}
            onClick={(e) => {
              e.stopPropagation();
              void (opts.staged ? unstage(f.path) : stage(f.path));
            }}
          >
            {opts.staged ? "−" : "+"}
          </button>
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
          <button
            type="button"
            class={styles.rowAction}
            title="Copy diff"
            onClick={(e) => {
              e.stopPropagation();
              void copyDiff(f.path);
            }}
          >
            Copy
          </button>
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
                  <div class={`${styles.diffLine} ${styles.hunk} ${hunkStyles.hunkHeaderRow}`}>
                    <span>{hunk.header}</span>
                    <button
                      type="button"
                      class={styles.hunkStage}
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
                    </button>
                    <HunkCommentInput
                      target={target()}
                      disabledReason={disabledReason()}
                      filePath={props.root ? `${props.root}/${f.path}` : f.path}
                      startLine={hunk.startLine}
                      endLine={hunk.endLine}
                    />
                  </div>
                  {renderHunkBody(buildRows(hunk.lines))}
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
          <button
            type="button"
            class={styles.viewToggle}
            classList={{ [styles.viewToggleOn]: twoColumn() }}
            disabled={panelWidth() < SIDE_BY_SIDE_MIN_WIDTH}
            title={
              panelWidth() < SIDE_BY_SIDE_MIN_WIDTH
                ? "Side-by-side needs a wider panel"
                : twoColumn()
                  ? "Switch to inline diff"
                  : "Switch to side-by-side diff"
            }
            onClick={toggleSideBySide}
          >
            ⇹
          </button>
          <Show
            when={aheadBehind()}
            fallback={<span class={styles.aheadBehind}>-</span>}
          >
            {(ab) => (
              <button
                type="button"
                class={styles.pushButton}
                disabled={pushing() || (ab().has_upstream && ab().ahead === 0)}
                title={ab().has_upstream ? "Push" : "Push (sets upstream)"}
                onClick={() => {
                  const root = props.root;
                  const branchName = branch();
                  if (root && branchName) void pushBranch(root, branchName);
                }}
              >
                {pushing()
                  ? "Pushing…"
                  : ab().has_upstream
                    ? `↑${ab().ahead} ↓${ab().behind}`
                    : "Unpushed branch"}
              </button>
            )}
          </Show>
          <Show when={origin() && baseBranch()}>
            <button type="button" class={styles.openPrButton} disabled={openingPr()} onClick={openPr}>
              {openingPr() ? "Opening…" : "Open PR"}
            </button>
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
          placeholder="Commit message"
          value={commitMsg()}
          onInput={(e) => setCommitMsg(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div class={styles.commitActions}>
          <button
            type="button"
            class={styles.draftButton}
            disabled={!staged().length || !!disabledReason() || drafting()}
            title={disabledReason() ?? "Ask the selected session to draft a commit message"}
            onClick={askAgentToDraft}
          >
            Ask agent to draft
          </button>
          <button
            type="button"
            class={styles.commitButton}
            disabled={!staged().length || !commitMsg().trim() || committing()}
            title={staged().length ? "Commit staged changes" : "Nothing staged"}
            onClick={commit}
          >
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}
