import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { parseDiffHunks } from "../../utils/diffHunks";
import { buildRows } from "../../utils/diffView";
import DiffRows, { diffRowClasses } from "../Editor/DiffRows";
import { reasoningFor, type ChatItem } from "./chatStore";
import { chatsInFolder } from "../../utils/chatSessions";
import { UNATTRIBUTED_NOTICE } from "../../utils/attribution";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import styles from "./SessionDiffView.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";

// The same session, read a different way.
//
// The transcript answers "what happened, in order". This answers "what is
// different now, and which step made it so" - the question you actually have
// when a long session ends and you are deciding whether to keep the work.
//
// Both views come off the same captured before-states (`chat/snapshot.rs`), so
// they cannot disagree about what changed. A file here is diffed from the
// session's earliest before-state to its current content, so a line rewritten
// four times appears once, at the value that is actually on disk.

/** One file's whole-session diff, from `chat_session_diff`. */
type SessionFileDiff = {
  path: string;
  diff: string;
  created: boolean;
  /** Parallel to the diff's hunks: the call whose write those lines last came
   *  from, or null when nothing claims them. */
  hunkToolUseIds: (string | null)[];
  toolUseIds: string[];
};

/** One checkpoint's view of a changed file, from `checkpoint_turn_files`. */
type CheckpointFile = {
  path: string;
  status: string;
  shared_with?: string[];
  unattributed?: boolean;
};

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

/** Checkpoint paths are repo-relative; the snapshot cache stores absolute ones.
 *  Compared in the checkpoint's coordinates, since that is the side that also
 *  carries the attribution. */
function relativeTo(cwd: string, path: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}


