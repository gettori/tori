import { createSignal, createEffect, createMemo, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ChevronLeft, ChevronRight, CircleDashed, Columns2, FileCode, KeyRound } from "lucide-solid";
import {
  emitWith,
  OPEN_IN_EDITOR,
  REWIND_CHAT,
  TOAST,
  type FsChanged,
  type RewindChat,
  type ToastEvent,
} from "../../utils/events";
import ConfirmDialog, { type ConfirmReq, type ConfirmOpts } from "../../components/Dialogs/ConfirmDialog";
import { liveSessionStatuses } from "../../utils/sessionActivity";
import { revertGuard, type RevertBlocker } from "../../utils/revertGuard";
import { folderActors } from "../../utils/folderActors";
import { chatsInFolder, liveChats } from "../../utils/chatSessions";
import { findSession } from "../../utils/sessionStore";
import type { SecretTurn } from "../../utils/secretReads";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import { isWorking } from "../../utils/sessionStatus";
import { UNATTRIBUTED_NOTICE } from "../../utils/attribution";
import { checkpointClock, checkpointDiffTabId, WORKTREE_SOURCE, type CheckpointScope } from "../../utils/syntheticTabs";
import { parseDiffHunks } from "../../utils/diffHunks";
import { buildRows } from "../../utils/diffView";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import SegmentedControl from "../../components/SegmentedControl/SegmentedControl";
import Tooltip from "../../components/Tooltip/Tooltip";
import DiffRows, { diffRowClasses } from "./DiffRows";
import { checkpointFileDiff } from "./CheckpointDiffView";
import styles from "./CheckpointTimeline.module.css";

const DOT = "\u00b7";

/** How far a checkpoint's timestamp may sit from its prompt's. A chat stamps
 *  the checkpoint itself and the harness stamps the transcript, so the two
 *  drift by a second or two; past this the nearest prompt is a different one. */
const PROMPT_DRIFT_SECS = 15;

/** How many files a detail lists before the rest fold behind "+N more". */
const FILES_SHOWN = 7;

type CheckpointEntry = {
  prompt_ts: number;
  kind: string;
  /** The checkpoint a backstop was taken on the way to, when its ref says. */
  target_ts?: number | null;
  file_count: number;
  bytes: number;
};
type CheckpointFile = {
  path: string;
  status: string;
  added?: number;
  removed?: number;
  // Other live sessions that also wrote this file in an overlapping turn.
  // Non-empty means the change is genuinely not this session's alone, which the
  // row says rather than resolving in favour of whoever asked.
  shared_with?: string[];
  // Changed during the turn with no session claiming it, on a turn that ran a
  // tool whose writes Tori cannot see. The likeliest author is this session,
  // which is not the same as knowing, so a revert leaves it alone.
  unattributed?: boolean;
};
export type RevertOutcome = {
  backstop_ts: number | null;
  restored: string[];
  deleted: string[];
};
/** A pre-discard snapshot of the working tree, owned by this *worktree* rather
 *  than by a session: nobody has to be chatting for one to exist, so these are
 *  listed even when no session has a checkpoint here. */
type BackstopRecord = {
  ts: number;
  tree: string;
  worktree_path: string;
  head: string;
  label: string;
};
type RestoreOutcome = { restored: string[]; deleted: string[] };
type PromptLine = { ts: number; text: string };

type Surface = "chat" | "terminal" | null;
type SessionEntries = { sessionId: string; entries: CheckpointEntry[] };
type SessionGroup = { sessionId: string; name: string; surface: Surface; turns: CheckpointEntry[] };
type BackstopRow = { ts: number; label: string; sessionId: string | null };
/** The row whose detail is open. A backstop with no session is the worktree's. */
type Target = { kind: "turn" | "backstop"; sessionId: string | null; ts: number };

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const targetKey = (t: Target) => `${t.kind}:${t.sessionId ?? WORKTREE_SOURCE}:${t.ts}`;
const isList = <T,>(v: unknown): v is T[] => Array.isArray(v);

const SURFACE_LABEL: Record<"chat" | "terminal", string> = { chat: "Chat", terminal: "Terminal" };
const surfaceLabel = (s: Surface) => (s ? SURFACE_LABEL[s] : "Session");

