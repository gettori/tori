import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR, type FsChanged, type LiveTab } from "../../utils/events";
import type { AgentId } from "../../utils/agents";
import { isUnderPath } from "../../utils/pathScope";
import { parseDiffHunks } from "../../utils/diffHunks";
import type { SessionTarget } from "../../utils/safeSend";
import { findAdapter } from "../../utils/agents";
import { editingNow } from "../../utils/editingNow";
import HunkCommentInput from "./HunkCommentInput";
import hunkStyles from "./HunkCommentInput.module.css";
import styles from "./SessionPanel.module.css";
import Switch from "../../components/Switch/Switch";

function basename(path: string): string {
  return path.split("/").pop() || path;
}

type TouchOp = "read" | "create" | "edit" | "delete";
type TouchedFile = { path: string; op: TouchOp; first_ts: number; last_ts: number; count: number };
type SessionMetaLite = { id: string; path: string; agent?: string };

const OP_LABEL: Record<TouchOp, string> = { read: "R", create: "C", edit: "E", delete: "D" };
const OP_TITLE: Record<TouchOp, string> = {
  read: "Read",
  create: "Created",
  edit: "Edited",
  delete: "Deleted",
};

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/** Session mode: what this session touched (writes/creates/deletes by default, a
 *  toggle reveals reads), joined with git for an inline diff + click-to-open.
 *  Files outside the session's recorded cwd sit under an "outside project"
 *  bucket. Collision badges mark a file also touched by another *live* session
 *  (bounded to the live-tab set - no historical parse fan-out). */