export default function SessionDiffView(props: {
  sessionId: string;
  cwd: string;
  items: readonly ChatItem[];
  /** Whether the session is still live. The before-states are held in memory
   *  for the running child, so a reopened session has none and this view has
   *  nothing to show - which is worth saying rather than rendering as "no
   *  changes". */
  live: boolean;
  /** Checkpoint timestamp of this run's first turn, which is the same span the
   *  in-memory before-states cover. Null before the first turn. Passed in
   *  rather than looked up: `checkpoint_list` would answer it too, at the cost
   *  of a `git diff --raw` per checkpoint, which on a long session is hundreds
   *  of git invocations for one number the caller already has. */
  sinceTs: number | null;
}) {
  const [openHunks, setOpenHunks] = createSignal<Set<string>>(new Set());
  const [width, setWidth] = createSignal(Infinity);
  let host: HTMLDivElement | undefined;

  // Same preference and same threshold as the Changes panel, so one hunk reads
  // one way across the app.
  const twoColumn = () => sideBySide() && width() >= SIDE_BY_SIDE_MIN_WIDTH;

  onMount(() => {
    if (!host) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const [files] = createResource(
    () => (props.live ? { sessionId: props.sessionId, cwd: props.cwd } : null),
    (args) => invoke<SessionFileDiff[]>("chat_session_diff", args).catch(() => [] as SessionFileDiff[]),
  );

  // The worktree's own account of the same span, so the view can show what
  // changed *around* this session as well as what it wrote itself. Without it
  // a shared worktree reads as if this session were the only writer in it.
  const [attribution] = createResource(
    () =>
      props.live && props.sinceTs !== null
        ? { sessionId: props.sessionId, cwd: props.cwd, sinceTs: props.sinceTs }
        : null,
    (args) =>
      invoke<CheckpointFile[]>("checkpoint_turn_files", {
        repoPath: args.cwd,
        sessionId: args.sessionId,
        // Cumulative from this run's first turn to now: the same span the
        // accumulated diff covers.
        promptTs: args.sinceTs,
        cumulative: true,
        others: chatsInFolder(args.cwd)
          .map((c) => c.sessionId)
          .filter((id) => id !== args.sessionId),
      }).catch(() => [] as CheckpointFile[]),
  );

  const attributionByPath = createMemo(() => {
    const map = new Map<string, CheckpointFile>();
    for (const f of attribution() ?? []) map.set(f.path, f);
    return map;
  });

  // Every file carrying a diff is one this session captured a before-state
  // for, so its authorship is never in doubt. The only open question is whether
  // another chat in the worktree wrote it too.
  function alsoWrittenBy(absPath: string): string[] {
    return attributionByPath().get(relativeTo(props.cwd, absPath))?.shared_with ?? [];
  }

  // Files the worktree changed that this session never wrote. Listed without a
  // diff, because Sway has no before-state for them: it can say they changed
  // and who (if anyone) claims them, and reconstructing more would be
  // invention. An empty `sessions` means nobody claims it at all.
  const foreignFiles = createMemo(() => {
    const mine = new Set((files() ?? []).map((f) => relativeTo(props.cwd, f.path)));
    return (attribution() ?? [])
      .filter((f) => !mine.has(f.path))
      .map((f) => ({ path: f.path, sessions: f.shared_with ?? [] }));
  });

  function toggleHunk(key: string) {
    setOpenHunks((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  return (
    <div class={styles.diffView} ref={host}>
      <Show when={props.live && (files() ?? []).length}>
        <div class={styles.viewBar}>
          <Tooltip
            as="button"
            type="button"
            class={styles.whyToggle}
            disabled={width() < SIDE_BY_SIDE_MIN_WIDTH}
            whenDisabled
            label={
              width() < SIDE_BY_SIDE_MIN_WIDTH
                ? "The panel is too narrow for two columns"
                : "Same preference as the Changes panel"
            }
            onClick={() => {
              writeSideBySide(!sideBySide());
            }}
          >
            {twoColumn() ? "Inline" : "Side by side"}
          </Tooltip>
        </div>
      </Show>
      <Show
        when={props.live}
        fallback={
          <div class={styles.empty}>
            This session is not running, so Sway no longer holds the before-states its diff is built from. The
            transcript above still has every turn.
          </div>
        }
      >
        <Show when={files.loading}>
          <div class={styles.empty}>Building the diff…</div>
        </Show>
        <Show when={!files.loading && !(files() ?? []).length}>
          <div class={styles.empty}>This session has not changed any files yet.</div>
        </Show>
        <For each={files() ?? []}>
          {(file) => (
            <div class={styles.file}>
              <div class={styles.fileHeader}>
                <span class={styles.filePath} title={file.path}>
                  {baseName(file.path)}
                </span>
                <Show when={file.created}>
                  <span class={styles.badge}>new file</span>
                </Show>
                <Show when={alsoWrittenBy(file.path).length}>
                  <span
                    class={styles.badge}
                    title={`Another chat in this worktree also wrote this file (${alsoWrittenBy(file.path).join(", ")}). What is below is this session's own edits; the file on disk carries both.`}
                  >
                    shared
                  </span>
                </Show>
                <span class={styles.callCount}>
                  {file.toolUseIds.length} {file.toolUseIds.length === 1 ? "edit" : "edits"}
                </span>
              </div>
              <For each={parseDiffHunks(file.diff)}>
                {(hunk, hi) => {
                  const key = () => `${file.path}:${hi()}`;
                  // The reasoning behind the call that produced these lines,
                  // collapsed: the hunk is the answer, the reasoning is the
                  // footnote, and a transcript's worth of prose inlined between
                  // every hunk would bury the diff it is explaining.
                  const why = () => {
                    const id = file.hunkToolUseIds[hi()];
                    return id ? reasoningFor(props.items, id) : null;
                  };
                  return (
                    <div>
                      <div class={`${diffRowClasses.line} ${diffRowClasses.hunk} ${styles.hunkHeader}`}>
                        <span>{hunk.header}</span>
                        <Show when={why()}>
                          <button
                            type="button"
                            class={styles.whyToggle}
                            aria-expanded={openHunks().has(key())}
                            onClick={() => toggleHunk(key())}
                          >
                            {openHunks().has(key()) ? "hide why" : "why"}
                          </button>
                        </Show>
                      </div>
                      <Show when={openHunks().has(key()) && why()}>
                        {(text) => <div class={styles.why}>{text()}</div>}
                      </Show>
                      <DiffRows rows={buildRows(hunk.lines)} twoColumn={twoColumn()} />
                    </div>
                  );
                }}
              </For>
            </div>
          )}
        </For>

        {/* Changed in this worktree, but not by this session. Shown without a
            diff on purpose: there is no captured before-state for them, so the
            honest answer is "this changed and here is who claims it", not a
            reconstruction. */}
        <Show when={foreignFiles().length}>
          <div class={styles.foreign}>
            <div class={styles.foreignHeading}>Changed by something else while this session ran</div>
            <For each={foreignFiles()}>
              {(f) => (
                <div class={styles.foreignRow}>
                  <span class={styles.filePath} title={f.path}>
                    {f.path}
                  </span>
                  <Show
                    when={f.sessions.length}
                    fallback={
                      <span class={styles.badge} title={UNATTRIBUTED_NOTICE}>
                        unattributed
                      </span>
                    }
                  >
                    <span class={styles.badge} title="Another chat in this worktree wrote this file.">
                      {f.sessions.join(", ")}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
