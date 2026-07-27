import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import { liveStatuses } from "../../utils/sessionStatus";
import { revertGuard, type RevertBlocker } from "../../utils/revertGuard";
import { folderActors } from "../../utils/folderActors";
import { attributionReliable, ATTRIBUTION_UNRELIABLE_NOTE } from "../../utils/chatConcurrency";
import { isUnderPath } from "../../utils/pathScope";
import Button from "../../components/Button/Button";
import styles from "./CheckpointTimeline.module.css";

type CheckpointEntry = {
  prompt_ts: number;
  kind: string;
  file_count: number;
  bytes: number;
};
type CheckpointFile = { path: string; status: string };
export type RevertOutcome = {
  backstop_ts: number | null;
  restored: string[];
  deleted: string[];
};
// Checkpoint timestamps are epoch *seconds* (parse_rfc3339_secs in
// sessions.rs), which Date() would otherwise read as milliseconds and render
// as 1970.
function shortTime(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/** The Changes panel's checkpoint timeline: a horizontal strip of the selected
 *  session's turn checkpoints, oldest to newest. Picking a turn shows that
 *  turn's files and diffs; the "workspace since here" toggle widens the range
 *  to the working tree as it is now (which is *not* the session's own work, and
 *  says so). "Revert tree to here" restores the whole working tree to the
 *  picked checkpoint, after the backend writes a backstop checkpoint first.
 *
 *  This is an extension of the Changes panel rather than a new mode: scrubbing
 *  is view-only, and reverting is a separate, explicit, confirmed action. */
export default function CheckpointTimeline(props: {
  root: string | null;
  sessionId: string | null;
  folderPath: string | null;
  /** Called after a successful revert with the paths it rewrote and removed,
   *  so open buffers can reload or raise a conflict rather than silently
   *  saving over the revert later. */
  onReverted?: (outcome: RevertOutcome) => void;
}) {
  const [entries, setEntries] = createSignal<CheckpointEntry[]>([]);
  const [picked, setPicked] = createSignal<number | null>(null);
  const [cumulative, setCumulative] = createSignal(false);
  const [files, setFiles] = createSignal<CheckpointFile[]>([]);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [diff, setDiff] = createSignal("");
  const [reverting, setReverting] = createSignal(false);

  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  function askConfirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }
  function resolveConfirm(v: boolean) {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  }

  function toastError(e: unknown) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }

  // Live-tab sessions in this folder that are mid-turn. Reactive and cheap, so
  // it can disable the button continuously; the detached tier needs a
  // subprocess probe and is therefore only checked at click time.
  const executingHere = () => {
    const folder = props.folderPath;
    if (!folder) return [];
    return liveStatuses().filter((s) => s.status === "executing" && isUnderPath(s.folderPath, folder));
  };

  async function loadEntries() {
    const root = props.root;
    const sessionId = props.sessionId;
    if (!root || !sessionId) {
      setEntries([]);
      setPicked(null);
      return;
    }
    const list = await invoke<CheckpointEntry[]>("checkpoint_list", {
      repoPath: root,
      sessionId,
    }).catch(() => [] as CheckpointEntry[]);
    setEntries(list);
    // Keep the current pick if it survived the refresh, else land on the newest.
    const current = picked();
    if (current !== null && list.some((e) => e.prompt_ts === current)) return;
    setPicked(list.length ? list[list.length - 1].prompt_ts : null);
  }

  async function loadFiles() {
    const root = props.root;
    const sessionId = props.sessionId;
    const ts = picked();
    if (!root || !sessionId || ts === null) {
      setFiles([]);
      return;
    }
    const list = await invoke<CheckpointFile[]>("checkpoint_turn_files", {
      repoPath: root,
      sessionId,
      promptTs: ts,
      cumulative: cumulative(),
    }).catch(() => [] as CheckpointFile[]);
    setFiles(list);
    setExpanded(null);
  }

  async function toggleDiff(path: string) {
    if (expanded() === path) {
      setExpanded(null);
      return;
    }
    const root = props.root;
    const sessionId = props.sessionId;
    const ts = picked();
    if (!root || !sessionId || ts === null) return;
    setDiff(
      await invoke<string>("checkpoint_diff_file", {
        repoPath: root,
        sessionId,
        promptTs: ts,
        file: path,
        cumulative: cumulative(),
      }).catch(() => ""),
    );
    setExpanded(path);
  }

  async function revertToPicked() {
    const root = props.root;
    const sessionId = props.sessionId;
    const folder = props.folderPath;
    const ts = picked();
    if (!root || !sessionId || !folder || ts === null || reverting()) return;

    // The detached probe is deliberate work, so it runs only here, when a
    // revert is actually requested.
    const candidates = await folderActors(folder);

    let verdict = revertGuard(candidates, { folderPath: folder });
    if (!verdict.allow && !verdict.overridable) {
      toastError(verdict.reason);
      return;
    }
    if (!verdict.allow) {
      // Detached-only block: unverifiable, so the user gets an explicit
      // "revert anyway" rather than a hard stop.
      const ok = await askConfirm({
        title: "Another session may be running here",
        message: `${verdict.reason}\n\nRevert anyway?`,
        confirmLabel: "Revert anyway",
        danger: true,
      });
      if (!ok) return;
      verdict = revertGuard(candidates, {
        folderPath: folder,
        allowDetached: true,
      });
      if (!verdict.allow) return;
    }

    const others = verdict.blockers.filter((b) => b.sessionId !== sessionId);
    const ok = await askConfirm({
      title: `Revert the whole tree to ${shortTime(ts)}?`,
      message: blastRadiusMessage(others),
      confirmLabel: "Revert tree",
      danger: true,
    });
    if (!ok) return;

    setReverting(true);
    try {
      const outcome = await invoke<RevertOutcome>("checkpoint_revert_tree", {
        repoPath: root,
        sessionId,
        promptTs: ts,
      });
      props.onReverted?.(outcome);
      await loadEntries();
      await loadFiles();
      emitWith<ToastEvent>(TOAST, {
        message:
          outcome.backstop_ts === null
            ? "Already at that checkpoint, nothing to revert."
            : `Reverted ${outcome.restored.length + outcome.deleted.length} file(s). The previous state is saved as a checkpoint.`,
        kind: "info",
      });
    } catch (e) {
      toastError(e);
    } finally {
      setReverting(false);
    }
  }

  function blastRadiusMessage(others: readonly RevertBlocker[]): string {
    const lines = ["Every file in this folder goes back to how it was at this checkpoint."];
    lines.push("Current state is saved as a checkpoint first, so this is reversible.");
    if (others.length) {
      const named = others.map((b) =>
        b.kind === "detached" ? `${b.sessionName} (possibly active, cannot verify)` : b.sessionName,
      );
      lines.push(`Also in this folder: ${named.join(", ")}.`);
    }
    return lines.join("\n\n");
  }

  function movePick(delta: number) {
    const list = entries();
    const current = picked();
    if (!list.length || current === null) return;
    const i = list.findIndex((e) => e.prompt_ts === current);
    const next = list[Math.min(Math.max(i + delta, 0), list.length - 1)];
    if (next) setPicked(next.prompt_ts);
  }

  createEffect(
    on(
      [() => props.root, () => props.sessionId],
      () => void loadEntries(),
    ),
  );
  createEffect(on([picked, cumulative], () => void loadFiles()));

  // checkpoint_list costs a `git diff --raw` per checkpoint plus a write-tree,
  // and an agent mid-turn emits fs://changed continuously, so the refresh is
  // debounced on the trailing edge: one rebuild per burst, not per event.
  let unlistenFs: UnlistenFn | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(async () => {
    unlistenFs = await listen("fs://changed", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void loadEntries(), 500);
    });
  });
  onCleanup(() => {
    unlistenFs?.();
    clearTimeout(refreshTimer);
  });

  const revertDisabledReason = () => {
    if (reverting()) return "A revert is already running";
    const busy = executingHere();
    if (busy.length) return `${busy.map((s) => s.sessionName).join(", ")} is running a turn right now`;
    if (picked() === null) return "Pick a point in the timeline first";
    return null;
  };

  return (
    <Show when={props.sessionId && entries().length}>
      <div class={styles.timeline}>
        <div class={styles.timelineHeader}>
          <span class={styles.timelineTitle}>Timeline</span>
          <label class={styles.cumulativeToggle} title="Compare this checkpoint against the working tree as it is now">
            <input type="checkbox" checked={cumulative()} onChange={(e) => setCumulative(e.currentTarget.checked)} />
            workspace since here
          </label>
        </div>
        {/* Roving-focus strip: one tab stop, left/right moves the pick, so the
            timeline is scrubbable without a mouse. */}
        <div
          class={styles.strip}
          role="listbox"
          tabindex="0"
          aria-label="Session checkpoints"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              movePick(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              movePick(1);
            }
          }}
        >
          <For each={entries()}>
            {(entry) => (
              <button
                type="button"
                role="option"
                aria-selected={picked() === entry.prompt_ts}
                class={`${styles.turnChip} ${picked() === entry.prompt_ts ? styles.turnChipActive : ""} ${
                  entry.kind === "backstop" ? styles.turnChipBackstop : ""
                }`}
                title={`${shortTime(entry.prompt_ts)} · ${entry.file_count} file(s) · ${shortSize(entry.bytes)}${
                  entry.kind === "backstop" ? " · saved before a revert" : ""
                }`}
                onClick={() => setPicked(entry.prompt_ts)}
              >
                <span class={styles.turnTime}>{shortTime(entry.prompt_ts)}</span>
                <span class={styles.turnCount}>{entry.kind === "backstop" ? "backstop" : entry.file_count}</span>
              </button>
            )}
          </For>
        </div>
        {/* Two chats share one working tree while `checkpoint.rs` still
            snapshots it whole, so a turn's file list can contain the other
            chat's edits. Say so rather than present it as fact; the phase that
            lands per-turn attribution removes this. */}
        <Show when={props.folderPath && !attributionReliable(props.folderPath)}>
          <div class={styles.attributionWarning}>{ATTRIBUTION_UNRELIABLE_NOTE}</div>
        </Show>
        <Show when={cumulative()}>
          <div class={styles.scopeHint}>
            Everything that changed in this folder since this point, including your own edits and any other session's
            work, not just this session's.
          </div>
        </Show>
        <div class={styles.timelineActions}>
          <Button
            size="sm"
            disabled={!!revertDisabledReason()}
            title={revertDisabledReason() ?? "Restore every file in this folder to this checkpoint"}
            onClick={revertToPicked}
          >
            {reverting() ? "Reverting…" : "Revert tree to here"}
          </Button>
        </div>
        <Show when={files().length} fallback={<div class={styles.timelineEmpty}>No file changes in this turn.</div>}>
          <For each={files()}>
            {(f) => (
              <div>
                <div class={styles.timelineRow} onClick={() => void toggleDiff(f.path)} title={f.path}>
                  <span class={`${styles.timelineStatus} ${styles[f.status]}`}>{f.status[0].toUpperCase()}</span>
                  <span
                    class={styles.timelineName}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (props.root)
                        emitWith(OPEN_IN_EDITOR, {
                          path: `${props.root}/${f.path}`,
                        });
                    }}
                  >
                    {f.path}
                  </span>
                </div>
                <Show when={expanded() === f.path}>
                  <div class={styles.timelineDiff}>
                    <For each={diff().split("\n")}>
                      {(line) => (
                        <div class={`${styles.diffLine} ${styles[diffLineClass(line)] ?? ""}`}>{line || " "}</div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
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
    </Show>
  );
}
