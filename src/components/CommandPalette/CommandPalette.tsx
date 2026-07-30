import { createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { fuzzyScore } from "../../utils/fuzzy";
import { agents, findAgent } from "../../utils/agents";
import { liveSessionStatuses } from "../../utils/sessionActivity";
import { liveChats, stoppableChats } from "../../utils/chatSessions";
import {
  emit,
  emitWith,
  FOCUS_SESSION_TAB,
  SET_RIGHT_MODE,
  NEW_SESSION,
  OPEN_TRANSCRIPT,
  TOGGLE_SIDEBAR,
  TOGGLE_TERMINAL,
  TOGGLE_EDITOR,
  TOGGLE_FILETREE,
  STOP_CHAT,
  type StopChat,
  type NewSession,
  type OpenTranscript,
  type SetRightMode,
} from "../../utils/events";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import dialogStyles from "../Dialogs/Dialogs.module.css";
import styles from "./CommandPalette.module.css";

// Minimal mirror of src-tauri/src/sessions.rs's `SessionMeta`, just the
// fields the palette reads.
type SessionMeta = {
  id: string;
  path: string;
  cwd: string;
  branch: string;
  title: string;
  name?: string | null;
  archived: boolean;
  agent?: string;
};

type SessionItem = {
  kind: "session";
  id: string; // sessionId, used as the React-key-equivalent
  label: string;
  sub: string;
  live: boolean;
  tabId?: string;
  session?: SessionMeta;
};
type ActionItem = { kind: "action"; id: string; label: string; sub?: string; run: () => void };
type PaletteItem = SessionItem | ActionItem;

const RIGHT_MODES: { mode: SetRightMode["mode"]; label: string }[] = [
  { mode: "files", label: "Files" },
  { mode: "changes", label: "Changes" },
  { mode: "search", label: "Search" },
  { mode: "session", label: "Session" },
  { mode: "shared", label: "Shared" },
  { mode: "docs", label: "Docs" },
];

const VIEW_TOGGLES: { event: string; label: string }[] = [
  { event: TOGGLE_SIDEBAR, label: "Sidebar" },
  { event: TOGGLE_TERMINAL, label: "Terminal" },
  { event: TOGGLE_EDITOR, label: "Editor" },
  { event: TOGGLE_FILETREE, label: "Filetree" },
];

/** Cmd+K command palette: fuzzy-filters a combined list of live sessions
 *  ("focus"), the current project's resumable sessions ("resume", degrading
 *  to a read-only transcript for a resume-less adapter), and actions (new
 *  session per registered agent, right-panel mode toggles, open settings).
 *  Session "resume" is scoped to the currently selected project - a
 *  full Selection (space/project/branch context) can't be reconstructed from
 *  a bare session id, and "focus" already covers every live session app-wide
 *  via the Phase 1 status store, which does carry that context. */
export default function CommandPalette(props: {
  selected: Selection | null;
  onSelect: (s: Selection) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const [projectSessions, setProjectSessions] = createSignal<SessionMeta[]>([]);
  let input: HTMLInputElement | undefined;
  const rows: (HTMLDivElement | undefined)[] = [];

  onMount(() => {
    requestAnimationFrame(() => input?.focus());
    const folder = props.selected?.folderPath;
    if (folder) {
      invoke<SessionMeta[]>("list_sessions", { folder })
        .then((list) => setProjectSessions(list.filter((s) => !s.archived)))
        .catch(() => setProjectSessions([]));
    }
  });

  function close(fn?: () => void) {
    props.onClose();
    fn?.();
  }

  const items = createMemo((): PaletteItem[] => {
    const liveIds = new Set(liveSessionStatuses().map((s) => s.sessionId));
    const sessionItems: SessionItem[] = liveSessionStatuses().map((s) => ({
      kind: "session",
      id: `live:${s.sessionId}`,
      label: s.sessionName || s.sessionId.slice(0, 8),
      sub: `Focus · ${s.projectName}`,
      live: true,
      tabId: s.tabId,
    }));
    for (const s of projectSessions()) {
      if (liveIds.has(s.id)) continue; // already listed as a live "focus" entry
      sessionItems.push({
        kind: "session",
        id: `resume:${s.id}`,
        label: s.name || s.title || s.id.slice(0, 8),
        sub: `Resume · ${props.selected?.projectName ?? ""}`,
        live: false,
        session: s,
      });
    }

    const actionItems: ActionItem[] = [];
    const sel = props.selected;
    for (const a of agents()) {
      actionItems.push({
        kind: "action",
        id: `new:${a.id}`,
        label: `New ${a.label} session`,
        sub: sel ? sel.projectName : "Select a branch first",
        run: () => {
          if (!sel) return;
          emitWith<NewSession>(NEW_SESSION, { folderPath: sel.folderPath, projectName: sel.projectName, agent: a.id });
        },
      });
    }
    for (const m of RIGHT_MODES) {
      actionItems.push({
        kind: "action",
        id: `mode:${m.mode}`,
        label: `Show ${m.label}`,
        run: () => emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: m.mode }),
      });
    }
    for (const v of VIEW_TOGGLES) {
      actionItems.push({
        kind: "action",
        id: `view:${v.event}`,
        label: `View: Toggle ${v.label}`,
        run: () => emit(v.event),
      });
    }
    // One row per chat that a stop would actually do something to, named. The
    // hotkey covers the common case; this covers the case the hotkey refuses to
    // guess at, which is several chats running at once (see `chatToStop`).
    for (const c of stoppableChats(liveChats())) {
      actionItems.push({
        kind: "action",
        id: `stop:${c.sessionId}`,
        label: `Stop ${c.sessionName}`,
        sub: c.status === "waitingForApproval" ? "Waiting for approval" : "Running a turn",
        run: () => emitWith<StopChat>(STOP_CHAT, { sessionId: c.sessionId }),
      });
    }
    actionItems.push({
      kind: "action",
      id: "settings",
      label: "Open Settings",
      run: () => props.onOpenSettings(),
    });

    return [...sessionItems, ...actionItems];
  });

  const results = createMemo(() => {
    const q = query().trim();
    if (!q) return items();
    const scored: { item: PaletteItem; score: number }[] = [];
    for (const item of items()) {
      const s = fuzzyScore(q, item.label);
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((r) => r.item);
  });

  createEffect(() => {
    const n = results().length;
    if (index() >= n) setIndex(0);
  });
  createEffect(() => {
    results();
    rows[index()]?.scrollIntoView({ block: "nearest" });
  });

  function commit(item: PaletteItem) {
    if (item.kind === "action") {
      close(item.run);
      return;
    }
    if (item.live && item.tabId) {
      close(() => emitWith(FOCUS_SESSION_TAB, { tabId: item.tabId }));
      return;
    }
    const session = item.session;
    const sel = props.selected;
    if (!session || !sel) return;
    const agentId = session.agent ?? "claude";
    if (findAgent(agentId).resume_args.length === 0) {
      close(() =>
        emitWith<OpenTranscript>(OPEN_TRANSCRIPT, {
          id: session.id,
          sessionPath: session.path,
          agent: agentId === "pi" ? "pi" : "claude",
          name: session.name || session.title,
          cwd: session.cwd,
        }),
      );
      return;
    }
    close(() =>
      props.onSelect({
        spaceName: sel.spaceName,
        projectName: sel.projectName,
        projectPath: sel.projectPath,
        folderPath: sel.folderPath,
        branch: sel.branch,
        projectKind: sel.projectKind,
        recordedBranch: session.branch || undefined,
        agent: session.agent,
        sessionId: session.id,
        sessionPath: session.path,
        sessionFile: session.path,
        sessionCwd: session.cwd,
        sessionTitle: session.title,
        sessionName: session.name,
      }),
    );
  }

  function onKeyDown(e: KeyboardEvent) {
    const n = results().length;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results()[index()];
      if (hit) commit(hit);
    }
  }

  return (
    <Portal>
      <div class={dialogStyles.modalBackdrop} onMouseDown={() => props.onClose()}>
        <div class={`${dialogStyles.modal} ${dialogStyles.picker}`} onMouseDown={(e) => e.stopPropagation()}>
          <div class={dialogStyles.modalTitle}>Command Palette</div>
          <div class={dialogStyles.pickerInputWrap}>
            <input
              ref={input}
              class={`${dialogStyles.modalInput} ${dialogStyles.pickerInput}`}
              placeholder="Jump to a session or run an action"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <div class={dialogStyles.pickerList}>
            <Show when={results().length} fallback={<div class={dialogStyles.pickerEmpty}>No matches</div>}>
              <For each={results()}>
                {(item, i) => (
                  <div
                    ref={(el) => (rows[i()] = el)}
                    class={dialogStyles.pickerItem}
                    classList={{ [dialogStyles.active]: i() === index() }}
                    onClick={() => commit(item)}
                    onMouseEnter={() => setIndex(i())}
                  >
                    <span class={styles.itemLabel}>{item.label}</span>
                    <Show when={item.sub}>
                      <span class={styles.itemSub}>{item.sub}</span>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
