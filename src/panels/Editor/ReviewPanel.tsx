import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { parseDiffHunks } from "../../utils/diffHunks";
import { requestSend, type SessionTarget } from "../../utils/safeSend";
import { findAgent } from "../../utils/agents";
import { comparePrUrl } from "../../utils/prUrl";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import HunkCommentInput from "./HunkCommentInput";
import CheckpointTimeline, { type RevertOutcome } from "./CheckpointTimeline";
import hunkStyles from "./HunkCommentInput.module.css";
import styles from "./ReviewPanel.module.css";

type FileStatus = { status: string; path: string; staged: boolean; unstaged: boolean };
type BranchInfo = { name: string; current: boolean };
type AheadBehind = { ahead: number; behind: number; has_upstream: boolean };

// Map a porcelain XY code to a coarse class for the badge color.
function statusClass(status: string): string {
  if (status.includes("?")) return "untracked";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  return "modified";
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
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
  // independently rather than sharing one toggle.
  async function toggleDiff(key: string, path: string) {
    if (expanded() === key) {
      setExpanded(null);
      return;
    }
    const root = props.root;
    if (!root) return;
    try {
      setDiff(await invoke<string>("git_diff_text", { projectPath: root, file: path }));
    } catch {
      setDiff("");
    }
    setExpanded(key);
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
    unlistenFs = await listen("fs://changed", () => refresh());
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

  function row(f: FileStatus, opts: { staged: boolean }) {
    const key = `${opts.staged ? "staged" : "unstaged"}:${f.path}`;
    return (
      <div>
        <div class={styles.reviewRow} onClick={() => toggleDiff(key, f.path)} title={f.path}>
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
        </div>
        <Show when={expanded() === key}>
          <div class={styles.reviewDiff}>
            <For each={parseDiffHunks(diff())}>
              {(hunk) => (
                <div>
                  <div class={`${styles.diffLine} ${styles.hunk} ${hunkStyles.hunkHeaderRow}`}>
                    <span>{hunk.header}</span>
                    <HunkCommentInput
                      target={target()}
                      disabledReason={disabledReason()}
                      filePath={props.root ? `${props.root}/${f.path}` : f.path}
                      startLine={hunk.startLine}
                      endLine={hunk.endLine}
                    />
                  </div>
                  <For each={hunk.lines}>
                    {(line) => <div class={`${styles.diffLine} ${styles[diffLineClass(line)] ?? ""}`}>{line || " "}</div>}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  }

  return (
    <div class={styles.reviewPanel}>
      <Show when={props.root && branch()}>
        <div class={styles.headerBar}>
          <span class={styles.branchName} title={branch() ?? ""}>
            {branch()}
          </span>
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
