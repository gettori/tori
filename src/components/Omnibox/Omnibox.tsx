import { createSignal, createMemo, createEffect, on, onCleanup, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { fuzzyScore } from "../../utils/fuzzy";
import { agents } from "../../utils/agents";
import { agentReady, ensureAgentHealthLoaded } from "../../utils/agentHealth";
import { liveChats, stoppableChats } from "../../utils/chatSessions";
import { COMMANDS, type Command, type Requirement } from "../../utils/commands";
import { editorState } from "../../utils/editorState";
import { stagedFiles, canPush } from "../../utils/gitActions";
import { offersAnySourceAction } from "../../utils/sourceActions";
import {
  emitWith,
  NEW_SESSION,
  OPEN_IN_EDITOR,
  STOP_CHAT,
  type OpenInEditor,
  type StopChat,
  type NewSession,
} from "../../utils/events";
import { loadFrecency, rankByFrecency, topFiles } from "../../utils/frecency";
import { loadTasks, type Task } from "../../utils/tasks";
import { loadTaskRuns } from "../../utils/taskRecents";
import { runTask } from "../../utils/runTask";
import { MODES, parseLine, parseQuery, specOf } from "../../utils/omniboxModes";
import { debounce } from "../../utils/debounce";
import { flattenSymbols, searchWorkspaceSymbols, symbolsFor, type SymbolNode } from "../../utils/symbols";
import { mentionPath } from "../../utils/pathScope";
import FileIcon from "../../seti/FileIcon";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import styles from "./Omnibox.module.css";

/** How many project files the list holds. Past this the scroll bar is a hint
 *  rather than a control, and the query is what narrows anyway. */
const MAX_RESULTS = 200;

/** How many frecency-ranked files the empty box offers under the jump targets.
 *  Short for the same reason the jump list is: this is a shortcut past typing,
 *  not a second file picker. */
const MAX_RECENTS = 5;

type Row = {
  id: string;
  label: string;
  /** Heading this row sits under. Rows carrying the same one must be adjacent;
   *  the header renders once, where the value changes. */
  section?: string;
  sub?: string;
  /** Key chips, for commands that also carry a binding. */
  keys?: string[];
  /** Filename to take a glyph from. */
  fileIcon?: string;
  /** LSP symbol kind to take a glyph from. */
  symbolKind?: number;
  /** Right-aligned secondary text: a symbol's container or file. */
  meta?: string;
  /** Why this cannot run right now, or null when it can. */
  disabled?: string | null;
  /** A signpost rather than a destination: picking it retypes the box with this
   *  prefix and leaves it open, and carries no `run` because it goes nowhere.
   *  Only the `?` list uses it. */
  enters?: string;
  run?: () => void;
};

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Why a requirement is unmet, or null when it holds.
 *
 * The tags are resolved here rather than in `commands.ts` because that table
 * feeds `hotkeys.ts`, which `TerminalView` imports: a store read there would put
 * the editor and git modules in the terminal's chunk. The omnibox is the leaf of
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
    case "sourceActions":
      return offersAnySourceAction() ? null : "This language server has no whole-file actions";
  }
}

/**
 * Requirements whose absence removes the row rather than greying it out.
 *
 * Every other tag names something the user has not done yet - nothing staged,
 * no file open - and saying so teaches them what to do. This one names
 * something the *language* cannot do, which no amount of doing will change, so
 * the row would be permanent clutter in every Python or Rust buffer. Same rule
 * the Outline tab uses when a server advertises no symbol provider.
 */
const HIDES_WHEN_UNMET = new Set<Requirement>(["sourceActions"]);

/** Whether a command should not be listed at all right now. */
function suppressed(c: Command): boolean {
  return (c.requires ?? []).some((req) => HIDES_WHEN_UNMET.has(req) && unmetReason(req) !== null);
}

/** The first unmet requirement's reason, in the order the command listed them. */
function refusal(c: Command): string | null {
  for (const req of c.requires ?? []) {
    const why = unmetReason(req);
    if (why) return why;
  }
  return null;
}