/** The prompt a checkpoint was taken at, or null when the transcript holds
 *  none close enough to be the one. */
export function promptTitle(prompts: readonly PromptLine[] | undefined, ts: number): string | null {
  let best: PromptLine | null = null;
  for (const p of prompts ?? []) {
    if (!best || Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
  }
  return best && Math.abs(best.ts - ts) <= PROMPT_DRIFT_SECS ? best.text : null;
}

/** The secret reads of the turn a checkpoint was taken at, joined the way
 *  `promptTitle` joins its prompt. */
export function turnSecret(turns: readonly SecretTurn[] | undefined, ts: number): SecretTurn | null {
  let best: SecretTurn | null = null;
  for (const t of turns ?? []) {
    if (t.promptTs === null) continue;
    if (!best || Math.abs(t.promptTs - ts) < Math.abs(best.promptTs! - ts)) best = t;
  }
  return best && Math.abs(best.promptTs! - ts) <= PROMPT_DRIFT_SECS ? best : null;
}

/** The Changes panel's checkpoints: every turn checkpoint taken in this
 *  worktree, grouped by the session that took it, over the backstops written
 *  before a revert or a discard. A row opens its detail in place: the files
 *  that turn changed, or everything that has changed since, each with its diff.
 *
 *  Browsing is view-only. Reverting the tree and rewinding the chat are
 *  separate, explicit, confirmed actions at the foot of a detail. */
export default function CheckpointTimeline(props: {
  root: string | null;
  sessionId: string | null;
  folderPath: string | null;
  /** Called after a successful revert with the paths it rewrote and removed,
   *  so open buffers can reload or raise a conflict rather than silently
   *  saving over the revert later. */
  onReverted?: (outcome: RevertOutcome) => void;
  /** How many turn checkpoints the list holds, for a count drawn outside it. */
  onCount?: (n: number) => void;
}) {
  const [listed, setListed] = createSignal<SessionEntries[]>([]);
  const [prompts, setPrompts] = createSignal<Record<string, PromptLine[]>>({});
  const [secrets, setSecrets] = createSignal<Record<string, SecretTurn[]>>({});
  const [backstops, setBackstops] = createSignal<BackstopRecord[]>([]);
  const [open, setOpen] = createSignal<Target | null>(null);
  const [lastOpened, setLastOpened] = createSignal<string | null>(null);
  const [scope, setScope] = createSignal<CheckpointScope>("turn");
  const [turnFiles, setTurnFiles] = createSignal<CheckpointFile[]>([]);
  const [sinceFiles, setSinceFiles] = createSignal<CheckpointFile[]>([]);
  const [showAll, setShowAll] = createSignal(false);
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

  /** Who a session is and where it runs. A chat is asked first: it mints its
   *  id before any transcript exists, so the session store may not know it. */
  function describe(id: string): { name: string; surface: Surface; folder: string | null } {
    const chat = liveChats().find((c) => c.sessionId === id);
    if (chat) return { name: chat.sessionName, surface: "chat", folder: chat.folderPath };
    const tab = liveSessionStatuses().find((s) => s.sessionId === id);
    if (tab) return { name: tab.sessionName, surface: "terminal", folder: tab.folderPath };
    const stored = findSession(id)?.session;
    return { name: stored?.name || stored?.title || id.slice(0, 8), surface: null, folder: stored?.cwd ?? null };
  }

  const groups = createMemo<SessionGroup[]>(() => {
    const out = listed()
      .map(({ sessionId, entries }) => ({
        sessionId,
        ...describe(sessionId),
        turns: entries.filter((e) => e.kind !== "backstop").reverse(),
      }))
      .filter((g) => g.turns.length);
    const rank = (g: SessionGroup) => (g.sessionId === props.sessionId ? Infinity : g.turns[0].prompt_ts);
    return out.sort((a, b) => rank(b) - rank(a));
  });

  const backstopRows = createMemo<BackstopRow[]>(() => {
    const ofSessions = listed().flatMap(({ sessionId, entries }) =>
      entries
        .filter((e) => e.kind === "backstop")
        .map((e) => ({
          ts: e.prompt_ts,
          label: e.target_ts ? `Before revert to ${checkpointClock(e.target_ts)}` : "Before a revert",
          sessionId,
        })),
    );
    const ofWorktree = backstops().map((b) => ({ ts: b.ts, label: b.label, sessionId: null }));
    return [...ofSessions, ...ofWorktree].sort((a, b) => b.ts - a.ts);
  });

  createEffect(() => props.onCount?.(groups().reduce((n, g) => n + g.turns.length, 0)));

  const titleOf = (sessionId: string, ts: number) => promptTitle(prompts()[sessionId], ts) ?? "Untitled turn";

  // The newest turn each session's prompts were last read for. A transcript is
  // read whole, so it is read again only when a turn it cannot name has landed.
  const promptsReadAt = new Map<string, number>();

  async function loadPrompts(list: readonly SessionEntries[]) {
    await Promise.all(
      list.map(async ({ sessionId, entries }) => {
        const newest = entries[entries.length - 1]?.prompt_ts;
        const meta = findSession(sessionId)?.session;
        if (newest === undefined || !meta || promptsReadAt.get(sessionId) === newest) return;
        const lines = await invoke<PromptLine[]>("session_prompts", {
          path: meta.path,
          agent: meta.agent ?? "claude",
        }).catch(() => null);
        if (!isList<PromptLine>(lines)) return;
        promptsReadAt.set(sessionId, newest);
        setPrompts((prev) => ({ ...prev, [sessionId]: lines }));
      }),
    );
  }

  // Not gated like the prompts: a pattern added in settings changes the answer
  // for a transcript that did not move, and the backend's cache keys on both.
  async function loadSecrets(list: readonly SessionEntries[]) {
    await Promise.all(
      list.map(async ({ sessionId }) => {
        const meta = findSession(sessionId)?.session;
        if (!meta) return;
        const turns = await invoke<SecretTurn[]>("session_secrets", {
          sessionId,
          agentId: meta.agent ?? "claude",
          cwd: meta.cwd,
        }).catch(() => null);
        if (!isList<SecretTurn>(turns)) return;
        setSecrets((prev) => ({ ...prev, [sessionId]: turns }));
      }),
    );
  }

  // Which read is current: the root can change while one is in flight, and the
  // earlier root's sessions must not land over the later one's.
  let listRead = 0;

  async function loadList() {
    const mine = ++listRead;
    const root = props.root;
    if (!root) {
      setListed([]);
      return;
    }
    const found = await invoke<string[]>("checkpoint_sessions", { repoPath: root }).catch(() => null);
    const ids = new Set(isList<string>(found) ? found : []);
    if (props.sessionId) ids.add(props.sessionId);
    // The refs are shared by every worktree of the repo, so a sibling
    // worktree's sessions are in the answer too. The selected session is kept
    // whatever its folder: a Topic chat runs from the Topic's home.
    const here = [...ids].filter((id) => {
      if (id === props.sessionId) return true;
      const folder = describe(id).folder;
      return !!folder && !!props.folderPath && sameCwd(folder, props.folderPath);
    });
    // A failed read keeps what was there. The list snapshots through a scratch
    // index a turn in flight may be holding, and reading that as "no
    // checkpoints" would empty the session's rows for one refresh.
    const before = listed();
    const list = await Promise.all(
      here.map(async (sessionId) => {
        const entries = await invoke<CheckpointEntry[]>("checkpoint_list", { repoPath: root, sessionId }).catch(
          () => null,
        );
        const kept = before.find((s) => s.sessionId === sessionId)?.entries ?? [];
        return { sessionId, entries: isList<CheckpointEntry>(entries) ? entries : kept };
      }),
    );
    if (mine !== listRead) return;
    setListed(list);
    void loadPrompts(list);
    void loadSecrets(list);
  }

  /** Keyed on the worktree alone, so this runs whether or not a session is
   *  selected. */
  async function loadBackstops() {
    const root = props.root;
    if (!root) {
      setBackstops([]);
      return;
    }
    const list = await invoke<BackstopRecord[]>("backstop_list", { repoPath: root }).catch(() => null);
    setBackstops(isList<BackstopRecord>(list) ? list : []);
  }

  // The worktree's other chats, so a file more than one of them wrote is
  // marked instead of being silently attributed to this one.
  const othersThan = (sessionId: string) =>
    chatsInFolder(props.folderPath ?? "")
      .map((c) => c.sessionId)
      .filter((id) => id !== sessionId);

  function turnFilesOf(sessionId: string, ts: number, cumulative: boolean): Promise<CheckpointFile[]> {
    return invoke<CheckpointFile[]>("checkpoint_turn_files", {
      repoPath: props.root,
      sessionId,
      promptTs: ts,
      cumulative,
      others: othersThan(sessionId),
    });
  }

  let filesRead = 0;

  async function loadFiles() {
    const mine = ++filesRead;
    const target = open();
    const root = props.root;
    if (!target || !root) {
      setTurnFiles([]);
      setSinceFiles([]);
      return;
    }
    const safe = (read: Promise<CheckpointFile[]>) =>
      read.then((list) => (isList<CheckpointFile>(list) ? list : [])).catch(() => [] as CheckpointFile[]);
    const { sessionId, ts } = target;
    const [turn, since] = await Promise.all([
      sessionId && target.kind === "turn" ? safe(turnFilesOf(sessionId, ts, false)) : Promise.resolve([]),
      sessionId
        ? safe(turnFilesOf(sessionId, ts, true))
        : safe(invoke<CheckpointFile[]>("backstop_files", { repoPath: root, ts })),
    ]);
    if (mine !== filesRead) return;
    setTurnFiles(turn);
    setSinceFiles(since);
  }

  const activeScope = (): CheckpointScope => (open()?.kind === "turn" ? scope() : "since");
  const files = () => (activeScope() === "turn" ? turnFiles() : sinceFiles());
  const shownFiles = () => (showAll() ? files() : files().slice(0, FILES_SHOWN));

  const diffTarget = (target: Target, file: string) => ({
    source: target.sessionId ?? WORKTREE_SOURCE,
    ts: target.ts,
    scope: activeScope(),
    file,
  });

  async function toggleDiff(path: string) {
    if (expanded() === path) {
      setExpanded(null);
      return;
    }
    const target = open();
    const root = props.root;
    if (!target || !root) return;
    setDiff(await checkpointFileDiff(root, diffTarget(target, path)).catch(() => ""));
    setExpanded(path);
  }

  function openDiffTab(path: string) {
    const target = open();
    if (target && props.root) {
      emitWith(OPEN_IN_EDITOR, { path: checkpointDiffTabId(props.root, diffTarget(target, path)) });
    }
  }

  // Live-tab sessions in this folder that are mid-turn. Reactive and cheap, so
  // it can disable the button continuously; the detached tier needs a
  // subprocess probe and is therefore only checked at click time.
  const executingHere = () => {
    const folder = props.folderPath;
    if (!folder) return [];
    return liveSessionStatuses().filter((s) => isWorking(s.status) && isUnderPath(s.folderPath, folder));
  };

  /** The liveness guard both whole-tree writes take. Returns who else is in
   *  the folder once the write is allowed, or null when it is not. */
  async function clearToWrite(folder: string, verb: string): Promise<readonly RevertBlocker[] | null> {
    // The detached probe is deliberate work, so it runs only here, when a
    // revert is actually requested.
    const candidates = await folderActors(folder);
    let verdict = revertGuard(candidates, { folderPath: folder });
    if (!verdict.allow && !verdict.overridable) {
      toastError(verdict.reason);
      return null;
    }
    if (!verdict.allow) {
      // Detached-only block: unverifiable, so the user gets an explicit
      // override rather than a hard stop.
      const go = await askConfirm({
        title: "Another session may be running here",
        message: `${verdict.reason}\n\n${verb} anyway?`,
        confirmLabel: `${verb} anyway`,
        danger: true,
      });
      if (!go) return null;
      verdict = revertGuard(candidates, { folderPath: folder, allowDetached: true });
      if (!verdict.allow) return null;
    }
    return verdict.blockers;
  }

  async function restoreBackstop(entry: BackstopRecord) {
    const root = props.root;
    const folder = props.folderPath;
    if (!root || !folder || reverting()) return;

    // Same blast radius as a tree revert, so the same guard: this rewrites
    // every file in the folder, including whatever another chat is writing
    // right now. Nothing about the backstop being ours makes the other
    // session's in-flight work ours to overwrite.
    if (!(await clearToWrite(folder, "Restore"))) return;

    const ok = await askConfirm({
      title: `Undo "${entry.label}"?`,
      message: `Every file in this folder goes back to how it was at ${checkpointClock(entry.ts)}, just before that change.\n\nAnything you have done since is overwritten.`,
      confirmLabel: "Restore files",
      danger: true,
    });
    if (!ok) return;
    setReverting(true);
    try {
      const outcome = await invoke<RestoreOutcome>("backstop_restore_tree", {
        repoPath: root,
        ts: entry.ts,
      });
      // The same channel a checkpoint revert uses, so an open buffer over a
      // restored file reconciles instead of saving over it later. Backstops
      // never created one, hence the null.
      props.onReverted?.({ backstop_ts: null, ...outcome });
      // Everything, like the turn revert does: the restore moved the working
      // tree, so every count here is stale, and waiting for the watcher's
      // debounce would show wrong numbers in the meantime.
      await Promise.all([loadList(), loadBackstops(), loadFiles()]);
      emitWith<ToastEvent>(TOAST, {
        message: `Restored ${outcome.restored.length + outcome.deleted.length} file(s) from before "${entry.label}".`,
        kind: "info",
      });
    } catch (e) {
      toastError(e);
    } finally {
      setReverting(false);
    }
  }

  async function revertTree(sessionId: string, ts: number) {
    const root = props.root;
    const folder = props.folderPath;
    if (!root || !folder || reverting()) return;

    const blockers = await clearToWrite(folder, "Revert");
    if (!blockers) return;

    const others = blockers.filter((b) => b.sessionId !== sessionId);
    const ok = await askConfirm({
      title: `Revert the whole tree to ${checkpointClock(ts)}?`,
      message: blastRadiusMessage(others),
      confirmLabel: "Revert tree",
      danger: true,
    });
    if (!ok) return;

    // Files another live chat also wrote. The revert is scoped to this
    // session's own writes, so these would be skipped silently; they are worth
    // a second question rather than a quiet omission, and the answer names who
    // else is in them.
    //
    // Asked cumulatively: reverting *to* a boundary undoes every turn after it,
    // so a file shared in a later turn is in the blast radius too.
    const cumulativeFiles = await turnFilesOf(sessionId, ts, true).catch(() => sinceFiles());
    // Files the tree says changed and no session claims. The revert is scoped to
    // this session's recorded writes, so they are left on disk - said here
    // rather than discovered afterwards, because "revert everything to here"
    // reads as a promise that they went back too.
    const orphans = cumulativeFiles.filter((f) => f.unattributed).map((f) => f.path);
    if (orphans.length) {
      const go = await askConfirm({
        title: `${orphans.length} file${orphans.length === 1 ? "" : "s"} will be left alone`,
        message: `${orphans.join(", ")}\n\n${UNATTRIBUTED_NOTICE}\n\nThese stay exactly as they are.`,
        confirmLabel: "Revert the rest",
      });
      if (!go) return;
    }

    const shared = cumulativeFiles.filter((f) => f.shared_with?.length).map((f) => f.path);
    let confirmedShared: string[] = [];
    if (shared.length) {
      const who = [...new Set(cumulativeFiles.flatMap((f) => f.shared_with ?? []))];
      const alsoRevert = await askConfirm({
        title: `${shared.length} file${shared.length === 1 ? "" : "s"} also written by another chat`,
        message: `${shared.join(", ")} ${shared.length === 1 ? "was" : "were"} also written by ${who.join(", ")}. Reverting ${shared.length === 1 ? "it" : "them"} undoes that session's work too. Leave ${shared.length === 1 ? "it" : "them"} alone, or revert everything?`,
        confirmLabel: "Revert these too",
        danger: true,
      });
      if (alsoRevert) confirmedShared = shared;
    }

    setReverting(true);
    try {
      const outcome = await invoke<RevertOutcome>("checkpoint_revert_tree", {
        repoPath: root,
        sessionId,
        promptTs: ts,
        shared: confirmedShared,
      });
      props.onReverted?.(outcome);
      await Promise.all([loadList(), loadFiles()]);
      emitWith<ToastEvent>(TOAST, {
        message:
          outcome.backstop_ts === null
            ? "Already at that checkpoint, nothing to revert."
            : `Reverted ${outcome.restored.length + outcome.deleted.length} file(s). The previous state is saved as a backstop.`,
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
    lines.push("Current state is saved as a backstop first, so this is reversible.");
    if (others.length) {
      const named = others.map((b) =>
        b.kind === "detached" ? `${b.sessionName} (possibly active, cannot verify)` : b.sessionName,
      );
      lines.push(`Also in this folder: ${named.join(", ")}.`);
    }
    return lines.join("\n\n");
  }

  function revertOpen() {
    const target = open();
    if (!target) return;
    if (target.sessionId) {
      void revertTree(target.sessionId, target.ts);
      return;
    }
    const record = backstops().find((b) => b.ts === target.ts);
    if (record) void restoreBackstop(record);
  }

  function show(target: Target) {
    setScope("turn");
    setLastOpened(targetKey(target));
    setOpen(target);
  }

  createEffect(
    on([() => props.root, () => props.sessionId, () => props.folderPath], () => {
      setOpen(null);
      void loadList();
    }),
  );
  createEffect(
    on(
      () => props.root,
      () => void loadBackstops(),
    ),
  );
  createEffect(on(open, () => void loadFiles()));
  // A checkpoint pruned while its detail is open has nothing left to show or
  // to revert to.
  createEffect(() => {
    const target = open();
    if (!target) return;
    const there = target.sessionId
      ? listed().some((s) => s.sessionId === target.sessionId && s.entries.some((e) => e.prompt_ts === target.ts))
      : backstops().some((b) => b.ts === target.ts);
    if (!there) setOpen(null);
  });
  createEffect(
    on([open, activeScope], () => {
      setExpanded(null);
      setShowAll(false);
    }),
  );

  // checkpoint_list costs a `git diff --raw` per checkpoint plus a write-tree,
  // and an agent mid-turn emits fs://changed continuously, so the refresh is
  // debounced on the trailing edge: one rebuild per burst, not per event.
  let unlistenFs: UnlistenFn | undefined;
  let unlistenSettings: UnlistenFn | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(async () => {
    unlistenSettings = await listen("settings://changed", () => void loadSecrets(listed()));
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      if (e.payload.root && e.payload.root !== props.root) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void loadList();
        void loadBackstops();
        if (open()) void loadFiles();
      }, 500);
    });
  });
  onCleanup(() => {
    unlistenFs?.();
    unlistenSettings?.();
    clearTimeout(refreshTimer);
  });

  const revertDisabledReason = () => {
    if (reverting()) return "A revert is already running";
    const busy = executingHere();
    if (busy.length) return `${busy.map((s) => s.sessionName).join(", ")} is running a turn right now`;
    return null;
  };

  /** What the open row is, in the words its detail shows. */
  const opened = createMemo(() => {
    const target = open();
    if (!target) return null;
    const time = checkpointClock(target.ts);
    if (!target.sessionId) {
      const label = backstops().find((b) => b.ts === target.ts)?.label ?? "Backstop";
      return { target, time, title: label, meta: [time, "Backstop", "this worktree"], chat: false };
    }
    const who = describe(target.sessionId);
    if (target.kind === "backstop") {
      const label = backstopRows().find((b) => b.sessionId === target.sessionId && b.ts === target.ts)?.label;
      return { target, time, title: label ?? "Before a revert", meta: [time, "Backstop", who.name], chat: false };
    }
    return {
      target,
      time,
      title: titleOf(target.sessionId, target.ts),
      meta: [time, surfaceLabel(who.surface), who.name],
      chat: who.surface === "chat",
    };
  });

  const sharedNames = (f: CheckpointFile) => (f.shared_with ?? []).map((id) => describe(id).name).join(", ");

  function fileRow(f: CheckpointFile) {
    return (
      <div>
        <div class={styles.fileRow} onClick={() => void toggleDiff(f.path)}>
          <span class={`${styles.fileStatus} ${styles[f.status] ?? ""}`}>{f.status[0].toUpperCase()}</span>
          <button type="button" class={styles.fileMain} aria-expanded={expanded() === f.path}>
            <span class={styles.fileName}>{baseName(f.path)}</span>
            <Show when={dirName(f.path)}>
              <span class={styles.fileDir}>{dirName(f.path)}</span>
            </Show>
          </button>
          <span class={styles.rowEnd}>
            <IconButton
              size="xs"
              icon={<Icon icon={Columns2} />}
              aria-label="Open diff"
              tooltip="Open this diff in the editor"
              onClick={(e) => {
                e.stopPropagation();
                openDiffTab(f.path);
              }}
            />
            <IconButton
              size="xs"
              icon={<Icon icon={FileCode} />}
              aria-label="Open file"
              tooltip="Open the file as it is now"
              onClick={(e) => {
                e.stopPropagation();
                if (props.root) emitWith(OPEN_IN_EDITOR, { path: `${props.root}/${f.path}` });
              }}
            />
          </span>
          <Show when={f.shared_with?.length}>
            <Tooltip
              as="span"
              class={styles.sharedDot}
              role="img"
              aria-label="Shared with another chat"
              label={`Also written by ${sharedNames(f)}. Reverting affects work that is not only this session's.`}
            />
          </Show>
          <Show when={f.unattributed}>
            <Tooltip
              as="span"
              class={styles.unattributed}
              role="img"
              aria-label="Unattributed"
              label={UNATTRIBUTED_NOTICE}
            >
              <Icon icon={CircleDashed} size={12} />
            </Tooltip>
          </Show>
          <span class={styles.added}>+{f.added ?? 0}</span>
          <span class={styles.removed}>-{f.removed ?? 0}</span>
        </div>
        <Show when={expanded() === f.path}>
          <div class={styles.fileDiff}>
            <For each={parseDiffHunks(diff())} fallback={<div class={styles.note}>No line changes to show.</div>}>
              {(hunk) => (
                <div>
                  <div class={`${diffRowClasses.line} ${diffRowClasses.hunk}`}>{hunk.header}</div>
                  <DiffRows
                    rows={buildRows(hunk.lines, { old: hunk.oldStart, new: hunk.startLine })}
                    path={f.path}
                    twoColumn={false}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  }

  return (
    <div class={styles.panel}>
      <Show
        when={opened()}
        fallback={
          <Show
            when={groups().length || backstopRows().length}
            fallback={<div class="tree-empty">No checkpoints yet.</div>}
          >
            <OverlayScroll class={styles.scroll}>
              <For each={groups()}>
                {(g) => (
                  <>
                    <div class={styles.groupHeader}>
                      <span class={styles.groupKind}>{surfaceLabel(g.surface)}</span>
                      <span class={styles.groupName}>{g.name}</span>
                    </div>
                    <For each={g.turns}>
                      {(e) => {
                        const target: Target = { kind: "turn", sessionId: g.sessionId, ts: e.prompt_ts };
                        return (
                          <Tooltip
                            as="button"
                            type="button"
                            class={styles.row}
                            classList={{ [styles.active]: lastOpened() === targetKey(target) }}
                            label={titleOf(g.sessionId, e.prompt_ts)}
                            onClick={() => show(target)}
                          >
                            <span class={styles.rowTime}>{checkpointClock(e.prompt_ts)}</span>
                            <span class={styles.rowTitle}>{titleOf(g.sessionId, e.prompt_ts)}</span>
                            <Show when={turnSecret(secrets()[g.sessionId], e.prompt_ts)}>
                              {(hit) => (
                                <span
                                  class={styles.rowSecret}
                                  role="img"
                                  aria-label={
                                    hit().strength === "read" ? "Read a secret file" : "A command named a secret file"
                                  }
                                >
                                  <Icon icon={KeyRound} size={12} />
                                </span>
                              )}
                            </Show>
                            <span class={styles.rowCount}>{e.file_count}</span>
                            <Icon icon={ChevronRight} class={styles.rowChevron} />
                          </Tooltip>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
              <Show when={backstopRows().length}>
                <div class={styles.groupHeader}>
                  <span class={styles.groupKind}>Backstops</span>
                </div>
                <For each={backstopRows()}>
                  {(b) => {
                    const target: Target = { kind: "backstop", sessionId: b.sessionId, ts: b.ts };
                    return (
                      <Tooltip
                        as="button"
                        type="button"
                        class={`${styles.row} ${styles.backstop}`}
                        classList={{ [styles.active]: lastOpened() === targetKey(target) }}
                        label={
                          b.sessionId
                            ? `The tree as ${describe(b.sessionId).name} left it, saved before a revert`
                            : "The tree as it was, saved before a change in this worktree"
                        }
                        onClick={() => show(target)}
                      >
                        <span class={styles.rowTime}>{checkpointClock(b.ts)}</span>
                        <span class={styles.rowTitle}>{b.label}</span>
                        <span class={styles.ownerTag}>{b.sessionId ? "session" : "worktree"}</span>
                      </Tooltip>
                    );
                  }}
                </For>
              </Show>
            </OverlayScroll>
          </Show>
        }
      >
        {(o) => (
          <>
            <button type="button" class={styles.back} onClick={() => setOpen(null)}>
              <Icon icon={ChevronLeft} />
              Checkpoints
            </button>
            <OverlayScroll class={styles.scroll}>
              <div class={styles.detailHead}>
                <div class={styles.detailTitle}>{o().title}</div>
                <div class={styles.detailMeta}>{o().meta.join(` ${DOT} `)}</div>
              </div>
              <Show when={o().target.kind === "turn"}>
                <SegmentedControl
                  class={styles.range}
                  size="sm"
                  aria-label="Which changes to list"
                  value={scope()}
                  onChange={setScope}
                  options={[
                    { value: "turn", label: `This turn ${DOT} ${turnFiles().length}` },
                    { value: "since", label: `Since here ${DOT} ${sinceFiles().length}` },
                  ]}
                />
                <Show when={scope() === "since"}>
                  <div class={styles.note}>
                    Everything that changed in this folder since this point, including your own edits and any other
                    session's work, not just this session's.
                  </div>
                </Show>
              </Show>
              <Show
                when={files().length}
                fallback={
                  <div class={styles.note}>
                    {activeScope() === "turn" ? "No file changes in this turn." : "Nothing has changed since."}
                  </div>
                }
              >
                <For each={shownFiles()}>{fileRow}</For>
                <Show when={files().length > shownFiles().length}>
                  <button type="button" class={styles.more} onClick={() => setShowAll(true)}>
                    +{files().length - shownFiles().length} more
                  </button>
                </Show>
              </Show>
            </OverlayScroll>
            <Show when={files().some((f) => f.shared_with?.length || f.unattributed)}>
              <div class={styles.legend}>
                <Show when={files().some((f) => f.shared_with?.length)}>
                  <span class={styles.legendItem}>
                    <span class={styles.sharedDot} />
                    shared with another chat
                  </span>
                </Show>
                <Show when={files().some((f) => f.unattributed)}>
                  <span class={styles.legendItem}>
                    <span class={styles.unattributed}>
                      <Icon icon={CircleDashed} size={12} />
                    </span>
                    unattributed
                  </span>
                </Show>
              </div>
            </Show>
            <div class={styles.footer}>
              <Button
                variant="primary"
                class={styles.action}
                disabled={!!revertDisabledReason()}
                tooltipWhenDisabled
                tooltip={revertDisabledReason() ?? "Put every file in this folder back to how it was here"}
                onClick={revertOpen}
              >
                {reverting()
                  ? "Reverting..."
                  : `${o().target.kind === "turn" ? "Revert" : "Restore"} tree to ${o().time}`}
              </Button>
              <Show when={o().chat}>
                <Button
                  class={styles.action}
                  tooltip="Fork the chat from this turn and put its files back"
                  onClick={() =>
                    emitWith<RewindChat>(REWIND_CHAT, { sessionId: o().target.sessionId!, promptTs: o().target.ts })
                  }
                >
                  Rewind chat to here
                </Button>
              </Show>
              <div class={styles.footNote}>
                {o().target.sessionId
                  ? "Current state is saved as a backstop first."
                  : "Anything done since is overwritten."}
              </div>
            </div>
          </>
        )}
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
