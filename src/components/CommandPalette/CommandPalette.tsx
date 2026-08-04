import { createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fuzzyScore } from "../../utils/fuzzy";
import { agents } from "../../utils/agents";
import { liveChats, stoppableChats } from "../../utils/chatSessions";
import { COMMANDS, type Command, type Requirement } from "../../utils/commands";
import { editorState } from "../../utils/editorState";
import { stagedFiles, canPush } from "../../utils/gitActions";
import {
  emitWith,
  NEW_SESSION,
  OPEN_IN_EDITOR,
  STOP_CHAT,
  type OpenInEditor,
  type StopChat,
  type NewSession,
} from "../../utils/events";
import { loadFrecency, topFiles } from "../../utils/frecency";
import { mentionPath } from "../../utils/pathScope";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import dialogStyles from "../Dialogs/Dialogs.module.css";
import styles from "./CommandPalette.module.css";

/** How many recent files the palette offers before the actions. Short on
 *  purpose: this is a shortcut past Cmd+P for the two or three files you are
 *  living in, not a second file picker. */
const MAX_RECENTS = 5;

type PaletteItem = {
  id: string;
  label: string;
  /** Heading this row sits under. Rows carrying the same one must be adjacent;
   *  the header renders once, where the value changes. */
  section?: string;
  sub?: string;
  /** Key chips, for commands that also carry a binding. */
  keys?: string[];
  /** Why this cannot run right now, or null when it can. */
  disabled?: string | null;
  run: () => void;
};

/**
 * Why a requirement is unmet, or null when it holds.
 *
 * The tags are resolved here rather than in `commands.ts` because that table
 * feeds `hotkeys.ts`, which `TerminalView` imports: a store read there would put
 * the editor and git modules in the terminal's chunk. The palette is the leaf of
 * that graph, so reading them costs nothing.
 */
function unmetReason(req: Requirement): string | null {
  switch (req) {
    case "editorTab":
      return editorState().tabCount ? null : "No tab open";
    case "editorFile":
      return editorState().activePath ? null : "No file open";
    case "gitRoot":
      return editorState().projectRoot ? null : "Select a branch first";
    case "staged":
      return stagedFiles().length ? null : "Nothing staged";
    case "ahead":
      return canPush() ? null : "Nothing to push";
  }
}

/** The first unmet requirement's reason, in the order the command listed them. */
function refusal(c: Command): string | null {
  for (const req of c.requires ?? []) {
    const why = unmetReason(req);
    if (why) return why;
  }
  return null;
}

/** Cmd+K command palette: fuzzy-filters everything runnable by name.
 *
 *  Its rows come from the canonical table in `utils/commands` - the same table
 *  `hotkeys.ts` derives its bindings from - so a command cannot be listed here
 *  under one name and in the Cmd+/ sheet under another, and one added to the
 *  table appears in both without being registered twice. What the table cannot
 *  hold is added around it: a row per registered agent and a row per running
 *  chat are both lists that only exist at runtime.
 *
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

  // The files this branch-unit is actually worked in, read once when the
  // palette opens. Same source and same ranking as Cmd+P's empty box, through
  // the shared helper, so the two surfaces cannot disagree about what "recent"
  // means.
  const openedAt = Date.now();
  const recents = topFiles(loadFrecency(openedAt)[props.selected?.folderPath ?? ""] ?? {}, openedAt, MAX_RECENTS);

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
    // The registry. `hidden` entries stay out: the palette itself, the one
    // binding whose target is the key that fired it, the terminal-owned search,
    // and the unqualified stop that the per-chat rows below say better.
    for (const c of COMMANDS) {
      if (c.hidden || !c.run) continue;
      const why = refusal(c);
      actionItems.push({
        id: c.id,
        label: c.label,
        sub: why ?? c.sub,
        keys: c.keys,
        disabled: why,
        run: () => c.run?.(),
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

  // One row per recent file, ahead of the actions. Their own section, so a
  // query that matches a file and an action cannot interleave the two into a
  // list with no shape.
  const recentItems = createMemo((): PaletteItem[] =>
    recents.map((path) => ({
      id: `recent:${path}`,
      section: "Recent files",
      // The workspace-relative path, as Cmd+P labels its rows: a bare basename
      // makes two `index.ts` rows indistinguishable, and it is also what you
      // would type to find one.
      label: props.selected ? mentionPath(path, props.selected.folderPath) : path,
      run: () => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path }),
    })),
  );

  /** Fuzzy-filter one section against the query, best first. */
  function filtered(list: PaletteItem[], q: string): PaletteItem[] {
    if (!q) return list;
    const scored: { item: PaletteItem; score: number }[] = [];
    for (const item of list) {
      const s = fuzzyScore(q, item.label);
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((r) => r.item);
  }

  // The sections stay separate through filtering and are concatenated after, so
  // the recents keep their block (and their heading) instead of scattering
  // through the actions by score.
  const results = createMemo(() => {
    const q = query().trim();
    return [...filtered(recentItems(), q), ...filtered(items(), q)];
  });

  // A disabled row lists (that is how you learn why it is refused) but does not
  // run, and picking it leaves the palette open rather than dismissing it on an
  // action that did nothing.
  function pick(item: PaletteItem) {
    if (item.disabled) return;
    close(item.run);
  }

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
      if (hit) pick(hit);
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
                  <>
                    {/* Once, where the section changes, and hidden from the
                        accessibility tree. A heading is not an option, and this
                        listbox promises selectable children: announcing one the
                        arrow keys can never reach is the same fault the filter
                        and "No matches" are kept out for. Nothing is lost by
                        hiding it, since each row already reads as what it is -
                        a path, or an action's name. */}
                    <Show when={item.section && item.section !== results()[i() - 1]?.section}>
                      <div class={styles.sectionHeader} aria-hidden="true">
                        {item.section}
                      </div>
                    </Show>
                    <div
                      ref={(el) => (rows[i()] = el)}
                      class={`${dialogStyles.pickerItem} ${styles.item}`}
                      classList={{
                        [dialogStyles.active]: i() === index(),
                        [styles.disabled]: !!item.disabled,
                      }}
                      role="option"
                      aria-selected={i() === index()}
                      aria-disabled={!!item.disabled}
                      onClick={() => pick(item)}
                      onMouseEnter={() => setIndex(i())}
                    >
                      <span class={styles.itemLabel}>{item.label}</span>
                      <Show when={item.sub}>
                        <span class={styles.itemSub}>{item.sub}</span>
                      </Show>
                      <Show when={item.keys}>
                        {(keys) => (
                          <span class={styles.itemKeys}>
                            <For each={keys()}>{(key) => <kbd class={styles.key}>{key}</kbd>}</For>
                          </span>
                        )}
                      </Show>
                    </div>
                  </>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
