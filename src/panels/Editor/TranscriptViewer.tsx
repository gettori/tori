import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import Button from "../../components/Button/Button";
import type { LiveTab } from "../../utils/events";
import { UNATTRIBUTED_NOTICE } from "../../utils/attribution";
import styles from "./TranscriptViewer.module.css";

type TranscriptBlock = {
  kind: "text" | "thinking" | "tool_call" | "tool_result";
  text: string | null;
  tool_name: string | null;
  tool_input: unknown;
  is_error: boolean | null;
};
type TranscriptTurn = { role: "user" | "assistant" | "tool"; ts: number; blocks: TranscriptBlock[] };
type TranscriptPage = { turns: TranscriptTurn[]; next_cursor: number | null };

type CheckpointFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  /// Changed during the turn with no session claiming it. Listed because this
  /// turn ran a tool whose writes Sway cannot see (a shell command), so it is
  /// the likeliest author - likeliest, not established.
  unattributed?: boolean;
};

function fmtTime(epochSecs: number): string {
  return epochSecs ? new Date(epochSecs * 1000).toLocaleString() : "";
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

const REVERT_MESSAGE: Record<CheckpointFile["status"], (path: string) => string> = {
  added: (path) => `"${path}" was created during this turn. Reverting deletes it.`,
  deleted: (path) => `"${path}" was deleted during this turn. Reverting recreates it as it was before.`,
  modified: (path) => `"${path}" was edited during this turn. Reverting restores its content from before this turn.`,
};

/** Read-only transcript viewer: the turn list tail-first (newest at top), tool
 *  calls/results collapsed to a one-line summary. Live-refreshes on
 *  sessions://changed while at the tail (no older page loaded yet); once
 *  "Load older" is used the view is a frozen historical scroll. */
export default function TranscriptViewer(props: {
  sessionPath: string;
  agent: "claude" | "pi";
  sessionId: string;
  repoPath: string;
  liveTabs: LiveTab[];
  class?: string;
}) {
  const [turns, setTurns] = createSignal<TranscriptTurn[]>([]);
  const [nextCursor, setNextCursor] = createSignal<number | null>(null);
  const [atTail, setAtTail] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [openBlocks, setOpenBlocks] = createSignal<Set<string>>(new Set());

  // Per-turn checkpoint diffs (Finding E): keyed by the user turn's own `ts`,
  // which is also the checkpoint's prompt boundary (see checkpoint.rs). Lazy:
  // fetched only once a turn's "Changes this turn" row is expanded.
  const [checkpointOpen, setCheckpointOpen] = createSignal<Set<number>>(new Set());
  const [checkpointFiles, setCheckpointFiles] = createSignal<Record<number, CheckpointFile[]>>({});
  const [expandedFiles, setExpandedFiles] = createSignal<Set<string>>(new Set());
  const [fileDiffs, setFileDiffs] = createSignal<Record<string, string>>({});
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);

  function askConfirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }
  function resolveConfirm(v: boolean) {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  }

  function fileKey(ts: number, path: string): string {
    return `${ts}:${path}`;
  }

  async function loadCheckpointFiles(ts: number) {
    const files = await invoke<CheckpointFile[]>("checkpoint_turn_files", {
      repoPath: props.repoPath,
      sessionId: props.sessionId,
      promptTs: ts,
      // Without the other sessions in this workspace, a partial turn cannot
      // tell a change nobody wrote from one another chat wrote, and would offer
      // that chat's file for revert under an "unattributed" label.
      others: otherSessionsHere(),
    }).catch(() => [] as CheckpointFile[]);
    setCheckpointFiles((m) => ({ ...m, [ts]: files }));
  }

  function toggleCheckpoint(ts: number) {
    const next = new Set(checkpointOpen());
    if (next.has(ts)) {
      next.delete(ts);
    } else {
      next.add(ts);
      if (!checkpointFiles()[ts]) void loadCheckpointFiles(ts);
    }
    setCheckpointOpen(next);
  }

  async function loadFileDiff(ts: number, path: string) {
    const key = fileKey(ts, path);
    const text = await invoke<string>("checkpoint_diff_file", {
      repoPath: props.repoPath,
      sessionId: props.sessionId,
      promptTs: ts,
      file: path,
    }).catch(() => "");
    setFileDiffs((d) => ({ ...d, [key]: text }));
  }

  function toggleFileDiff(ts: number, path: string) {
    const key = fileKey(ts, path);
    const next = new Set(expandedFiles());
    if (next.has(key)) {
      next.delete(key);
      setExpandedFiles(next);
      return;
    }
    next.add(key);
    setExpandedFiles(next);
    void loadFileDiff(ts, path);
  }

  async function revertFile(ts: number, file: CheckpointFile) {
    // An unattributed file gets its own question rather than the ordinary one:
    // the backend refuses it unless this answer is passed back, because the
    // author may be a live agent in the same folder and the backstop restores
    // the bytes but not that agent's belief about them.
    const message = file.unattributed
      ? `${UNATTRIBUTED_NOTICE} ${REVERT_MESSAGE[file.status](file.path)}`
      : REVERT_MESSAGE[file.status](file.path);
    const ok = await askConfirm({
      title: `Revert ${file.path.split("/").pop()}?`,
      message,
      confirmLabel: "Revert",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("checkpoint_revert_file", {
        repoPath: props.repoPath,
        sessionId: props.sessionId,
        promptTs: ts,
        file: file.path,
        force: file.unattributed === true,
      });
      await loadCheckpointFiles(ts);
      const key = fileKey(ts, file.path);
      setFileDiffs((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
    } catch {
      // Best-effort: the file row simply won't refresh; the user can retry.
    }
  }

  // Agent tabs rooted at this session's repo, this one aside. The other
  // sessions' own recorded writes are what let a turn's file list rule a change
  // out as somebody else's rather than presenting it as unclaimed.
  const otherSessionsHere = () =>
    props.liveTabs
      .filter((t) => t.kind === "agent" && t.workspace === props.repoPath)
      .map((t) => t.sessionId ?? "")
      .filter((id) => id && id !== props.sessionId);
  // More than one live agent tab rooted at this session's repo: the turn's
  // diff may include another session's edits too, so its label says so.
  const sharesWorkspace = () =>
    props.liveTabs.filter((t) => t.kind === "agent" && t.workspace === props.repoPath).length > 1;
  // Guards against an out-of-order response: switching between two transcript
  // tabs before a slower fetch resolves must not overwrite the newly-active
  // tab's turns with the previous tab's data (same race class as SessionPanel).
  let requestFor: string | null = null;
  const requestKey = () => `${props.sessionPath}:${props.agent}`;

  async function loadLatest() {
    const key = requestKey();
    requestFor = key;
    const page = await invoke<TranscriptPage>("session_transcript", {
      path: props.sessionPath,
      agent: props.agent,
      cursor: null,
    }).catch(() => null);
    if (!page || requestFor !== key) return;
    setTurns(page.turns);
    setNextCursor(page.next_cursor);
    setAtTail(true);
    setOpenBlocks(new Set<string>());
  }

  async function loadOlder() {
    const cursor = nextCursor();
    if (cursor == null || loadingMore()) return;
    const key = requestKey();
    setLoadingMore(true);
    setAtTail(false);
    try {
      const page = await invoke<TranscriptPage>("session_transcript", {
        path: props.sessionPath,
        agent: props.agent,
        cursor,
      }).catch(() => null);
      if (page && requestFor === key) {
        setTurns((t) => [...t, ...page.turns]);
        setNextCursor(page.next_cursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  createEffect(
    on(
      () => [props.sessionPath, props.agent] as const,
      () => void loadLatest(),
    ),
  );

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen("sessions://changed", () => {
      if (atTail()) void loadLatest();
      // A live turn's checkpoint diff (against a live snapshot until the next
      // prompt lands) can change on every transcript write, so re-fetch any
      // already-open turn rather than waiting for the user to re-toggle.
      for (const ts of checkpointOpen()) void loadCheckpointFiles(ts);
    });
  });
  onCleanup(() => unlisten?.());

  function blockKey(ti: number, bi: number) {
    return `${ti}:${bi}`;
  }
  function toggleBlock(key: string) {
    const next = new Set(openBlocks());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenBlocks(next);
  }

  return (
    <div class={`${styles.viewer} ${props.class ?? ""}`}>
      <For each={turns()}>
        {(turn, ti) => (
          <div class={`${styles.turn} ${styles[turn.role] ?? ""}`}>
            <div class={styles.turnHeader}>
              <span class={styles.turnRole}>{turn.role}</span>
              <span class={styles.turnTime}>{fmtTime(turn.ts)}</span>
            </div>
            <For each={turn.blocks}>
              {(block, bi) => {
                const key = blockKey(ti(), bi());
                const collapsible = block.kind === "tool_call" || block.kind === "tool_result";
                return (
                  <div class={`${styles.block} ${styles[block.kind] ?? ""}`}>
                    <Show when={collapsible} fallback={<div class={styles.blockText}>{block.text}</div>}>
                      <div class={styles.blockSummary} onClick={() => toggleBlock(key)}>
                        <span class={styles.chevron} classList={{ [styles.open]: openBlocks().has(key) }}>
                          ▸
                        </span>
                        <span class={styles.toolName}>{block.tool_name ?? block.kind}</span>
                        <Show when={block.is_error}>
                          <span class={styles.errorBadge}>error</span>
                        </Show>
                      </div>
                      <Show when={openBlocks().has(key)}>
                        <pre class={styles.blockDetail}>
                          {block.kind === "tool_call" ? JSON.stringify(block.tool_input, null, 2) : block.text}
                        </pre>
                      </Show>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={turn.role === "user" && props.repoPath}>
              <div class={styles.checkpoint}>
                <div class={styles.checkpointToggle} onClick={() => toggleCheckpoint(turn.ts)}>
                  <span class={styles.chevron} classList={{ [styles.open]: checkpointOpen().has(turn.ts) }}>
                    ▸
                  </span>
                  <span>{sharesWorkspace() ? "Changes in this workspace during this turn" : "Changes this turn"}</span>
                </div>
                <Show when={checkpointOpen().has(turn.ts)}>
                  <Show
                    when={(checkpointFiles()[turn.ts] ?? []).length}
                    fallback={<div class={styles.checkpointEmpty}>This turn changed no files.</div>}
                  >
                    <For each={checkpointFiles()[turn.ts]}>
                      {(file) => {
                        const key = () => fileKey(turn.ts, file.path);
                        return (
                          <div>
                            <div class={styles.checkpointRow}>
                              <span class={`${styles.opBadge} ${styles[file.status]}`}>{file.status[0].toUpperCase()}</span>
                              <span class={styles.checkpointPath} onClick={() => toggleFileDiff(turn.ts, file.path)}>
                                {file.path}
                              </span>
                              <Show when={file.unattributed}>
                                <span class={styles.unattributed} title={UNATTRIBUTED_NOTICE}>
                                  unattributed
                                </span>
                              </Show>
                              <Button size="xs" onClick={() => revertFile(turn.ts, file)}>
                                Revert
                              </Button>
                            </div>
                            <Show when={expandedFiles().has(key())}>
                              <div class={styles.checkpointDiff}>
                                <For each={(fileDiffs()[key()] ?? "").split("\n")}>
                                  {(line) => (
                                    <div class={`${styles.diffLine} ${styles[diffLineClass(line)] ?? ""}`}>
                                      {line || " "}
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </For>
      <Show when={nextCursor() != null}>
        <Button class={styles.loadOlder} size="sm" onClick={loadOlder} disabled={loadingMore()}>
          {loadingMore() ? "Loading…" : "Load older"}
        </Button>
      </Show>
      <Show when={!turns().length}>
        <div class="tree-empty">
          <p>No turns yet. Prompt the agent in the terminal (⌘J) and the conversation appears here.</p>
        </div>
      </Show>
      <Show when={confirmReq()}>
        <ConfirmDialog
          title={confirmReq()!.title}
          message={confirmReq()!.message}
          confirmLabel={confirmReq()!.confirmLabel}
          danger={confirmReq()!.danger}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      </Show>
    </div>
  );
}
