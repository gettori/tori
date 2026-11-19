import { createSignal, createMemo, createEffect, on, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Combobox, { type ComboboxGroup, type ComboboxOption } from "../Combobox/Combobox";
import Dialog from "../Dialog/Dialog";
import { fuzzyMatch, fuzzyScore } from "../../utils/fuzzy";
import { traceWork } from "../../utils/perfTrace";
import { ensureAgentHealthLoaded } from "../../utils/agentHealth";
import { enabledAgents } from "../../utils/agentEnabled";
import { liveChats, stoppableChats } from "../../utils/chatSessions";
import { awaitingUser, STATUS_LABEL } from "../../utils/sessionStatus";
import { COMMANDS, type Command, type Requirement } from "../../utils/commands";
import { editorState, frontWorktree } from "../../utils/editorState";
import { runAt, runnable } from "../../utils/runStore";
import { runProjectFor } from "../../panels/Settings/settingsStore";
import { stagedFiles, canPush } from "../../utils/gitActions";
import { offersAnySourceAction } from "../../utils/sourceActions";
import { activeServerProvides } from "../../utils/serverProviders";
import {
  emitWith,
  NAVIGATE,
  NEW_SESSION,
  OPEN_IN_EDITOR,
  STOP_CHAT,
  type NavTarget,
  type OpenInEditor,
  type StopChat,
  type NewSession,
} from "../../utils/events";
import { livePlaces, watchSessionsOverview, type Place } from "../../utils/navIndex";
import { rank, type RankInput } from "../../utils/navRank";
import { requestLspRestart, resolvedServerIds, serverById } from "../../utils/lspServers";
import { rootOf, workspaceKey } from "../../utils/topics";
import { createTopicMembers, memberFor } from "../../utils/topicMembers";
import { loadFrecency, rankByFrecency, topFiles } from "../../utils/frecency";
import { loadTasks, type Task } from "../../utils/tasks";
import { loadTaskRuns } from "../../utils/taskRecents";
import { runTask } from "../../utils/runTask";
import { modesFrom, parseLine, parseQuery, specOf, type OmniHome } from "../../utils/omniboxModes";
import { debounce } from "../../utils/debounce";
import { flattenSymbols, searchWorkspaceSymbols, symbolsFor, type SymbolNode } from "../../utils/symbols";
import { mentionPath } from "../../utils/pathScope";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import { heldSelection } from "../SelectionToolbar/SelectionToolbar";
import { LOCAL_SPEECH } from "../../utils/localSpeech";
import { frontReply, reading } from "../../utils/speech";
import Icon from "../Icon/Icon";
import OmniRow, { MODE_GLYPHS } from "./OmniRow";
import { ENTER_LABEL, rowView, type Row } from "./rowView";
import styles from "./Omnibox.module.css";

/** How many project files the list holds. Past this the scroll bar is a hint
 *  rather than a control, and the query is what narrows anyway. */
const MAX_RESULTS = 200;

/** How many frecency-ranked files the empty box offers under the jump targets.
 *  Short for the same reason the jump list is: this is a shortcut past typing,
 *  not a second file picker. */
const MAX_RECENTS = 5;

const MAX_EVERYTHING = 50;

/** One listed file: which root it came from, and where it sits inside it.
 *  Inside a Topic the rel path alone no longer identifies a file. */
type ProjectFile = { root: string; rel: string };

function absOf(f: ProjectFile): string {
  return `${f.root}/${f.rel}`;
}

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
      // Scoped to the root the git commands will actually act on, which inside
      // a Topic is the member owning the file in front, not the workspace.
      return stagedFiles(editorState().projectRoot).length ? null : "Nothing staged";
    case "ahead":
      return canPush(editorState().projectRoot) ? null : "Nothing to push";
    case "sourceActions":
      return offersAnySourceAction() ? null : "This language server has no whole-file actions";
    case "implementationProvider":
    case "typeDefinitionProvider":
      return activeServerProvides(req) ? null : "This language server cannot answer that";
    case "runCommand": {
      const root = frontWorktree();
      return root && runProjectFor(root) && runnable(root) ? null : "This worktree has no run command";
    }
    case "runIdle": {
      const root = frontWorktree();
      return root && runAt(root) ? "Already running" : null;
    }
    case "runLive": {
      const state = runAt(frontWorktree() ?? "")?.state;
      return state === "running" ? null : state === "stopping" ? "Stopping" : "Nothing is running here";
    }
    case "heldSelection":
      return heldSelection() ? null : "Nothing selected";
    case "frontChat":
      return frontReply() ? null : "No chat in front";
    case "reading":
      return reading() ? null : "Nothing is being read";
    case "localSpeech":
      return LOCAL_SPEECH ? null : "Needs an Apple Silicon Mac";
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
const HIDES_WHEN_UNMET = new Set<Requirement>([
  "sourceActions",
  "implementationProvider",
  "typeDefinitionProvider",
  "runCommand",
  "heldSelection",
  "localSpeech",
]);

/** Whether a command should not be listed at all right now. */
function suppressed(c: Command): boolean {
  return (c.requires ?? []).some((req) => HIDES_WHEN_UNMET.has(req) && unmetReason(req) !== null);
}

/** The first unmet requirement's reason, in the order the command listed them. */
export function refusal(c: Command): string | null {
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
 * From Cmd+K a typed query also reaches every place by name: spaces, projects,
 * branches, Topics, chats and sessions, ranked in one list with the commands.
 */
export default function Omnibox(props: {
  home: OmniHome;
  /** Text the box opens with already typed, which is how a caller opens it in
   *  a prefixed mode. */
  prefix?: string;
  selected: Selection | null;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal(props.prefix ?? "");
  const [files, setFiles] = createSignal<ProjectFile[]>([]);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [wsHits, setWsHits] = createSignal<SymbolNode[]>([]);
  let input: HTMLInputElement | undefined;

  const root = () => props.selected?.folderPath ?? null;

  /** Every root the box lists files from: inside a Topic that is all its
   *  present members, since this is the one surface that can reach a file in a
   *  repo that is not the one in front of you. */
  const roots = (): string[] => {
    const sel = props.selected;
    if (sel?.kind === "topic") return sel.roots ?? [];
    const at = root();
    return at ? [at] : [];
  };

  const topicId = () => (props.selected?.kind === "topic" ? (props.selected.topicId ?? null) : null);
  const members = createTopicMembers(topicId);
  // One map rather than a `memberFor` per row: the untyped list draws hundreds,
  // and a member's key is the very root the rows already carry.
  const repoNames = createMemo(() => new Map(members().map((m) => [m.key, m.label])));

  // Read once, when the box opens, and held for its lifetime. The editor writes
  // this back on every open and edit, so storage is current by the time anyone
  // can press ⌘P; reading it here keeps the ranking out of App's prop chain, and
  // freezing `now` with it keeps the order from drifting under the cursor while
  // someone types.
  //
  // Keyed the way the editor writes it: `topic:<id>` for a Topic, whose
  // members' files would otherwise be filed under whichever one was in front.
  const openedAt = Date.now();
  const stats = loadFrecency(openedAt)[workspaceKey(props.selected)] ?? {};

  const parsed = createMemo(() => parseQuery(query(), props.home));
  const mode = () => parsed().mode;
  const term = () => parsed().term;

  onMount(() => {
    // Focus is `Dialog`'s (`initialFocus` below), which fires from Kobalte's
    // own open-auto-focus event rather than from a frame this component asks
    // for. What is left here is the data the box needs to have anything to show.
    // Which agents exist, so the "New ... session" rows offer only the ones
    // that can start. Cached in the backend, so this is a no-op after the first
    // call from anywhere.
    ensureAgentHealthLoaded();
    if (props.home === "all") onCleanup(watchSessionsOverview());
  });

  // Not on mount: Cmd+K rarely reaches files, and a big repo's listing is the
  // costliest thing the box asks for.
  let filesRead = false;
  createEffect(() => {
    const at = roots();
    if (mode() !== "file" || filesRead || !at.length) return;
    filesRead = true;
    // All roots at once rather than streaming them in: rows that arrive one
    // member at a time shift under a cursor that is already moving.
    void Promise.all(
      at.map((r) =>
        invoke<string[]>("list_project_files", { projectPath: r }).then(
          (rels) => rels.map((rel) => ({ root: r, rel })),
          () => [],
        ),
      ),
    ).then((lists) => setFiles(lists.flat()));
  });

  // Not on mount, unlike the file list: `fs_read_dir` shells out to
  // `git check-ignore`, and ⌘P is the most-pressed key in the app while never
  // showing a task row.
  let tasksRead = false;
  createEffect(() => {
    const at = root();
    if ((mode() !== "command" && mode() !== "all") || tasksRead || !at) return;
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

  /** How a file reads in the list: its root-relative path, prefixed by the repo
   *  inside a Topic. A bare basename makes two `index.ts` rows
   *  indistinguishable, and inside a Topic so does the rel path alone, since
   *  two members hold the same `package.json`. */
  function fileLabel(f: ProjectFile): string {
    const repo = repoNames().get(f.root);
    return repo ? `${repo}/${f.rel}` : f.rel;
  }

  /** The same, for a row that starts from an absolute path rather than from the
   *  listing: the jump list and the frecency block both do.
   *
   *  Over every member rather than over `roots()`, which holds only the present
   *  ones: a file outlives its member's worktree in both blocks, and that is
   *  exactly when an absolute path is the wrong thing to fall back to. */
  function pathLabel(abs: string): string {
    const m = memberFor(abs, members());
    if (m) return `${m.label}/${mentionPath(abs, m.key)}`;
    const at = rootOf(abs, roots());
    return at ? fileLabel({ root: at, rel: mentionPath(abs, at) }) : abs;
  }

  /** A file row. The root rides on the id as well as the label, so two members'
   *  same-named files are two rows rather than one that collides. */
  function fileRow(f: ProjectFile, section?: string): Row {
    return {
      kind: "file",
      id: `file:${f.root}:${f.rel}`,
      label: fileLabel(f),
      section,
      file: basename(f.rel),
      run: () => openAt(`${f.root}/${f.rel}`),
    };
  }

  function symbolRow(node: SymbolNode, showFile: boolean): Row {
    return {
      kind: "symbol",
      id: `sym:${node.path}:${node.selectLine}:${node.name}`,
      label: node.name,
      symbolKind: node.kind,
      sub: node.container ?? (showFile ? basename(node.path) : (node.detail ?? "")),
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
    const paths = new Set<string>();
    const jumps = editorState().recentJumps.map((entry): Row => {
      const rel = pathLabel(entry.path);
      paths.add(entry.path);
      return {
        kind: "file",
        id: `jump:${entry.path}:${entry.line ?? ""}`,
        label: entry.line ? `${rel}:${entry.line}` : rel,
        section: "Recently visited",
        file: basename(entry.path),
        run: () => openAt(entry.path, entry.line),
      };
    });
    const worked = roots().length
      ? topFiles(stats, openedAt, MAX_RECENTS)
          .filter((path) => !paths.has(path))
          .map((path): Row => {
            paths.add(path);
            return {
              kind: "file",
              id: `worked:${path}`,
              label: pathLabel(path),
              section: "Recent files",
              file: basename(path),
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
      const { rows: head, paths } = emptyFileRows();
      const ranked = rankByFrecency(all, absOf, stats, openedAt);
      // Capped per root rather than over the whole list: one shared cap on an
      // untyped list of eight members silently drops the last few members
      // entirely, and a member with no rows reads as a member with no files.
      const taken = new Map<string, number>();
      const rest: ProjectFile[] = [];
      for (const f of ranked) {
        if (paths.has(absOf(f))) continue;
        const n = taken.get(f.root) ?? 0;
        if (n >= MAX_RESULTS) continue;
        taken.set(f.root, n + 1);
        rest.push(f);
      }
      return [...head, ...rest.map((f) => fileRow(f, head.length ? "Project" : undefined))];
    }
    // Scored against the label, so inside a Topic the repo name narrows the
    // list the same way a folder name does. One cap here: scores are comparable
    // across members, so the best 200 really are the best 200.
    return traceWork("fuzzy-omnibox", () => {
      const scored: { f: ProjectFile; score: number }[] = [];
      for (const f of all) {
        const s = fuzzyScore(q, fileLabel(f));
        if (s !== null) scored.push({ f, score: s });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, MAX_RESULTS).map((r) => marked(fileRow(r.f), q));
    });
  });

  const commandRows = createMemo((): Row[] => {
    const out: Row[] = [];
    const sel = props.selected;
    // Only agents this install offers *and* this machine can start. An agent
    // the user turned off is absent because they said so; an unavailable one
    // is absent rather than offered-and-failing, since a row that spawns a
    // missing binary reports the failure after the user has already committed
    // to a session, which is a worse place to learn it than the Agents panel.
    // `agentEnabled` folds in `agentReady`, which treats unknown as ready, so a
    // slow or failed probe does not empty the list of what was chosen.
    for (const a of enabledAgents()) {
      out.push({
        kind: "command",
        group: "session",
        id: `new:${a.id}`,
        label: `New ${a.label} session`,
        sub: sel ? sel.projectName : "Select a branch first",
        run: () => {
          if (!sel) return;
          emitWith<NewSession>(NEW_SESSION, {
            folderPath: sel.folderPath,
            projectName: sel.projectName,
            agent: a.id,
          });
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
        kind: "command",
        group: c.group,
        id: c.id,
        label: c.label,
        sub: c.sub,
        keys: c.keys,
        disabled: why,
        run: () => c.run?.(),
      });
    }
    // One row per server the file in front resolves to, since a file can have a
    // linter beside its language server and only one of them may be stuck.
    const active = editorState().activePath;
    if (active) {
      for (const serverId of resolvedServerIds(active) ?? []) {
        out.push({
          kind: "command",
          group: "editor",
          id: `lsp-restart:${serverId}`,
          label: `Restart language server: ${serverById(serverId)?.label ?? serverId}`,
          run: () => requestLspRestart(active, serverId),
        });
      }
    }
    // One row per task this project defines, from the same reader the Tasks
    // panel uses, so the two surfaces cannot come to disagree about what the
    // project can be told to do. Labelled with the verb because the box is
    // searched by what you want to happen, not by a bare script name.
    const at = root();
    if (at) {
      for (const t of tasks()) {
        out.push({
          kind: "command",
          group: "terminal",
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
        kind: "command",
        group: "session",
        id: `stop:${c.sessionId}`,
        label: `Stop ${c.sessionName}`,
        sub: awaitingUser(c.status) ? STATUS_LABEL[c.status] : "Running a turn",
        run: () => emitWith<StopChat>(STOP_CHAT, { sessionId: c.sessionId }),
      });
    }
    out.push({
      kind: "command",
      group: "settings",
      id: "settings",
      label: "Open Settings",
      run: () => props.onOpenSettings(),
    });
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
    return scored.slice(0, MAX_RESULTS).map((r) => marked(symbolRow(r.node, false), q));
  });

  // Kept in the server's own order rather than re-scored here: it matched the
  // query against a whole index, which is more than a subsequence score over the
  // name can know.
  const workspaceRows = createMemo((): Row[] =>
    wsHits()
      .slice(0, MAX_RESULTS)
      .map((node) => symbolRow(node, true)),
  );

  const lineRows = createMemo((): Row[] => {
    const line = parseLine(term());
    const path = editorState().activePath;
    if (line === null || !path) return [];
    return [
      {
        kind: "line",
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
    modesFrom(props.home).map((m): Row => ({
      kind: "help",
      id: `help:${m.mode}`,
      label: m.label,
      sub: m.placeholder === m.label ? undefined : m.placeholder,
      mode: m.mode,
      prefix: m.prefix,
    })),
  );

  // Built only while a query is typed in the all home: the inputs move on every
  // status change, and nothing else here reads them.
  const searchingPlaces = createMemo(() => mode() === "all" && !!term());
  const places = createMemo(() => (searchingPlaces() ? livePlaces() : []));

  function placeRow(place: Place): Row {
    return {
      kind: "place",
      id: place.id,
      label: place.title,
      sub: place.trail,
      place,
      run: () => emitWith<NavTarget>(NAVIGATE, place.target),
    };
  }

  function rankInput(row: Row): RankInput {
    if (row.kind !== "place") return { fields: [{ slot: "title", text: row.label }], penalty: true };
    const ticket = row.place.issue?.title;
    return {
      fields: [
        { slot: "title", text: row.label },
        { slot: "trail", text: row.sub ?? "" },
        ...(ticket ? [{ slot: "ticket", text: ticket, hidden: true }] : []),
      ],
    };
  }

  const everythingRows = createMemo((): Row[] => {
    const q = term();
    if (!q) return commandRows();
    const ranked = rank([...places().map(placeRow), ...commandRows()], q, rankInput);
    return ranked
      .slice(0, MAX_EVERYTHING)
      .map(({ item, marks }) =>
        marks.ticket && item.kind === "place"
          ? { ...item, marks: marks.title, sub: item.place.issue?.title, subMarks: marks.ticket }
          : { ...item, marks: marks.title, subMarks: marks.trail },
      );
  });

  const results = createMemo((): Row[] => {
    switch (mode()) {
      case "all":
        return everythingRows();
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
    return scored.map((r) => marked(r.item, q));
  }

  function marked(row: Row, q: string): Row {
    return { ...row, marks: fuzzyMatch(q, row.label)?.ranges };
  }

  function emptyText(): string {
    switch (mode()) {
      case "all":
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

  /** The rows by the value the surface commits, so a pick comes back as the row
   *  it was built from. The id is already unique per row (`file:`, `jump:`,
   *  `task:` and so on), which is what lets it be the option's value. */
  const byId = createMemo(() => new Map(results().map((row) => [row.id, row])));

  /** `Row.section` as the shared surface's group contract.
   *
   *  A list is either wholly grouped or wholly flat, never both, because Kobalte
   *  decides "group or option" per top-level entry and throws on the mix. Every
   *  mode but the empty file list is flat, and that one heads its project tail
   *  as well as its two recent blocks, so the two shapes never meet. Rows under
   *  one heading are already adjacent, which is the same thing the old
   *  render-once-where-it-changes header relied on. */
  const options = createMemo((): ComboboxOption[] | ComboboxGroup[] => {
    const list = results();
    const toOption = (row: Row): ComboboxOption => ({
      value: row.id,
      label: row.label,
      disabled: !!row.disabled,
    });
    if (!list.some((row) => row.section)) return list.map(toOption);
    const groups: ComboboxGroup[] = [];
    for (const row of list) {
      const heading = row.section ?? "";
      const last = groups[groups.length - 1];
      if (last && last.label === heading) last.options.push(toOption(row));
      else groups.push({ label: heading, options: [toOption(row)] });
    }
    return groups;
  });

  function rowContent(option: ComboboxOption) {
    const item = byId().get(option.value);
    if (!item) return option.label;
    return <OmniRow view={rowView(item)} />;
  }

  // A disabled row lists (that is how you learn why it is refused) but does not
  // run, and picking it leaves the box open rather than dismissing it on an
  // action that did nothing. A help row switches mode in place, for the same
  // reason: it is a signpost, not a destination.
  //
  // The disabled guard is now belt as well as braces - the surface refuses to
  // commit such a row at all - but it is the sentence that says what a refused
  // command does, so it stays.
  function pick(item: Row) {
    if (item.disabled) return;
    if (item.kind === "help") {
      setQuery(item.prefix);
      input?.focus();
      return;
    }
    close(item.run);
  }

  const [active, setActive] = createSignal<string | null>(null);
  const activeRow = () => {
    const id = active();
    return id == null ? undefined : byId().get(id);
  };
  const filterOn = () => mode() !== props.home;

  return (
    <Dialog
      open
      // Hidden: the tag in the field names the mode.
      title="Go to anything"
      titleHidden
      size="palette"
      placement="top"
      class={styles.panel}
      initialFocus={() => input}
      onClose={() => props.onClose()}
    >
      {/* The filter and the list are both the shared surface's now (#110): the
          `role="listbox"`, the `aria-activedescendant`, the arrow keys, the
          scroll-into-view and the headings all belong to `Combobox`. What is
          left here is what a palette row *says*, and what picking one means. */}
      <Combobox
        bare
        leading={
          <span class={styles.lead} classList={{ [styles.isFilter]: filterOn() }}>
            <Icon icon={MODE_GLYPHS[mode()]} />
          </span>
        }
        trailing={
          <span class={styles.tag} classList={{ [styles.isFilter]: filterOn() }}>
            {specOf(mode()).label}
          </span>
        }
        listClass={styles.list}
        options={options()}
        query={query()}
        onQueryChange={setQuery}
        onSelect={(value) => {
          const item = byId().get(value);
          if (item) pick(item);
        }}
        onActiveChange={setActive}
        itemComponent={rowContent}
        inputRef={(el) => (input = el)}
        placeholder={specOf(props.home).placeholder}
        aria-label="Search files, actions and symbols"
        listLabel="Results"
        emptyLabel={emptyText()}
      />
      <div class={styles.footer}>
        <Show when={activeRow()}>
          {(row) => (
            <span class={styles.hint}>
              <span>{"\u21b5"}</span>
              {ENTER_LABEL[row().kind]}
            </span>
          )}
        </Show>
        <span class={`${styles.hint} ${styles.filters}`}>
          <span>?</span>
          Filters
        </span>
      </div>
    </Dialog>
  );
}
