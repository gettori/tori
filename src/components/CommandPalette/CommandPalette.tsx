import { createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fuzzyScore } from "../../utils/fuzzy";
import { agents } from "../../utils/agents";
import { liveChats, stoppableChats } from "../../utils/chatSessions";
import {
  emit,
  emitWith,
  SET_RIGHT_MODE,
  NEW_SESSION,
  TOGGLE_SIDEBAR,
  TOGGLE_TERMINAL,
  TOGGLE_EDITOR,
  TOGGLE_FILETREE,
  STOP_CHAT,
  type StopChat,
  type NewSession,
  type SetRightMode,
} from "../../utils/events";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import dialogStyles from "../Dialogs/Dialogs.module.css";
import styles from "./CommandPalette.module.css";

type PaletteItem = { id: string; label: string; sub?: string; run: () => void };

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

/** Cmd+K command palette: fuzzy-filters actions - a new session per registered
 *  agent, right-panel modes, view toggles, stopping a running chat, settings.
 *  It lists no sessions: the terminal pane's History dropdown is the session
 *  list, and it is branch-scoped and covers every session rather than only the
 *  live ones, which is more than a fuzzy line of text here could say. */
export default function CommandPalette(props: {
  selected: Selection | null;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  let input: HTMLInputElement | undefined;
  const rows: (HTMLDivElement | undefined)[] = [];

  onMount(() => {
    requestAnimationFrame(() => input?.focus());
  });

  function close(fn?: () => void) {
    props.onClose();
    fn?.();
  }

  const items = createMemo((): PaletteItem[] => {
    const actionItems: PaletteItem[] = [];
    const sel = props.selected;
    for (const a of agents()) {
      actionItems.push({
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
        id: `mode:${m.mode}`,
        label: `Show ${m.label}`,
        run: () => emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: m.mode }),
      });
    }
    for (const v of VIEW_TOGGLES) {
      actionItems.push({
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
        id: `stop:${c.sessionId}`,
        label: `Stop ${c.sessionName}`,
        sub: c.status === "waitingForApproval" ? "Waiting for approval" : "Running a turn",
        run: () => emitWith<StopChat>(STOP_CHAT, { sessionId: c.sessionId }),
      });
    }
    actionItems.push({
      id: "settings",
      label: "Open Settings",
      run: () => props.onOpenSettings(),
    });

    return actionItems;
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
      if (hit) close(hit.run);
    }
  }

  return (
    <Portal>
      <div class={dialogStyles.modalBackdrop} onMouseDown={() => props.onClose()}>
        <div
          class={`${dialogStyles.modal} ${dialogStyles.picker}`}
          role="dialog"
          aria-label="Command palette"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div class={dialogStyles.modalTitle}>Command Palette</div>
          <div class={dialogStyles.pickerInputWrap}>
            <input
              ref={input}
              class={`${dialogStyles.modalInput} ${dialogStyles.pickerInput}`}
              placeholder="Run an action"
              aria-label="Filter actions"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          {/* The listbox is the list of actions, not the field above it: the
              filter is a textbox and "No matches" is not an option, so neither
              belongs inside a role that promises selectable children. */}
          <Show
            when={results().length}
            fallback={
              <div class={dialogStyles.pickerList}>
                <div class={dialogStyles.pickerEmpty}>No matches</div>
              </div>
            }
          >
            <div class={dialogStyles.pickerList} role="listbox" aria-label="Actions">
              <For each={results()}>
                {(item, i) => (
                  <div
                    ref={(el) => (rows[i()] = el)}
                    class={dialogStyles.pickerItem}
                    classList={{ [dialogStyles.active]: i() === index() }}
                    role="option"
                    aria-selected={i() === index()}
                    onClick={() => close(item.run)}
                    onMouseEnter={() => setIndex(i())}
                  >
                    <span class={styles.itemLabel}>{item.label}</span>
                    <Show when={item.sub}>
                      <span class={styles.itemSub}>{item.sub}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
