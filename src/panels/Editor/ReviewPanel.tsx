import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { parseDiffHunks } from "../../utils/diffHunks";
import { requestSend, type SessionTarget } from "../../utils/safeSend";
import { findAgent } from "../../utils/agents";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import HunkCommentInput from "./HunkCommentInput";
import hunkStyles from "./HunkCommentInput.module.css";
import styles from "./ReviewPanel.module.css";

type FileStatus = { status: string; path: string; staged: boolean; unstaged: boolean };

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
export default function ReviewPanel(props: { root: string | null; selected: Selection | null }) {
  const [files, setFiles] = createSignal<FileStatus[]>([]);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [diff, setDiff] = createSignal<string>("");
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [drafting, setDrafting] = createSignal(false);

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
      await refresh();
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
        refresh();
      },
    ),
  );

  let unlistenFs: UnlistenFn | undefined;
  let unlistenFetchDone: UnlistenFn | undefined;
  let unlistenFetchError: UnlistenFn | undefined;
  onMount(async () => {
    unlistenFs = await listen("fs://changed", () => refresh());
    // .git is watcher-filtered (gotchas), so a terminal-side commit/stage
    // emits no fs://changed - window focus and the askpass-bridge git
    // events (git_fetch today, git_push in phase 3) pick up the slack.
    unlistenFetchDone = await listen("git://fetch-done", () => refresh());
    unlistenFetchError = await listen("git://fetch-error", () => refresh());
    window.addEventListener("focus", refresh);
  });
  onCleanup(() => {
    unlistenFs?.();
    unlistenFetchDone?.();
    unlistenFetchError?.();
    window.removeEventListener("focus", refresh);
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
      <Show when={files().length} fallback={<div class="tree-empty">No changes</div>}>
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