/**
 * One box for everything you can reach by name: files, actions, symbols, a line
 * number, and the list of prefixes that says so.
 *
 * It replaces the two overlays that came before it (⌘P's file finder and ⌘K's
 * command palette), which is the point rather than a side effect: they were two
 * modals with two shortcuts, two result lists and two ideas of what "recent"
 * meant, and switching between them cost an Escape and a retyped query. Here a
 * mode is a prefix, so it is one keystroke *inside* the box, and the rule that
 * reads it is `utils/omniboxModes.ts` rather than anything held in state.
 *
 * Its rows come from the canonical table in `utils/commands` - the same table
 * `hotkeys.ts` derives its bindings from - so a command cannot be listed here
 * under one name and in the ⌘/ sheet under another. What the table cannot hold
 * is added around it: a row per registered agent and a row per running chat are
 * both lists that only exist at runtime.
 *
 * It lists no sessions: the terminal pane's History dropdown is the session
 * list, and it is branch-scoped and covers every session rather than only the
 * live ones, which is more than a fuzzy line of text here could say.
 */
export default function Omnibox(props: {
  /** The prefix the box opens with: `""` from ⌘P, `">"` from ⌘K. */
  prefix?: string;
  selected: Selection | null;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal(props.prefix ?? "");
  const [index, setIndex] = createSignal(0);
  const [files, setFiles] = createSignal<string[]>([]);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [wsHits, setWsHits] = createSignal<SymbolNode[]>([]);
  let input: HTMLInputElement | undefined;
  const rows: (HTMLDivElement | undefined)[] = [];

  const root = () => props.selected?.folderPath ?? null;

  // Read once, when the box opens, and held for its lifetime. The editor writes
  // this back on every open and edit, so storage is current by the time anyone
  // can press ⌘P; reading it here keeps the ranking out of App's prop chain, and
  // freezing `now` with it keeps the order from drifting under the cursor while
  // someone types.
  const openedAt = Date.now();
  const stats = loadFrecency(openedAt)[root() ?? ""] ?? {};

  const parsed = createMemo(() => parseQuery(query()));
  const mode = () => parsed().mode;
  const term = () => parsed().term;

  onMount(() => {
    requestAnimationFrame(() => input?.focus());
    // Which harnesses exist, so the "New ... session" rows offer only the ones
    // that can start. Cached in the backend, so this is a no-op after the first
    // call from anywhere.
    ensureAgentHealthLoaded();
    const at = root();
    if (!at) return;
    void invoke<string[]>("list_project_files", { projectPath: at }).then(setFiles, () => setFiles([]));
  });

  // Not on mount, unlike the file list: `fs_read_dir` shells out to
  // `git check-ignore`, and ⌘P is the most-pressed key in the app while never
  // showing a task row. Read the first time the box is actually in `>` mode, and
  // once per open after that - a `scripts` block does not change while a picker
  // is on screen, and the Tasks panel re-reads on fs changes.
  let tasksRead = false;
  createEffect(() => {
    const at = root();
    if (mode() !== "command" || tasksRead || !at) return;
    tasksRead = true;
    void loadTasks(
      at,
      (path) => invoke<{ name: string }[]>("fs_read_dir", { path }),
      (path) => invoke<string>("fs_read_file", { path }),
    ).then(setTasks, () => setTasks([]));
  });

  // `workspace/symbol` is a round trip per running server, so it is not sent on
  // every keystroke. A token guards the order: a slow answer to an older query
  // must not overwrite a fast answer to a newer one.
  let wsToken = 0;
  // The debounce's timer cannot be cancelled, so closing the box bumps the token
  // instead. Without it, Esc within the debounce window still sends a request to
  // every live server for a list nobody is looking at.
  let closed = false;
  onCleanup(() => (closed = true));
  const runWorkspaceSearch = debounce((q: string) => {
    if (closed) return;
    const token = ++wsToken;
    void searchWorkspaceSymbols(q).then(
      (hits) => {
        if (token === wsToken) setWsHits(hits);
      },
      () => {
        if (token === wsToken) setWsHits([]);
      },
    );
  }, 180);

  createEffect(
    on([mode, term], ([m, q]) => {
      if (m !== "workspace") return;
      // Cleared first, so the previous query's hits are never shown under the
      // current one's text while the request is in flight.
      setWsHits([]);
      wsToken += 1;
      if (q) runWorkspaceSearch(q);
    }),
  );

  function close(fn?: () => void) {
    props.onClose();
    fn?.();
  }

  function openAt(path: string, line?: number, col?: number) {
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path, line, col });
  }

  // --- The modes ------------------------------------------------------------

  /** A file row, labelled by its workspace-relative path: a bare basename makes
   *  two `index.ts` rows indistinguishable, and the path is also what you would
   *  type to find one. */
  function fileRow(rel: string, section?: string): Row {
    const at = root();
    return {
      id: `file:${rel}`,
      label: rel,
      section,
      fileIcon: basename(rel),
      run: () => at && openAt(`${at}/${rel}`),
    };
  }

  function symbolRow(node: SymbolNode, showFile: boolean): Row {
    return {
      id: `sym:${node.path}:${node.selectLine}:${node.name}`,
      label: node.name,
      symbolKind: node.kind,
      meta: node.container ?? (showFile ? basename(node.path) : (node.detail ?? "")),
      // The name, not the body: a class's opening brace is technically the
      // symbol and practically the wrong line to land on.
      run: () => openAt(node.path, node.selectLine, node.selectColumn),
    };
  }

  /** The empty box: where you have just been, then the files you work in. The
   *  first is the editor's session-lived jump list, the second is durable
   *  frecency, and they answer different questions - "back to what I was doing"
   *  against "the files this project is". */
  const emptyFileRows = createMemo((): { rows: Row[]; paths: Set<string> } => {
    const at = root();
    const paths = new Set<string>();
    const jumps = editorState().recentJumps.map((entry): Row => {
      const rel = at ? mentionPath(entry.path, at) : entry.path;
      paths.add(entry.path);
      return {
        id: `jump:${entry.path}:${entry.line ?? ""}`,
        label: entry.line ? `${rel}:${entry.line}` : rel,
        section: "Recently visited",
        fileIcon: basename(entry.path),
        run: () => openAt(entry.path, entry.line),
      };
    });
    const worked = at
      ? topFiles(stats, openedAt, MAX_RECENTS)
          .filter((path) => !paths.has(path))
          .map((path): Row => {
            paths.add(path);
            return {
              ...fileRow(mentionPath(path, at), "Recent files"),
              id: `worked:${path}`,
              run: () => openAt(path),
            };
          })
      : [];
    return { rows: [...jumps, ...worked], paths };
  });

  const fileRows = createMemo((): Row[] => {
    const q = term();
    const all = files();
    if (!q) {
      // The rest of the project under the two recent blocks, ranked so the files
      // this branch-unit is worked in float up. Untracked files score zero and
      // keep their order, so this is a promotion of the few rather than a
      // shuffle of everything.
      //
      // Minus whatever the blocks above already offered: the ranking would put
      // exactly those at the top, and one file on two rows is a list that reads
      // as broken however sensible each half is on its own.
      const at = root();
      const { rows: head, paths } = emptyFileRows();
      const ranked = at ? rankByFrecency(all, (rel) => `${at}/${rel}`, stats, openedAt) : all;
      const rest = at ? ranked.filter((rel) => !paths.has(`${at}/${rel}`)) : ranked;
      return [...head, ...rest.slice(0, MAX_RESULTS).map((rel) => fileRow(rel, head.length ? "Project" : undefined))];
    }
    const scored: { rel: string; score: number }[] = [];
    for (const rel of all) {
      const s = fuzzyScore(q, rel);
      if (s !== null) scored.push({ rel, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => fileRow(r.rel));
  });

  const commandRows = createMemo((): Row[] => {
    const out: Row[] = [];
    const sel = props.selected;
    // Only harnesses this machine can actually start. An unavailable one is
    // absent rather than offered-and-failing: a row that spawns a missing
    // binary reports the failure after the user has already committed to a
    // session, which is a worse place to learn it than the Agents panel.
    // `agentReady` treats unknown as ready, so a slow or failed probe leaves
    // the picker full rather than empty.
    for (const a of agents().filter((a) => agentReady(a.id))) {
      out.push({
        id: `new:${a.id}`,
        label: `New ${a.label} session`,
        sub: sel ? sel.projectName : "Select a branch first",
        run: () => {
          if (!sel) return;
          emitWith<NewSession>(NEW_SESSION, { folderPath: sel.folderPath, projectName: sel.projectName, agent: a.id });
        },
      });
    }
    // The registry. `hidden` entries stay out: the box itself, the one binding
    // whose target is the key that fired it, the terminal-owned search, and the
    // unqualified stop that the per-chat rows below say better.
    for (const c of COMMANDS) {
      if (c.hidden || !c.run || suppressed(c)) continue;
      const why = refusal(c);
      out.push({
        id: c.id,
        label: c.label,
        sub: why ?? c.sub,
        keys: c.keys,
        disabled: why,
        run: () => c.run?.(),
      });
    }
    // One row per task this project defines, from the same reader the Tasks
    // panel uses, so the two surfaces cannot come to disagree about what the
    // project can be told to do. Labelled with the verb because the box is
    // searched by what you want to happen, not by a bare script name.
    const at = root();
    if (at) {
      for (const t of tasks()) {
        out.push({
          id: `task:${t.id}`,
          label: `Run task: ${t.name}`,
          sub: t.command,
          run: () => runTask(loadTaskRuns(), at, t),
        });
      }
    }
    // One row per chat that a stop would actually do something to, named. The
    // hotkey covers the common case; this covers the case the hotkey refuses to
    // guess at, which is several chats running at once (see `chatToStop`).
    for (const c of stoppableChats(liveChats())) {
      out.push({
        id: `stop:${c.sessionId}`,
        label: `Stop ${c.sessionName}`,
        sub: c.status === "waitingForApproval" ? "Waiting for approval" : "Running a turn",
        run: () => emitWith<StopChat>(STOP_CHAT, { sessionId: c.sessionId }),
      });
    }
    out.push({ id: "settings", label: "Open Settings", run: () => props.onOpenSettings() });
    return out;
  });

  // Flattened once per published tree rather than once per keystroke: the tree
  // can hold `MAX_SYMBOLS` nodes, and the query changes far more often than the
  // file does.
  const docSymbols = createMemo(() => flattenSymbols(symbolsFor(editorState().activePath)));

  const docRows = createMemo((): Row[] => {
    const all = docSymbols();
    const q = term();
    // No query: document order, which is the order the file reads in.
    if (!q) return all.slice(0, MAX_RESULTS).map((node) => symbolRow(node, false));
    const scored: { node: SymbolNode; score: number }[] = [];
    for (const node of all) {
      const s = fuzzyScore(q, node.name);
      if (s !== null) scored.push({ node, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => symbolRow(r.node, false));
  });

  // Kept in the server's own order rather than re-scored here: it matched the
  // query against a whole index, which is more than a subsequence score over the
  // name can know.
  const workspaceRows = createMemo((): Row[] =>
    wsHits().slice(0, MAX_RESULTS).map((node) => symbolRow(node, true)),
  );

  const lineRows = createMemo((): Row[] => {
    const line = parseLine(term());
    const path = editorState().activePath;
    if (line === null || !path) return [];
    return [
      {
        id: `line:${line}`,
        label: `Go to line ${line}`,
        sub: basename(path),
        run: () => openAt(path, line),
      },
    ];
  });

  /** `?` is a mode whose results are the modes. It answers "what else can this
   *  box do", which is otherwise only answerable by having read this file. */
  const helpRows = createMemo((): Row[] =>
    MODES.filter((m) => m.mode !== "help").map((m) => ({
      id: `help:${m.mode}`,
      label: m.prefix ? `${m.prefix}  ${m.label}` : `(no prefix)  ${m.label}`,
      sub: m.placeholder,
      // Picking one enters that mode rather than closing: the list is a menu of
      // where to go next, so a row that dismissed the box would undo the reason
      // it was opened.
      enters: m.prefix,
    })),
  );

  const results = createMemo((): Row[] => {
    switch (mode()) {
      case "command":
        return filtered(commandRows(), term());
      case "doc":
        return docRows();
      case "workspace":
        return workspaceRows();
      case "line":
        return lineRows();
      case "help":
        return helpRows();
      case "file":
        return fileRows();
    }
  });

  /** Fuzzy-filter a list against the query, best first. Only the modes whose
   *  source is a fixed list use it; the others score inside their own memo,
   *  because a symbol matches on its name and a file on its whole path. */
  function filtered(list: Row[], q: string): Row[] {
    if (!q) return list;
    const scored: { item: Row; score: number }[] = [];
    for (const item of list) {
      const s = fuzzyScore(q, item.label);
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((r) => r.item);
  }

  function emptyText(): string {
    switch (mode()) {
      case "command":
        return "No matches";
      case "doc":
        return docSymbols().length ? "No matching symbols" : "No symbols in the open file";
      case "workspace":
        return term() ? "No matching symbols" : "Type to search project symbols";
      case "line":
        return editorState().activePath ? "Type a line number" : "No file open";
      case "help":
        return "No modes";
      case "file":
        return "No matching files";
    }
  }

  // A disabled row lists (that is how you learn why it is refused) but does not
  // run, and picking it leaves the box open rather than dismissing it on an
  // action that did nothing. A help row switches mode in place, for the same
  // reason: it is a signpost, not a destination.
  function pick(item: Row) {
    if (item.disabled) return;
    if (item.enters !== undefined) {
      setQuery(item.enters);
      setIndex(0);
      input?.focus();
      return;
    }
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
      <div class={styles.backdrop} onMouseDown={() => props.onClose()}>
        <div
          class={styles.panel}
          role="dialog"
          aria-label="Command palette"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* The title names the mode, so the box says what it is looking at
              without the user having to read their own prefix back. */}
          <div class={styles.title}>{specOf(mode()).label}</div>
          <div class={styles.inputWrap}>
            <input
              ref={input}
              class={styles.input}
              placeholder={`${specOf(mode()).placeholder}   (? for prefixes)`}
              aria-label="Search files, actions and symbols"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          {/* The listbox is the list of results, not the field above it: the
              filter is a textbox and "No matches" is not an option, so neither
              belongs inside a role that promises selectable children. */}
          <Show
            when={results().length}
            fallback={
              <div class={styles.list}>
                <div class={styles.empty}>{emptyText()}</div>
              </div>
            }
          >
            <div class={styles.list} role="listbox" aria-label="Results">
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
                      class={styles.item}
                      classList={{
                        [styles.active]: i() === index(),
                        [styles.disabled]: !!item.disabled,
                      }}
                      role="option"
                      aria-selected={i() === index()}
                      aria-disabled={!!item.disabled}
                      onClick={() => pick(item)}
                      onMouseEnter={() => setIndex(i())}
                    >
                      <Show when={item.fileIcon}>
                        {(name) => (
                          <span class={styles.itemIcon}>
                            <FileIcon name={name()} />
                          </span>
                        )}
                      </Show>
                      <Show when={item.symbolKind !== undefined}>
                        <span class={styles.itemIcon}>
                          <SymbolIcon kind={item.symbolKind!} />
                        </span>
                      </Show>
                      <span class={styles.itemLabel}>{item.label}</span>
                      <Show when={item.sub}>
                        <span class={styles.itemSub}>{item.sub}</span>
                      </Show>
                      <Show when={item.meta}>
                        <span class={styles.itemMeta}>{item.meta}</span>
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