export default function SessionPanel(props: {
  path: string | null;
  agent: AgentId;
  cwd: string | null;
  projectRoot: string | null;
  selfSessionId: string | null;
  liveTabs: LiveTab[];
}) {
  const [files, setFiles] = createSignal<TouchedFile[]>([]);
  const [showReads, setShowReads] = createSignal(false);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [diffs, setDiffs] = createSignal<Record<string, string>>({});
  const [collisions, setCollisions] = createSignal<Record<string, number>>({});
  // Guards against an out-of-order response: rapidly switching the selected
  // session while on the Session tab must not let a slower fetch for the
  // previously-selected session overwrite the newly-selected one's data
  // (the same race phase 2's loadTouchedCount fix addressed in LeftSidebar).
  let requestFor: string | null = null;

  async function refreshTouched() {
    const path = props.path;
    requestFor = path;
    if (!path) {
      setFiles([]);
      return;
    }
    const files = await invoke<TouchedFile[]>("session_touched_files", { path, agent: props.agent }).catch(
      () => [] as TouchedFile[],
    );
    if (requestFor !== path) return;
    setFiles(files);
  }

  // Bounded to sessions with a live tab under this folder (the same
  // list_sessions + liveTabs join the sidebar's countRunningAgents uses), so
  // this never fans out into a historical transcript scan.
  async function refreshCollisions() {
    const path = props.path;
    const root = props.projectRoot;
    const liveIds = new Set(
      props.liveTabs
        .filter((t) => t.kind === "agent" && t.sessionId && t.sessionId !== props.selfSessionId)
        .map((t) => t.sessionId!),
    );
    if (!root || !liveIds.size) {
      if (requestFor === path) setCollisions({});
      return;
    }
    const metas = await invoke<SessionMetaLite[]>("list_sessions", { folder: root }).catch(
      () => [] as SessionMetaLite[],
    );
    const live = metas.filter((m) => liveIds.has(m.id));
    const counts: Record<string, number> = {};
    await Promise.all(
      live.map(async (m) => {
        const agent = m.agent ?? "claude";
        const tf = await invoke<TouchedFile[]>("session_touched_files", { path: m.path, agent }).catch(
          () => [] as TouchedFile[],
        );
        for (const f of tf) {
          if (f.op === "read") continue;
          counts[f.path] = (counts[f.path] ?? 0) + 1;
        }
      }),
    );
    if (requestFor !== path) return;
    setCollisions(counts);
  }

  async function loadDiff(path: string) {
    const root = props.projectRoot;
    if (!root) return;
    try {
      const text = await invoke<string>("git_diff_text", { projectPath: root, file: path });
      setDiffs((d) => ({ ...d, [path]: text }));
    } catch {
      setDiffs((d) => ({ ...d, [path]: "" }));
    }
  }

  function toggleDiff(path: string) {
    const next = new Set(expanded());
    if (next.has(path)) {
      next.delete(path);
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    void loadDiff(path);
  }

  function openFile(path: string) {
    emitWith(OPEN_IN_EDITOR, { path });
  }

  function displayPath(path: string): string {
    const root = props.projectRoot;
    if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
    return path;
  }

  // This panel is always scoped to one session (props.selfSessionId), so a
  // hunk comment here always routes back to that same session.
  function target(): SessionTarget | null {
    if (!props.selfSessionId || !props.projectRoot) return null;
    return {
      sessionId: props.selfSessionId,
      agent: props.agent,
      folderPath: props.projectRoot,
      sessionCwd: props.cwd ?? undefined,
      sessionPath: props.path ?? undefined,
    };
  }

  // Capability gate: this panel only ever exists for a selected session, so
  // the sole remaining gate is whether that session's adapter can be resumed
  // (empty resume_args - ADAPTERS.md).
  function disabledReason(): string | null {
    if (!target()) return "Select a session first";
    return findAdapter(props.agent).resume_args.length === 0 ? "This agent's sessions can't be resumed" : null;
  }

  createEffect(
    on(
      () => [props.path, props.agent] as const,
      () => {
        setExpanded(new Set<string>());
        setDiffs({});
        refreshTouched();
        refreshCollisions();
      },
    ),
  );

  // Re-run collisions when the live-tab set itself changes (a session or its
  // tab appears/disappears), not just when this panel's own session changes.
  createEffect(
    on(
      () => props.liveTabs.map((t) => t.sessionId ?? "").join(","),
      () => refreshCollisions(),
    ),
  );

  let unlistenFs: UnlistenFn | undefined;
  let unlistenSessions: UnlistenFn | undefined;
  onMount(async () => {
    // fs://changed only refreshes the git join (diffs of already-expanded
    // rows) - the touched list itself is a transcript read, driven separately.
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      if (e.payload.root && e.payload.root !== props.projectRoot) return;
      for (const p of expanded()) void loadDiff(p);
    });
    unlistenSessions = await listen("sessions://changed", () => {
      refreshTouched();
      refreshCollisions();
    });
  });
  onCleanup(() => {
    unlistenFs?.();
    unlistenSessions?.();
  });

  const visible = () => files().filter((f) => showReads() || f.op !== "read");
  const inProject = () => visible().filter((f) => props.cwd && isUnderPath(f.path, props.cwd));
  const outsideProject = () => visible().filter((f) => !props.cwd || !isUnderPath(f.path, props.cwd));

  function row(f: TouchedFile) {
    const collision = collisions()[f.path] ?? 0;
    return (
      <div>
        <div class={styles.touchRow} onClick={() => toggleDiff(f.path)} title={f.path}>
          <span class={`${styles.opBadge} ${styles[f.op]}`} title={OP_TITLE[f.op]}>
            {OP_LABEL[f.op]}
          </span>
          <span
            class={styles.touchName}
            onClick={(e) => {
              e.stopPropagation();
              openFile(f.path);
            }}
          >
            {displayPath(f.path)}
          </span>
          <Show when={collision > 0}>
            <span class={styles.collisionBadge} title={`Also touched by ${collision} other running session${collision === 1 ? "" : "s"}`}>
              {collision + 1}
            </span>
          </Show>
        </div>
        <Show when={expanded().has(f.path)}>
          <div class={styles.touchDiff}>
            <For each={parseDiffHunks(diffs()[f.path] ?? "")}>
              {(hunk) => (
                <div>
                  <div class={`${styles.diffLine} ${styles.hunk} ${hunkStyles.hunkHeaderRow}`}>
                    <span>{hunk.header}</span>
                    <HunkCommentInput
                      target={target()}
                      disabledReason={disabledReason()}
                      filePath={f.path}
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
    <div class={styles.sessionPanel}>
      {/* Live "editing now". Composed in Editor, which owns both the transcript
          fetch and the fs watcher; this panel only renders it. The file-less
          variant is not a degraded bug but the honest reading: another agent is
          live in this folder, so the changed file cannot be attributed. */}
      <Show when={editingNow()}>
        {(e) => (
          <div class={styles.editingNow}>
            <span class={styles.editingDot}>●</span>
            <Show when={e().kind === "file"} fallback={<span>editing…</span>}>
              <span>
                editing <code>{basename((e() as { kind: "file"; path: string }).path)}</code>
              </span>
            </Show>
          </div>
        )}
      </Show>
      <Switch
        class={styles.readsToggle}
        checked={showReads()}
        onChange={setShowReads}
        label="Show reads"
      />
      <div class={styles.touchList}>
        <Show
          when={visible().length}
          fallback={
            <div class="tree-empty">
              <p>
                Nothing edited yet. Files this session creates or changes show up here.
                {!showReads() && " Turn on Show reads to include files it only looked at."}
              </p>
            </div>
          }
        >
          <For each={inProject()}>{row}</For>
          <Show when={outsideProject().length}>
            <div class={styles.bucketHeader}>Outside project</div>
            <For each={outsideProject()}>{row}</For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
