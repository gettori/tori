import { onCleanup, onMount, createEffect, createMemo, on, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from "@codemirror/view";
// `Text` as a value, not a type: `Text.of` is how a buffer is built from lines
// the line-ending pass already split (see lineEndings.ts).
import { Annotation, EditorState, Compartment, Prec, Text, type Extension, type StateCommand, type StateEffect, type StateField } from "@codemirror/state";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { swayHighlight } from "./syntaxStyle";
import { langForPath } from "./languages";
import { debounce } from "../../utils/debounce";
import { markSelfWrite, isSelfWrite } from "../../utils/selfWrites";
import { repoint } from "./renameTabs";
import { diffGutterExtension, setDiffMarkers, type Hunk } from "./diffGutter";
import { blameExtension, setAgentMarkers, setBlameMarkers, type TurnLink } from "./blameGutter";
import { blameFor, canPlaceBlame, dropBlame, emptyBlame } from "../../utils/blame";
import { agentLinesFor, dropAgentLines, emptyAgentLines } from "../../utils/agentLines";
import { chatsInFolder, liveChats } from "../../utils/chatSessions";
import { gitStateFor } from "../../utils/gitActions";
import { traceMark } from "../../utils/perfTrace";
import {
  claimedByLsp,
  ensureLspFor,
  lspPluginFor,
  lspTargetFor,
  notifyLspFileChanged,
  onLspChange,
  setCodeLensRefreshListener,
  setSemanticRefreshListener,
} from "./lspClient";
import { setBufferAccess } from "./liveBuffers";
import { cmdClickDefinitionExtension } from "./lspCommands";
import { caretListener, cursorJumpListener } from "./cursorJump";
import { breakpointGutter, setBreakpointMarkers } from "./breakpointGutter";
import type { BreakpointMark } from "../../utils/debugBreakpoints";
import { frameHighlight, setFrameLineMarker } from "./frameHighlight";
import { debugRunning } from "../../utils/debugStore";
import { debugHover } from "./debugHover";
import { swayRenameSymbol } from "./lspRenameCommand";
import { describeRename, type RenameOutcome } from "./lspRename";
import { applyCodeAction, caretRange, wholeFileRange } from "./codeActionCommand";
import { publishSourceActionKinds } from "../../utils/sourceActions";
import { codeActionBulb, setCodeActionLine } from "./codeActionBulb";
import { openPeek, selectPeekResult } from "./peekCommand";
import { peekField, peekKeymap, peekTheme, type PeekState } from "./peekView";
import {
  clearCodeActions,
  currentCodeActions,
  groupedCodeActions,
  onCodeActionsChange,
  refreshCodeActions,
  requestCodeActions,
  requestSourceAction,
  resolveCodeAction,
  sameRange,
  type CodeAction,
} from "./lspCodeActions";
import type { LspRange } from "./lspDiagnosticContext";
import { reattachLsp, reconfigureBuffers } from "./lspReattach";
import { refreshDocumentSymbols, requestWorkspaceSymbols } from "./lspSymbols";
import { callFetcher, noteCallSupport, rootCallHierarchy } from "./lspCallHierarchy";
import { refreshCodeLenses, type CodeLensDeps } from "./lspCodeLens";
import { codeLensExtension, setCodeLenses } from "./codeLensWidget";
import { refreshSemanticTokens, type SemanticDeps } from "./lspSemanticTokens";
import { semanticHighlight, semanticTokenCount, setSemanticTokens } from "./semanticHighlight";
import { formatForSave, type FormatDeps, type FormatResult } from "./formatOnSave";
import { organizeForSave, type OrganizeDeps } from "./organizeOnSave";
import { editsByUri } from "./workspaceEdit";
import { uriToPath } from "./swayWorkspace";
import { diffChanges, toDoc } from "./docDiff";
import { dropSymbols, clearSymbols, setWorkspaceSymbolSearch } from "../../utils/symbols";
import { clearCallRoots, dropCallRoots, setCallFetcher } from "../../utils/callHierarchy";
import { formatDocument, jumpToDefinition, findReferences } from "@codemirror/lsp-client";
import { fallbackCompletion } from "./fallbackCompletion";
import { fromDisk, type DiskText } from "./lineEndings";
import { rememberClosed, reviveClosed } from "./closedBuffers";
import { saveStash, stashToWrite, takeStashEntry, type HotExitStore, type StashEntry } from "../../utils/hotExit";
import { setDiagnosticsEffect } from "@codemirror/lint";
import { publishDiagnostics, dropDiagnostics, setDiagnosticFixLookup } from "../../utils/diagnostics";
import {
  isMarkdownPath,
  publishBufferText,
  dropLiveBuffer,
  handOff,
  takeHandOff,
  scrollFraction,
  lineAtFraction,
  fractionOfLine,
} from "../../utils/liveBuffer";
import { problemsFromState } from "./problemsFromState";
import { editorPrefExtensions } from "./editorPrefs";
import {
  selectionHistory,
  selectionKeymap,
  expandSelection,
  shrinkSelection,
  joinLines,
  splitSelectionIntoLines,
} from "./selectionCommands";
import { requestSend, composeSelectionMention, type SessionTarget } from "../../utils/safeSend";
import { selectionBlocks } from "../../utils/chatCompose";
import { findAdapter } from "../../utils/agents";
import { settings, zoom, editorDefaults, formatOnSaveFor, organizeImportsOnSaveFor, vimModeOn } from "../Settings/settingsStore";
import { vimExtension } from "./vimMode";
import {
  on as onEvent,
  onWith,
  emitWith,
  FILE_RENAMED,
  AGENT_FILES_WRITTEN,
  AGENT_WRITE_DEBOUNCE_MS,
  REFIT_PANES,
  EDITOR_SAVE,
  EDITOR_EXPAND_SELECTION,
  EDITOR_SHRINK_SELECTION,
  EDITOR_JOIN_LINES,
  EDITOR_SPLIT_SELECTION,
  EDITOR_STASH_DIRTY,
  EDITOR_STASH_RESULT,
  EDITOR_LSP_DEFINITION,
  EDITOR_LSP_REFERENCES,
  EDITOR_LSP_RENAME,
  EDITOR_LSP_FORMAT,
  EDITOR_LSP_CODE_ACTION,
  EDITOR_LSP_SOURCE_ACTION,
  EDITOR_PEEK_DEFINITION,
  EDITOR_PEEK_REFERENCES,
  SOURCE_KINDS,
  type SourceAction,
  REVEAL_TURN,
  TOAST,
  type AgentFilesWritten,
  type FileRenamed,
  type EditorStashDirty,
  type EditorStashResult,
  type RevealTurn,
  type ToastEvent,
  type FsChanged,
  EDITOR_FILE_SAVED,
  type EditorFileSaved,
} from "../../utils/events";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import Button from "../../components/Button/Button";
import Dropdown from "../../components/Menu/Dropdown";
import { type MenuItem } from "../../components/Menu/rows";
/** Where the code-action menu opens and what it offers. The old shared
 *  `MenuState` in the same shape; local now, since nothing else needs it. */
type ActionMenu = { x: number; y: number; items: MenuItem[] };
import styles from "./CodeEditor.module.css";

function relTo(root: string, abs: string): string {
  return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
}

const swayTheme = EditorView.theme(
  {
    "&": { backgroundColor: "var(--canvas-card)", color: "var(--fg-default)", height: "100%" },
    ".cm-content": {
      caretColor: "var(--fg-default)",
      fontFamily: 'var(--editor-font-family, "SF Mono", Menlo, Monaco, monospace)',
      fontSize: "var(--editor-font-size, 13px)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg-default)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accent-subtle)",
    },
    ".cm-gutters": { backgroundColor: "var(--canvas-card)", color: "var(--fg-subtle)", border: "none" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "var(--neutral-hover)" },
  },
  { dark: true },
);

// `pendingKind` (not a truthy `pendingExternal`) is what marks a deferred
// conflict: a deleted file's stashed text is the empty string, which would
// read as "no conflict" and silently drop the banner on tab activation.
// `lsp` is this buffer's own compartment holding the LSP plugin (or nothing).
// It has to be per buffer, not shared: `client.plugin(uri)` is file-addressed,
// so one compartment across buffers would hand every file the same file's
// plugin. Reconfiguring it is what lets a file opened before the server was
// ready pick LSP up in place, instead of needing a close and reopen.
// `completion` is a second per-buffer compartment beside it, holding the
// fallback completion a buffer gets only while no server claims it. Separate
// rather than folded into `lsp`, because it also moves when a *setting* moves,
// and reconfiguring `lsp` for that would close and reopen the document on the
// server every time an unrelated editor toggle was flipped.
// `eol` is a third, holding this file's line separator. A compartment rather
// than a plain field because a file can change its endings on disk under an
// open tab, and the value has to live in the state anyway: `state.lineBreak`
// reads it back, so there is no second copy to fall out of step with it.
// `savedText` is the buffer's *own* reading of the file (`sliceDoc`), not the
// raw disk string, so a CRLF file compares equal to itself. See lineEndings.ts.
type Buffer = {
  state: EditorState;
  savedText: string;
  lsp: Compartment;
  completion: Compartment;
  eol: Compartment;
  codeLens: Compartment;
  pendingExternal?: string;
  pendingKind?: ConflictKind;
  /** Where the reader was when this buffer last left a view. Live buffers only,
   *  so a stash and a closed tab still come back on the selection (see swapTo). */
  scrollSnap?: StateEffect<unknown>;
};
// "changed": the file still exists but its contents moved under unsaved edits.
// "deleted": the file is gone from disk (a checkpoint tree revert removes the
// files a later checkpoint had added). The deleted case raises the banner even
// for a clean buffer, because a clean buffer can still be saved, and that save
// would silently recreate the file and undo the revert.
type ConflictKind = "changed" | "deleted";
type Conflict = { path: string; external: string; kind: ConflictKind };

/** The per-buffer compartments, together because they are always built, passed
 *  and stored as a set. */
type BufferConf = { lsp: Compartment; completion: Compartment; eol: Compartment; codeLens: Compartment };

// What `toJSON`/`fromJSON` carry beyond the document and the selection. The
// undo history is the whole point of keeping a closed buffer at all; without
// naming the field here it is simply dropped, silently, and a reopened tab
// would look right and undo nothing.
const SERIALIZED_FIELDS = { history: historyField };

// Closed tabs, kept so reopening one is a return to where it was left rather
// than a fresh read (undo history included). Bounded; see closedBuffers.ts,
// which also explains why these are serialized rather than kept alive.
//
// **Module-level, not per component.** Editor.tsx mounts this pane only while
// some tab is open (`Editor.tsx:1160`), so closing the last one unmounts it and
// `onCleanup` destroys everything it held. A store living on the instance would
// therefore be empty in exactly the case the ticket is named after: one file
// open, closed, opened again.
const closedBuffers = new Map<string, { savedText: string; json: ReturnType<EditorState["toJSON"]> }>();

// A transaction one view is only being told about, so the view it came from is
// not told straight back (plan phase 9). Module-level: it identifies the kind of
// transaction, not any one editor's.
const Synced = Annotation.define<boolean>();

/** Multi-buffer, multi-view CM6 editor: one EditorState per open file (so
 *  cursor, selection and undo history are preserved per tab) and one EditorView
 *  per pane over them (plan phase 9). The buffer map is the authority; a second
 *  view onto the same file follows it. `props.openPaths` is the live tab set
 *  used to evict the state of closed tabs, and dirty transitions are pushed up
 *  via `props.onDirty`. */
export default function CodeEditor(props: {
  /** The panes wanting a view, in shell order (which is what decides who is the
   *  authority for a file two of them show), each with the element its view
   *  goes in. Ids rather than objects, so a path or visibility change never
   *  re-creates a view.
   *
   *  Absent is the solo form: one view in this component's own element showing
   *  `activePath`, which is what the editor was before it had panes and what
   *  every suite that mounts it directly still wants. */
  paneIds?: string[];
  paneHost?: (id: string) => HTMLElement | undefined;
  panePath?: (id: string) => string | null;
  paneHidden?: (id: string) => boolean;
  /** Whose view answers for the caret: every command, publish and git read
   *  comes off this one (plan phase 9 task 5). */
  focusedPaneId?: string | null;
  /** What the one view shows in the solo form, and whether it is CSS-hidden
   *  (not unmounted, so background buffers and undo history survive).
   *
   *  `panePath`/`paneHidden` win wherever `paneIds` is given, so the pane form
   *  may pass these too and they name the focused pane's file: that is the
   *  answer every consumer outside the panes means by "the active file". */
  activePath?: string | null;
  hidden?: boolean;
  /** Whether the Calls panel is on screen. Rooting a call hierarchy is a
   *  request per caret settle, and it is worth exactly nothing while nobody is
   *  looking at the answer; the tab's *visibility* costs no request at all. */
  callsVisible?: boolean;
  openPaths: string[];
  projectRoot: string | null;
  /** Every folder the fs watcher is currently covering: the workspace folder,
   *  or a Feature's members. A file under none of them gets no `fs://changed`,
   *  which is what the save guard below exists to make up for. */
  watchedRoots?: string[];
  goto: { path: string; line: number; col?: number; nonce: number } | null;
  onDirty: (path: string, dirty: boolean) => void;
  // The caret crossed enough lines in one step to count as a jump rather than
  // drift, so the pane's Back/Forward list has somewhere new to remember. Only
  // this component sees the caret, and only the pane knows which workspace the
  // file belongs to, so the decision is here and the list is there.
  onCursorJump?: (path: string, line: number) => void;
  // Where the caret is now, 1-based, whenever it could have moved. The trail
  // above the editor needs the drift `onCursorJump` deliberately throws away:
  // arrowing into the next function changes which symbol you are in without
  // being anywhere worth going Back to.
  onCaretMove?: (path: string, line: number, column: number) => void;
  // The active file's breakpoints, and the two ways they change from in here: a
  // click on the gutter, and an edit that moved one. The pane owns the store and
  // decides each one's state (it knows what the adapter said and whether the
  // buffer is saved); this component only draws it and says what happened.
  breakpoints?: readonly BreakpointMark[];
  onToggleBreakpoint?: (path: string, line: number) => void;
  onBreakpointsMoved?: (path: string, lines: number[], docLines: number) => void;
  // Where the debugger is paused, or null when nothing is. A path as well as a
  // line, because the highlight belongs on one buffer: the pane knows which
  // frame is selected and this component only knows which buffer is on screen.
  frameLine?: { path: string; line: number } | null;
  // Close a tab from inside the editor: the "take disk" choice on a
  // deleted-file conflict has no buffer left to show.
  onCloseFile?: (path: string) => void;
  // Absolute paths a checkpoint tree revert just rewrote or removed, with a
  // nonce so a repeat revert of the same files retriggers. Resolved through the
  // same path as any external change, rather than waiting on the fs watcher.
  reverted?: { paths: string[]; nonce: number } | null;
  // The sidebar's selected session, for the selection-mention keybinding
  // (safe-send target). Null disables the binding (toasts instead of a
  // silent no-op) the same way a missing session disables the hunk-comment
  // button.
  selected: Selection | null;
  // Show git blame: an age-shaded gutter stripe, and the commit behind the
  // cursor's line beside it. Held in a compartment rather than gated inside the
  // extension, so switching it off takes the whole column with it instead of
  // leaving an empty one.
  blame?: boolean;
  // This tab's soft-wrap override, or null to follow
  // the resolved `softWrap`. Per tab rather than global because
  // wrapping is a property of the file you are looking at (a wide CSV, a prose
  // paragraph), not of the editor.
  softWrap?: boolean | null;
  // The host's in-app confirm (WKWebView has no `window.confirm`). Used by the
  // cross-file rename, which has to ask before saving a background tab's
  // unsaved work. Absent means the rename refuses rather than deciding for the
  // user.
  confirm?: (opts: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
}) {
  // One view per pane (plan phase 9). `view` and `shown` still mean what they
  // always did, the view the user is acting in and the file it holds, and are
  // repointed as pane focus moves; everything that reads the caret reads them.
  // `pending` is the path a swap is on its way to: the first open of a file
  // awaits a read, and a second swap asked for the same file meanwhile would
  // read it all over again.
  type PaneRec = {
    id: string;
    view: EditorView;
    path: string | null;
    follower: boolean;
    /** Undefined while idle: a swap to `null` is a swap like any other, so
     *  "nothing pending" cannot be spelled the same way. */
    pending?: string | null;
    /** Per pane, not per component: two panes open files at the same time, and
     *  one shared counter would have each abort the other's read. */
    swaps: number;
    /** Where the reader last put this scroller. Recorded as it moves rather
     *  than read when it is needed: by the time a view is left its pane is
     *  hidden, and a hidden scroller has nothing worth reading. */
    snap?: StateEffect<unknown>;
    /** This view was just moved between panes and owes itself a restore. Also
     *  what makes the recording above ignore the reset the move itself fires. */
    moved?: boolean;
  };
  const views = new Map<string, PaneRec>();
  /** Views whose pane id went away in this flush, waiting for the pane that
   *  replaces it: a split and a worktree switch both re-key the editor's pane,
   *  and a rebuilt view throws away measured heights and the reader's place. */
  const parked: PaneRec[] = [];
  let sweeping = false;
  let view: EditorView | undefined;
  // The solo form's pane, so the two shapes differ in their props and nowhere
  // below them.
  const SOLO = "solo";
  const paneIds = (): string[] => props.paneIds ?? [SOLO];
  const pathOf = (id: string): string | null =>
    props.paneIds ? (props.panePath?.(id) ?? null) : (props.activePath ?? null);
  const hiddenOf = (id: string): boolean =>
    props.paneIds ? !!props.paneHidden?.(id) : !!props.hidden;
  const focusedId = (): string => props.focusedPaneId ?? paneIds()[0] ?? SOLO;
  const activePath = (): string | null => pathOf(focusedId());
  let unlistenFs: UnlistenFn | undefined;
  let offAgentWrites: (() => void) | undefined;
  // Coalesced across a burst: this event is per tool call, so a turn rewriting
  // one open file forty times would otherwise re-read it forty times. The set
  // accumulates rather than the last event winning, since a debounce drops the
  // payloads it swallows.
  const agentWritten = new Set<string>();
  const flushAgentWrites = debounce(() => {
    const paths = [...agentWritten];
    agentWritten.clear();
    for (const p of paths) {
      // Every path, not only the open ones. Which turn wrote which line is
      // exactly what an agent write changes, and its cache key carries no
      // version to notice with - not even the HEAD blame's does. A file cached
      // while it was open, closed, then written to by five more turns would
      // otherwise come back to a stale answer on reopening.
      if (props.projectRoot) dropAgentLines(props.projectRoot, relTo(props.projectRoot, p));
      // Same reason as the watcher's own loop: a headless workspace snapshot of
      // a file no tab holds still has to hear about the write.
      notifyLspFileChanged(p);
      if (buffers.has(p) && !isSelfWrite(p)) void handleExternalChange(p);
    }
  }, AGENT_WRITE_DEBOUNCE_MS);
  let offRefit: (() => void) | undefined;
  let offLsp: (() => void) | undefined;
  const buffers = new Map<string, Buffer>();
  let shown: string | null = null;

  // A file the tree renamed or moved: carry its buffer to the new key. The
  // unsaved text and the undo history live in the buffer, so leaving it under
  // the old key would strand them and hand the repointed tab a fresh read of
  // disk, silently discarding edits the tab still claims to hold. `shown` moves
  // too, or the next swap would think the visible buffer is a different file.
  const offRenamed = onWith<FileRenamed>(FILE_RENAMED, (d) => {
    if (!d?.from || !d.to) return;
    for (const [key, buf] of [...buffers]) {
      const next = repoint(key, d.from, d.to);
      if (next === null) continue;
      buffers.delete(key);
      buffers.set(next, buf);
      if (shown === key) shown = next;
    }
  });
  onCleanup(() => offRenamed());
  // The active buffer has an external on-disk change conflicting with unsaved
  // edits (drives the reload banner).
  const [conflict, setConflict] = createSignal<Conflict | null>(null);
  // The code-action menu, open at the caret. Held here rather than in a CM6
  // panel so it is the same menu component as every other list of choices in
  // the app, with the same keyboard and outside-click behaviour.
  //
  // The one surface in Sway with no trigger element: the caret is a coordinate,
  // not a control. That is what `Dropdown`'s `anchor` mode exists for, and why
  // it is a `DropdownMenu` rather than a `ContextMenu` (only the former accepts
  // both `open` and a virtual anchor).
  const [actionMenu, setActionMenu] = createSignal<ActionMenu | null>(null);

  // A pending "jump to line/col", applied once that file is the shown buffer
  // (the open may still be reading the file when the request arrives).
  let gotoReq: { path: string; line: number; col: number } | null = null;

  function applyGoto() {
    if (!view || !gotoReq || gotoReq.path !== shown) return;
    const doc = view.state.doc;
    const lineNo = Math.min(Math.max(gotoReq.line, 1), doc.lines);
    const line = doc.line(lineNo);
    const pos = line.from + Math.min(Math.max(gotoReq.col - 1, 0), line.length);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
    gotoReq = null;
  }

  // A buffer's text as the buffer itself reads it: lines joined with this
  // file's own ending. `sliceDoc` and never `doc.toString()`, which hard-codes
  // "\n" and so answers a different question for every CRLF file.
  function docOf(path: string): string | null {
    const live = authorityState(path);
    if (live) return live.sliceDoc();
    return buffers.get(path)?.state.sliceDoc() ?? null;
  }

  // The language workspace and the cross-file rename reach open buffers through
  // here rather than through the filesystem, because a background tab is
  // viewless and can be dirty: its text is in this map and nowhere else.
  // Registered in the component body, not in `onMount`, so a server that comes
  // up during the opening swap already sees it.
  const offBufferAccess = setBufferAccess({
    textOf: docOf,
    isDirty: (path) => {
      const buf = buffers.get(path);
      return !!buf && docOf(path) !== buf.savedText;
    },
    // The file on disk was just rewritten to exactly this, so the buffer takes
    // it as its baseline too. Without that the tab keeps the pre-rename text,
    // reads as dirty against a file that moved, and the next save quietly puts
    // the old name back.
    //
    // Through `fromDisk` rather than straight in, because the baseline has to be
    // the buffer's *own* reading of those bytes: a CRLF file compared against
    // the raw string is dirty the instant it is adopted (see lineEndings.ts).
    adopt: (path, text) => {
      const buf = buffers.get(path);
      if (!buf) return;
      const disk = fromDisk(text);
      setBufferText(path, disk);
      buf.savedText = disk.text;
      props.onDirty(path, false);
      if (path === shown) refreshDiff();
    },
    // The other half of the search buffer's write-back: this file has unsaved
    // edits, so its buffer is the copy that matters and disk is not. Checked
    // against `was` before anything is dispatched, so a buffer that has moved
    // on since the search takes none of the edits rather than some of them.
    // No baseline change: the buffer stays dirty, because it is.
    patch: (path, edits) => {
      const buf = buffers.get(path);
      if (!buf) return "absent";
      const live = authorityState(path) ?? buf.state;
      const changes: { from: number; to: number; insert: string }[] = [];
      for (const e of edits) {
        if (e.line < 1 || e.line > live.doc.lines) return "stale";
        const line = live.doc.line(e.line);
        if (live.sliceDoc(line.from, line.to) !== e.was) return "stale";
        changes.push({ from: line.from, to: line.to, insert: e.now });
      }
      if (!changes.length) return "applied";
      const owner = authorityView(path);
      if (owner) {
        owner.dispatch({ changes });
      } else {
        buf.state = buf.state.update({ changes }).state;
        // The background branch updates a stored state, so no update listener
        // fires: the same reason `setBufferText` publishes by hand.
        publishText(path, buf.state.sliceDoc());
        props.onDirty(path, buf.state.sliceDoc() !== buf.savedText);
      }
      return "applied";
    },
  });

  // Replace a buffer's whole document with text just read from disk, in the live
  // view if it's the active buffer, otherwise in its stored state. The file's
  // ending is re-detected and reconfigured in the same transaction: whatever
  // rewrote the file may have converted it, and a buffer left on the old
  // separator would convert it back on the next save.
  function setBufferText(path: string, disk: DiskText) {
    const buf = buffers.get(path);
    if (!buf) return;
    // `Text.of` rather than the string, so the split is this module's and not a
    // function of the separator being configured in the same breath.
    const insert = Text.of(disk.lines);
    const effects = buf.eol.reconfigure(EditorState.lineSeparator.of(disk.eol));
    const live = authorityView(path);
    if (live) {
      live.dispatch({ changes: { from: 0, to: live.state.doc.length, insert }, effects });
    } else {
      buf.state = buf.state.update({
        changes: { from: 0, to: buf.state.doc.length, insert },
        effects,
      }).state;
    }
    // The background branch above updates a stored state rather than the view,
    // so no update listener fires - and a buffer being previewed is always the
    // background one, since showing the preview is what nulls `activePath`.
    // Without this an agent write landing under an open preview would render
    // the text the buffer held before it.
    publishText(path, disk.text);
  }

  // An open file changed on disk (already filtered to genuine external edits).
  // Clean buffer: reload in place. Dirty buffer: stash the disk version and
  // raise a conflict banner (now if active, on activation otherwise).
  /** Is this path outside every folder the watcher covers?
   *
   *  An agent's own config home (`~/.claude`) is the case this exists for: real
   *  files, opened as ordinary tabs, that no `fs://changed` ever mentions. The
   *  test is prefix-on-a-separator rather than `startsWith` alone, so `/a/bc`
   *  does not read as living under `/a/b`. */
  function outsideWatched(path: string): boolean {
    const roots = props.watchedRoots ?? (props.projectRoot ? [props.projectRoot] : []);
    // An empty set is not "everything is covered", it is "the watcher is
    // running over nothing" - a Feature with no present member, or the moment
    // before a selection lands. Every path is outside that.
    return !roots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : `${r}/`));
  }

  /** What disk said when this out-of-root file was last read or written. Only
   *  out-of-root paths get an entry; everything else is covered by the watcher
   *  and would just be a second, staler answer. */
  const unwatchedMtime = new Map<string, number>();

  async function noteMtime(path: string) {
    if (!outsideWatched(path)) return;
    const at = await invoke<number | null>("fs_mtime_ms", { path }).catch(() => null);
    if (at !== null && at !== undefined) unwatchedMtime.set(path, at);
    else unwatchedMtime.delete(path);
  }

  /** Has an out-of-root file moved under us since we last looked?
   *
   *  `false` whenever the answer is not known (in-root, never recorded, or a
   *  stat that failed): a guard that blocked saves on "cannot tell" would make
   *  every unreadable stat look like somebody else's edit. */
  async function movedSinceLastRead(path: string): Promise<boolean> {
    const known = unwatchedMtime.get(path);
    if (known === undefined) return false;
    const at = await invoke<number | null>("fs_mtime_ms", { path }).catch(() => null);
    return at !== null && at !== undefined && at !== known;
  }

  async function handleExternalChange(path: string) {
    if (!buffers.has(path)) return;
    // Somebody else wrote the file, so which of its lines are uncommitted is no
    // longer what was read - even though HEAD has not moved, which is the one
    // thing the cache key knows about. Dropped here rather than re-read: the
    // reload below decides whether this buffer adopts the new text at all.
    if (props.projectRoot) {
      dropBlame(props.projectRoot, relTo(props.projectRoot, path));
      // And a write is the only thing that changes who wrote which line, so this
      // one has nothing else to notice it.
      dropAgentLines(props.projectRoot, relTo(props.projectRoot, path));
    }
    let raw: string;
    try {
      raw = await invoke<string>("fs_read_file", { path });
    } catch {
      // Unreadable: either the file is gone (a tree revert removing a
      // later-added file), or the read failed transiently. Only a confirmed
      // absence raises the deleted conflict, so a flaky read never closes a tab.
      const gone = await invoke<boolean>("file_exists", { path })
        .then((exists) => !exists)
        .catch(() => false);
      const deletedBuf = gone ? buffers.get(path) : undefined;
      if (!deletedBuf) return;
      deletedBuf.pendingExternal = "";
      deletedBuf.pendingKind = "deleted";
      if (path === shown) setConflict({ path, external: "", kind: "deleted" });
      return;
    }
    // Disk as of this read, whatever the buffer decides to do with it. Without
    // this the guard would keep firing on a reading it has already resolved.
    void noteMtime(path);
    const buf = buffers.get(path);
    if (!buf) return; // closed while reading
    // Compared as the buffer would hold it, not as the bytes arrived: a file
    // whose endings the writer normalized differs byte for byte while saying
    // exactly the same thing, and reloading on that would throw away the
    // selection and the undo history for no change the user can see.
    const disk = fromDisk(raw);
    const current = docOf(path);
    if (current === null || (disk.text === current && disk.eol === buf.state.lineBreak)) {
      buf.savedText = disk.text;
      if (path === shown) refreshDiff();
      return;
    }
    const dirty = current !== buf.savedText;
    if (!dirty) {
      buf.savedText = disk.text; // set baseline first so the dirty listener stays clean
      setBufferText(path, disk);
      props.onDirty(path, false);
      if (path === shown) {
        refreshDiff();
        // The buffer just adopted a different file, so its markers describe
        // lines that are no longer there. Clean again, so a rebuild is safe.
        void refreshBlame();
        void refreshAgentLines();
      }
    } else {
      // Stashed already normalized, so "take disk" adopts exactly what was
      // compared here. `fromDisk` is idempotent over its own output, which is
      // what lets the stash stay a plain string.
      buf.pendingExternal = disk.text;
      buf.pendingKind = "changed";
      if (path === shown) setConflict({ path, external: disk.text, kind: "changed" });
    }
  }

  // "Take disk": for a changed file, adopt the on-disk text. For a deleted one
  // there is nothing to adopt, so the tab closes - keeping it open would leave
  // a buffer whose only possible save recreates the file the revert removed.
  function reloadConflict() {
    const c = conflict();
    const buf = c && buffers.get(c.path);
    if (!c || !buf) return setConflict(null);
    delete buf.pendingExternal;
    delete buf.pendingKind;
    if (c.kind === "deleted") {
      buf.savedText = buf.state.sliceDoc(); // clean, so the close carries no discard prompt
      props.onDirty(c.path, false);
      setConflict(null);
      props.onCloseFile?.(c.path);
      return;
    }
    buf.savedText = c.external;
    setBufferText(c.path, fromDisk(c.external));
    props.onDirty(c.path, false);
    if (c.path === shown) refreshDiff();
    setConflict(null);
  }

  // "Keep mine": for a changed file, keep the buffer as it is. For a deleted
  // one the buffer becomes dirty against an empty baseline, so the file comes
  // back only when the user explicitly saves, never as a silent side effect.
  function keepMine() {
    const c = conflict();
    const buf = c && buffers.get(c.path);
    if (buf) {
      delete buf.pendingExternal;
      delete buf.pendingKind;
      if (c.kind === "deleted") {
        buf.savedText = "";
        props.onDirty(c.path, true);
      }
    }
    setConflict(null);
  }

  // Re-read the active file's blame and repaint its stripe.
  //
  // Called on a buffer swap, when blame is switched on, and when HEAD moves -
  // **not** on save and not on a keystroke. The markers have already followed
  // the edit through CM6's change mapping (see blameGutter.ts), which is a
  // better answer than a re-read, not merely a cheaper one.
  //
  // Laying markers down is the delicate half. `blame.lines` is indexed by the
  // line numbering of the file *on disk*, so it may only be laid onto a buffer
  // that still matches disk. A dirty buffer already carries markers that were
  // mapped through its own edits, and those are right; rebuilding would replace
  // them with ones off by however much has been typed above.
  async function refreshBlame() {
    const path = shown;
    const root = props.projectRoot;
    if (!path || !root || !view) return;
    if (!props.blame) return;
    // HEAD comes from the shared git store, which re-reads it on exactly the
    // events that move it. No HEAD (unborn, or a folder that is not a repo)
    // means there is nothing to blame against.
    const head = gitStateFor(root).head ?? "";
    const blame = head ? await blameFor(root, relTo(root, path), head) : emptyBlame();
    if (!view || shown !== path || !props.blame) return;
    if (!canPlaceBlame(view.state.sliceDoc(), buffers.get(path)?.savedText)) return;
    setBlameMarkers(view, blame);
  }

  // Re-read which agent turn wrote each uncommitted line.
  //
  // Called on a buffer swap and when blame is switched on, and - unlike blame -
  // **not** when HEAD moves: committing does not change who wrote a line, it
  // only makes the commit the better answer, and the commit is read first.
  //
  // Same placement rule as blame, for the same reason: the line numbers are the
  // file's on disk, so they may only be laid onto a buffer that still matches it.
  async function refreshAgentLines() {
    const path = shown;
    const root = props.projectRoot;
    if (!path || !root || !view) return;
    if (!props.blame) return;
    // The chats in this worktree. Passed in rather than discovered because a
    // bare repo's worktrees share one ref store, so the sessions git can see
    // include ones whose checkpoints describe a different set of files.
    const sessions = chatsInFolder(root).map((c) => c.sessionId);
    const agent = sessions.length
      ? await agentLinesFor(root, relTo(root, path), sessions)
      : emptyAgentLines();
    if (!view || shown !== path || !props.blame) return;
    if (!canPlaceBlame(view.state.sliceDoc(), buffers.get(path)?.savedText)) return;
    setAgentMarkers(view, agent);
  }

  // Re-diff the active file and repaint the gutter. Called directly on save and
  // on a genuine external fs://changed (a save's own echo is skipped via
  // isSelfWrite, so a save produces exactly one re-diff).
  async function refreshDiff() {
    const path = shown;
    const root = props.projectRoot;
    if (!path || !root || !view) return;
    let hunks: Hunk[] = [];
    try {
      hunks = await invoke<Hunk[]>("git_diff_file", { projectPath: root, file: relTo(root, path) });
    } catch {
      hunks = [];
    }
    if (view && shown === path) setDiffMarkers(view, hunks);
  }

  /** Run the project's formatter over `text`, or hand it straight back when the
   *  project has none. Never rejects for a formatter's own refusal. */
  function runProjectFormatter(path: string, text: string): Promise<FormatResult> {
    return invoke<FormatResult>("format_document", {
      path,
      text,
      projectPath: props.projectRoot ?? "",
    });
  }

  /** That path's live document, on screen or stashed, or null when no buffer
   *  holds it. Addressed by path rather than by "whatever is shown": a format
   *  takes long enough for an ordinary tab click, and the save it belongs to
   *  still has to write the file it started on. */
  function docFor(path: string): Text | null {
    const live = authorityState(path);
    if (live) return live.doc;
    return buffers.get(path)?.state.doc ?? null;
  }

  const formatDeps: FormatDeps = {
    format: runProjectFormatter,
    // Read fresh each time: the whole guard is "is this still the document the
    // formatter was given?", and a captured reference could not answer it.
    current: (path) => {
      const doc = docFor(path);
      // `docOf`, not `doc.toString()`: the identity check wants the same
      // reading of the text that the save will write, and `toString` hard-codes
      // "\n" for every CRLF file (see lineEndings.ts).
      const text = docOf(path);
      return doc && text !== null ? { text, id: doc } : null;
    },
    report: (message) => emitWith<ToastEvent>(TOAST, { message, kind: "error" }),
  };

  /** The organize-imports half of a save. Shares `formatDeps.current`, which is
   *  the same question asked of the same buffer, and adds the one thing only
   *  this side needs: the server's edits for the file.
   *
   *  No `report`. A formatter's complaint is usually a syntax error at a line
   *  number, which is worth reading; a server that has no organize-imports for
   *  this file has nothing to say about a save the user just asked for. */
  const organizeDeps: OrganizeDeps = {
    current: formatDeps.current,
    organize: async (path) => {
      if (!view || path !== shown) return null;
      const action = await requestSourceAction(path, SOURCE_KINDS.organizeImports, wholeFileRange(view));
      if (!action) return null;
      // A command-only action cannot be applied to text on its way to disk: it
      // would run through the server and come back as a `workspace/applyEdit`
      // dispatched into the buffer, arriving after this save had already
      // written the file. Skipped rather than raced.
      const full = action.edit ? action : await resolveCodeAction(path, action);
      const forThisFile = editsByUri(full.edit).find((t) => uriToPath(t.uri) === path);
      return forThisFile?.edits ?? null;
    },
  };

  /** Put formatted text into that file's buffer as a minimal change, so the
   *  caret stays on the line it was on. A whole-document replacement maps every
   *  position to the end of the change, which would move the cursor on every
   *  single save.
   *
   *  Same shown-versus-stashed split as `setBufferText` and `reattachLsp`: a
   *  buffer that is not on screen is in no view and can only be updated through
   *  `state.update`. */
  function applyFormatted(path: string, text: string) {
    const doc = docFor(path);
    if (!doc) return;
    const changes = diffChanges(doc, toDoc(text));
    const live = authorityView(path);
    if (live) {
      live.dispatch({ changes, userEvent: "format" });
      return;
    }
    const buf = buffers.get(path);
    if (buf) buf.state = buf.state.update({ changes, userEvent: "format" }).state;
  }

  async function saveActive() {
    const path = shown;
    const authority = path ? authorityState(path) : undefined;
    if (!path || !authority) return;
    // `sliceDoc`, never `doc.toString()`: the latter hard-codes "\n" and so
    // answers a different question for every CRLF file, which is what makes the
    // bytes written below the buffer's own (see lineEndings.ts).
    let text = authority.sliceDoc();
    // Before the formatter, not after: organizing rewrites the import block and
    // the formatter is what decides how that block is laid out, so the other
    // order would leave the file formatted the way it was *before* the rewrite.
    // Bounded inside `organizeForSave`, because this one asks a language server
    // and a server can simply not answer.
    if (organizeImportsOnSaveFor(props.projectRoot)) {
      const outcome = await organizeForSave(organizeDeps, path, { text, id: authority.doc });
      if (outcome.kind === "gone") return;
      if (outcome.kind === "organized") applyFormatted(path, outcome.text);
      text = outcome.text;
    }
    // Ahead of the write, so what lands on disk and what is in the buffer are
    // the same bytes. Gated on the setting first: detection is a directory walk
    // in the backend, and a project that has opted out should not pay for it.
    // The authority's doc is re-read here rather than reused from above:
    // organizing may have just replaced it, and handing the formatter the old
    // identity would make it discard its own result when both settings are on.
    if (formatOnSaveFor(props.projectRoot)) {
      const outcome = await formatForSave(formatDeps, path, { text, id: authorityState(path)?.doc ?? authority.doc });
      if (outcome.kind === "gone") return;
      if (outcome.kind === "formatted") applyFormatted(path, outcome.text);
      text = outcome.text;
    }
    // Nothing under a watched root reaches this: there, `fs://changed` has
    // already raised the conflict before a save could clobber anything. Out of
    // root there is no watcher, so the check happens at the last moment it can
    // still matter, and the write is skipped rather than merged.
    if (await movedSinceLastRead(path)) {
      await handleExternalChange(path);
      return;
    }
    try {
      await invoke("fs_write_file", { path, contents: text });
      markSelfWrite(path);
      // Ours now, so the next save compares against what we just wrote rather
      // than against the reading from before it. Awaited rather than fired off
      // because the ordering against a save that follows it closely would
      // otherwise rest on which IPC round trip lands first, which is not a
      // thing worth resting on. No test pins this: the mocked backend resolves
      // in one microtask, so the interleaving it guards against cannot be
      // reproduced in the harness.
      await noteMtime(path);
      // The bytes as written, after the formatter, for whoever mirrors this
      // file elsewhere (the chat composer's draft).
      emitWith<EditorFileSaved>(EDITOR_FILE_SAVED, { path, contents: text });
      // A version of the file as it was just saved, whether or not it is ever
      // committed. One blob write, deduped against the newest entry, and not
      // awaited: the save has already landed, and local history is a record of
      // it rather than part of it, so a repo that cannot store one must not make
      // the save look like it failed.
      if (props.projectRoot) {
        void invoke("local_history_note", { repoPath: props.projectRoot, path }).catch(() => {});
      }
      const buf = buffers.get(path);
      if (buf) buf.savedText = text;
      props.onDirty(path, false);
      refreshDiff();
      // The file on disk is no longer the file that was blamed, so the cached
      // read is spent - but nothing is re-read *here*: the markers on screen
      // were mapped through exactly the edits just saved and are still right.
      // The next rebuild (a swap, a toggle) is what pays for a fresh read.
      if (props.projectRoot) {
        dropBlame(props.projectRoot, relTo(props.projectRoot, path));
        dropAgentLines(props.projectRoot, relTo(props.projectRoot, path));
      }
    } catch (e) {
      console.error("save failed", path, e);
    }
  }

  function target(): SessionTarget | null {
    const sel = props.selected;
    if (!sel?.sessionId) return null;
    return {
      sessionId: sel.sessionId,
      agent: sel.agent ?? "claude",
      profile: sel.profile,
      folderPath: sel.folderPath,
      sessionCwd: sel.sessionCwd,
      sessionPath: sel.sessionPath,
      sessionTitle: sel.sessionTitle,
      sessionFile: sel.sessionFile,
    };
  }

  function disabledReason(): string | null {
    const sel = props.selected;
    if (!sel?.sessionId) return "Select a session first";
    if (findAdapter(sel.agent ?? "claude").resume_args.length === 0) return "This agent's sessions can't be resumed";
    return null;
  }

  // Selection mention (safe-send, no trailing Enter): inserts `@<file>#Lx-Ly`
  // for the active buffer's current selection at the selected session's
  // prompt. Same relativity rule as the hunk-comment affordance (mentionPath
  // via composeSelectionMention) - inside the session's cwd, relative;
  // outside it (a Shared-tree buffer), absolute.
  async function sendSelectionMention() {
    if (!view || !shown) return true;
    const reason = disabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return true;
    }
    const t = target();
    if (!t) return true;
    const sel = view.state.selection.main;
    const doc = view.state.doc;
    const startLine = doc.lineAt(sel.from).number;
    const endLine = doc.lineAt(sel.to).number;
    const mention = composeSelectionMention(t, shown, startLine, endLine);
    // The selected text rides along for a chat target, which can hold it as
    // structure. A PTY target gets the mention alone, exactly as before: pasting
    // the region's text into a prompt line is not something a terminal can do
    // without breaking the insert-only, single-line contract.
    await requestSend({
      ...t,
      text: mention,
      blocks: selectionBlocks(shown, startLine, endLine, view.state.sliceDoc(sel.from, sel.to)),
    });
    return true;
  }

  // One compartment for the whole editor, unlike the LSP compartment beside it:
  // that one is per buffer because `client.plugin(uri)` is file-addressed, while
  // blame on/off is a single preference every buffer wants the same answer to.
  // It starts empty and is filled by `syncBlame`, so exactly one place decides
  // what the config is - a stashed buffer built while blame was off picks the
  // current setting up when it is swapped in.
  const blameConf = new Compartment();

  // Vim keybindings, on the same arrangement and for the same reason: one
  // preference every buffer wants the same answer to, filled by `syncVim`.
  const vimConf = new Compartment();

  // How the inline widget names a chat, and what clicking it does. The editor
  // holds both because neither is the gutter's business: one is the chat panel's
  // list of open sessions, the other is a pane the editor does not own.
  const turnLink: TurnLink = {
    nameFor: (sessionId) => liveChats().find((c) => c.sessionId === sessionId)?.sessionName,
    onOpen: (turn) =>
      emitWith<RevealTurn>(REVEAL_TURN, { sessionId: turn.session_id, promptTs: turn.prompt_ts }),
  };

  function syncBlame() {
    view?.dispatch({ effects: blameConf.reconfigure(props.blame ? blameExtension(turnLink) : []) });
    void refreshBlame();
    void refreshAgentLines();
  }

  // The editing-comfort preferences (settings.editor), on the same terms as
  // `blameConf` beside it: one compartment for the whole editor, because these
  // are single preferences every buffer wants the same answer to, filled by
  // `syncEditorPrefs` so exactly one place decides what the config is.
  //
  // Wave 5 fills this in one line per feature. It resolves to nothing today,
  // which is deliberate: the plumbing and its swap-time re-sync land once, and
  // each later phase adds an entry rather than re-deriving where a preference
  // is allowed to live.
  const prefsConf = new Compartment();

  /** The settings, plus this tab's overrides. One reader, so a buffer built now
   *  and a buffer swapped in later cannot be handed different arguments. */
  function currentPrefExtensions(): Extension[] {
    return editorPrefExtensions(editorDefaults(), { softWrap: props.softWrap });
  }

  // Reconfigure reaches the *active* state only; a stashed buffer keeps the
  // config it was built with until it is swapped back in, which is why
  // `swapTo` calls this too.
  function syncEditorPrefs() {
    if (!view) return;
    view.dispatch({ effects: prefsConf.reconfigure(currentPrefExtensions()) });
    // A view plugin that this reconfigure just *constructed* never receives the
    // update that transaction produced: it did not exist when the update was
    // built. A plugin that only draws from `update()` therefore sits unpainted
    // until the next transaction, whatever that turns out to be.
    //
    // The minimap is one. Its width is set inside the render it runs on update,
    // so switching it on by itself left a zero-width column that the first
    // keystroke, scroll or pane resize would fix - which reads as the setting
    // not working. `requestMeasure` does not help, because the thing it missed
    // is an update and not a measure. An empty transaction is exactly that
    // update, and costs one no-op cycle on a settings change.
    view.dispatch({});
  }

  // Called on every swap as well as on the setting changing, which is what lets
  // a background buffer built before the switch pick it up: only the shown
  // buffer is in the view, so this is the one place the setting can land, and a
  // buffer that was not on screen when it changed gets it on the way in.
  function syncVim() {
    view?.dispatch({ effects: vimConf.reconfigure(vimExtension(vimModeOn())) });
  }

  // Declared before the extension list so the field can be handed to both the
  // list and the event handlers. The select callback closes over `peek` itself,
  // which is only read when a row is clicked, long after this line has run.
  const peek: StateField<PeekState | null> = peekField((v, index) => void selectPeekResult(v, peek, index));

  /** Peek from the caret, in whichever file is on screen. A no-op with no file
   *  open, which is the state the palette's `editorFile` requirement usually
   *  keeps this out of but the event bus cannot promise. */
  function peekFromCaret(kind: "definition" | "references") {
    const path = props.activePath;
    if (!view || !path) return;
    void openPeek(view, kind, path);
  }

  // A follower view (a second pane onto the same file) gets everything except
  // the undo history: one document has one history, it lives on the authority,
  // and the keymap below routes this view's undo there.
  const commonExtensions = (follower = false): Extension[] => [
    // First, and load-bearing. Vim intercepts keys through a ViewPlugin DOM
    // handler, and for a key both it and a keymap claim, whichever is earlier
    // in this array takes it. `defaultKeymap`'s Mac Emacs bindings (Ctrl-A,
    // Ctrl-E, Ctrl-D, Ctrl-K) collide with vim's Ctrl commands, and in normal
    // mode vim is the one that should win. `vimMode.test.tsx` pins the rule.
    vimConf.of([]),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    ...(follower ? [] : [history()]),
    drawSelection(),
    dropCursor(),
    // Without this facet the searchKeymap's Mod-d / Mod-Shift-l silently
    // collapse to a single range; Alt-drag columns come from the pair below.
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    // Text arriving from outside the editor is re-broken to this buffer's own
    // ending. Setting `lineSeparator` (see lineEndings.ts) changes more than the
    // way a document reads back: `EditorState.toText` splits an incoming string
    // by it, and that is the function both paste and drop go through. Without
    // this, three LF lines pasted into a CRLF file land as *one* line holding
    // two literal "\n" characters, which `highlightSpecialChars` below then
    // draws as placeholders and a save writes out as bytes.
    EditorView.clipboardInputFilter.of((text, state) =>
      text.replace(/\r\n?|\n/g, state.lineBreak),
    ),
    highlightSpecialChars(),
    foldGutter(),
    highlightSelectionMatches(),
    diffGutterExtension(),
    blameConf.of([]),
    prefsConf.of(currentPrefExtensions()),
    // What the selection was before it last grew, so shrink has somewhere to go
    // back to. Per buffer, like the undo history beside it: an expansion chain
    // is about one document's syntax.
    selectionHistory,
    syntaxHighlighting(swayHighlight),
    // After the highlight style, not before: the grammar colours everything
    // immediately and offline, and the server's answer lands on top of the
    // subset it has actually resolved.
    semanticHighlight(),
    swayTheme,
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          void saveActive();
          return true;
        },
      },
      {
        key: "Mod-Shift-m",
        preventDefault: true,
        run: () => {
          void sendSelectionMention();
          return true;
        },
      },
      {
        // The chord every other editor uses for this. ⌘. is not free here: it
        // stops a running agent turn, from any surface including this one.
        key: "Alt-Enter",
        // Deliberately no `preventDefault`, unlike its neighbours above.
        // CodeMirror honours that flag even when the command *declines*
        // (`@codemirror/view/dist/index.js:9154`), which would swallow the key
        // in every buffer with no language client. Returning true already
        // prevents the default on its own, so the flag would only ever change
        // the case this binding wants to keep out of.
        run: (v) => {
          // Falls through in a buffer with no language client, so it stays an
          // ordinary unbound key rather than a dead one.
          if (!caretRange(v)) return false;
          void openCodeActions();
          return true;
        },
      },
      {
        // VS Code's peek chord. Declines rather than preventing the default in
        // a buffer no server claims, for `Alt-Enter`'s reason above: a binding
        // that swallows a key it cannot act on is worse than no binding.
        key: "Alt-F12",
        run: () => {
          const p = activePath();
          if (!p || !claimedByLsp(p)) return false;
          peekFromCaret("definition");
          return true;
        },
      },
      // Before defaultKeymap, whose `Mod-i` runs `selectParentSyntax` without
      // recording where the selection came from; see `selectionKeymap`.
      ...selectionKeymap,
      // Before defaultKeymap so pair-aware Backspace wins over plain delete.
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    // The lightbulb, drawn after the caret line's text so it never moves code.
    // Clicking it asks again rather than reusing what the bulb was drawn from:
    // a click is a deliberate act, and the answer behind the bulb is up to half
    // a second old by construction.
    codeActionBulb({ onClick: () => void openCodeActions() }),
    // What moves the bulb. Both triggers matter: typing changes what the server
    // would say, and moving the caret changes which line is being asked about.
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) {
        refreshCodeActionsSoon();
        refreshCallsSoon();
      }
    }),
    // Falls through to an ordinary click for a file with no server, so it costs
    // nothing in a buffer the LSP knows nothing about.
    cmdClickDefinitionExtension,
    // The peek and its Esc binding. Ordinary precedence, deliberately: with vim
    // on and the *outer* editor focused, Esc belongs to vim (leaving insert
    // mode is the more common intent, and stealing it would be a regression in
    // every buffer). Esc from inside the widget is handled by the widget's own
    // capture-phase listener, which a keymap out here cannot reach anyway.
    peek,
    peekKeymap(peek),
    peekTheme,
    // F2 must reach Sway's rename, not the library's. `languageServerExtensions()`
    // binds it to `renameSymbol`, whose `doRename` skips every file the user has
    // not already opened - silently, which is the worst way for a rename to be
    // wrong. Highest precedence because that keymap arrives through the LSP
    // compartment, which is reconfigured after this array is built.
    Prec.highest(
      keymap.of([
        {
          key: "F2",
          preventDefault: true,
          run: (v) => swayRenameSymbol(v, renameIo),
        },
      ]),
    ),
  ];

  // Mirror a buffer's lint state into the Problems store. Only files with a
  // live buffer ever reach here, which is what keeps a monorepo's server-wide
  // publishes from accumulating: the store never learns about a file the user
  // has not opened.
  function publishFrom(path: string, state: EditorState) {
    publishDiagnostics(path, problemsFromState(state));
  }

  // Mirror a buffer's text out to the surfaces that render the same file
  // without owning it. Only the ones with such a surface: the store holds whole
  // documents, and a second copy of every open buffer would be a real cost paid
  // for nothing.
  function publishText(path: string, text: string) {
    if (isMarkdownPath(path)) publishBufferText(path, text);
  }

  /** Completion for a buffer no language server is claiming, which is most of
   *  them: the server covers TS and JS under the project root, and brings its
   *  own completion with it. Re-resolved whenever either half of that answer
   *  moves, the client's liveness or the preference. */
  function currentFallbackCompletion(path: string): Extension {
    return fallbackCompletion(path, {
      on: editorDefaults().wordCompletion,
      claimed: claimedByLsp(path),
    });
  }

  /** Whether this buffer draws code lenses. One preference rather than a
   *  per-file answer, so it takes no path: a server with no `codeLensProvider`
   *  simply never paints any, which costs an empty field rather than a branch
   *  here. */
  function currentCodeLens(): Extension {
    return codeLensExtension(editorDefaults().codeLens ?? false);
  }

  /**
   * Everything one buffer's state is configured with.
   *
   * Its own function because a buffer is built two ways: from the file, and
   * from a closed tab's serialized state. Both must land on *this* instance's
   * configuration, since half of what is below belongs to the component that
   * built it (the listeners close over `buffers` and `props`, and the
   * compartments in `commonExtensions` are objects only this instance holds).
   * A second copy of this list is a second chance for one of the two to be
   * missing something.
   *
   * `disk` rather than a string, so the separator that will write the lines
   * back is configured beside the lines themselves.
   */
  function bufferExtensions(
    path: string,
    disk: DiskText,
    lang: Extension,
    conf: BufferConf,
    follower = false,
  ): Extension[] {
    return [
      ...commonExtensions(follower),
      lang,
      conf.eol.of(EditorState.lineSeparator.of(disk.eol)),
      // One view per file talks to the server (plan phase 9 task 4): a follower
      // would double every notification and answer for a document it does not own.
      conf.lsp.of(follower ? [] : lspPluginFor(path)),
      // Undo and redo belong to the authority's history, whichever view the key
      // was pressed in. Highest precedence, so it beats historyKeymap's own.
      ...(follower
        ? [
            Prec.highest(
              keymap.of([
                { key: "Mod-z", preventDefault: true, run: () => runOnAuthority(path, undo) },
                { key: "Mod-Shift-z", preventDefault: true, run: () => runOnAuthority(path, redo) },
                { key: "Mod-y", preventDefault: true, run: () => runOnAuthority(path, redo) },
              ]),
            ),
          ]
        : []),
      // Every view onto this file mirrors what the others typed, over one
      // document: the change set is applied to the same doc it was made against,
      // and the annotation is what stops the two from echoing forever.
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.some((t) => t.annotation(Synced))) return;
        for (const rec of views.values()) {
          if (rec.path === path && rec.view !== u.view) {
            rec.view.dispatch({ changes: u.changes, annotations: Synced.of(true) });
          }
        }
        // The authority's live state is the buffer's state: keeping it current
        // here is what lets save, dirty, hot exit and the LSP read the map
        // without asking which pane happened to be focused.
        if (!follower) {
          const buf = buffers.get(path);
          if (buf) buf.state = u.state;
        }
      }),
      conf.completion.of(currentFallbackCompletion(path)),
      conf.codeLens.of(currentCodeLens()),
      EditorView.updateListener.of((u) => {
        // Diagnostics arrive as a transaction effect from the LSP client, so
        // republish only when one actually lands rather than on every keypress.
        if (u.transactions.some((t) => t.effects.some((e) => e.is(setDiagnosticsEffect)))) {
          publishFrom(path, u.state);
        }
      }),
      // A caret jump, for the pane's Back/Forward list. The rule for what counts
      // as one lives in `cursorJump.ts`.
      cursorJumpListener((line) => props.onCursorJump?.(path, line)),
      // Every caret position, for the breadcrumb trail. Its own listener rather
      // than a second job for the one above: the two want opposite things from
      // the same updates, and the pair reads as one rule with an exception when
      // they share a body.
      caretListener((line, column) => props.onCaretMove?.(path, line, column)),
      // Per buffer rather than in `commonExtensions`, because both handlers have
      // to name the file they are talking about and only this closure knows it.
      breakpointGutter({
        onToggle: (line) => props.onToggleBreakpoint?.(path, line),
        onMoved: (lines, docLines) => props.onBreakpointsMoved?.(path, lines, docLines),
      }),
      frameHighlight(),
      // Beside the frame highlight rather than in `commonExtensions`, because
      // both are the paused program showing through the buffer and they should
      // arrive and leave together.
      debugHover(path),
      EditorView.updateListener.of((u) => {
        // The authority reports; a follower's own listener would say the same
        // thing about the same document a moment later (task 3).
        if (!u.docChanged || follower) return;
        const text = u.state.sliceDoc();
        const buf = buffers.get(path);
        if (buf) props.onDirty(path, text !== buf.savedText);
        // The same reading the dirty check just took, so the preview costs
        // nothing beyond the store write: it renders this buffer, unsaved
        // edits included, rather than the file underneath it.
        publishText(path, text);
        // Typing moves every symbol below the caret and can add or remove one,
        // so the outline is re-asked rather than mapped through the change:
        // only the server knows whether what was typed is a symbol yet.
        if (path === shown) {
          refreshSymbolsSoon();
          // The decorations already in the state map through this change, so
          // the file stays coloured while it is being typed into; this is what
          // eventually makes those colours right again. A new parameter is a
          // parameter only once the server has parsed it.
          refreshSemanticSoon();
          // And the lenses, which the field maps through the change so they
          // stay on screen, but which only the server can put back on the right
          // line once what was typed has moved the functions below it.
          refreshLensesSoon();
        }
      }),
    ];
  }

  /** Lay the pane's breakpoints onto the buffer on screen. Only the shown one: a
   *  background buffer is not being edited, so its positions cannot have drifted
   *  and it is re-seeded when it comes back. */
  function syncBreakpoints() {
    if (view && shown) setBreakpointMarkers(view, props.breakpoints ?? []);
  }

  /** Put the paused-line stripe on the buffer that holds it, and on no other.
   *  Only the shown buffer is touched, so switching tabs while paused is what
   *  reveals it in the other file rather than two files carrying it at once. */
  function syncFrameLine() {
    if (!view || !shown) return;
    const at = props.frameLine;
    setFrameLineMarker(view, at && at.path === shown ? at.line : null);
  }

  /** Re-resolve every buffer's fallback completion in place, background buffers
   *  included. Called from both directions: the client moving decides whether a
   *  buffer is claimed, and the preference decides what the unclaimed ones get. */
  function syncFallbackCompletion() {
    reconfigureBuffers(buffers, (buf) => buf.completion, currentFallbackCompletion, (path, effects) =>
      dispatchToAuthority(path, effects),
    );
  }

  /** Turn code lenses on or off in every buffer, background ones included.
   *
   *  Through the compartments rather than through `prefsConf` beside them,
   *  which reaches only the buffer on screen: switching the setting off and
   *  then swapping to a tab that was in the background would otherwise show
   *  that tab still wearing the lenses it was built with. Reconfiguring away
   *  the extension takes the field and its decorations with it, so nothing has
   *  to be cleared. */
  function syncCodeLens() {
    reconfigureBuffers(buffers, (buf) => buf.codeLens, currentCodeLens, (path, effects) =>
      dispatchToAuthority(path, effects),
    );
    // Switching it on has nothing to draw until somebody asks: the field starts
    // empty, and without this the lenses would appear only at the next edit.
    refreshLenses();
  }

  // The language client moved: came up, went away, or was replaced by a project
  // switch. Every open buffer re-asks `lspPluginFor` what it should hold, so a
  // file opened before the server was ready attaches in place, and one left over
  // from the previous project drops a plugin that now points at a dead client.
  // The fallback completion goes the other way in the same breath: a buffer the
  // server has just claimed gives up its scraped words in favour of the
  // server's own list.
  function relinkLsp() {
    reattachLsp(buffers, lspPluginFor, dispatchToAuthority);
    syncFallbackCompletion();
    // The server that answers for this file just changed (came up, went away),
    // so what it would say about its symbols changed with it. This is also the
    // only thing that re-asks after a server finishes starting, which is the
    // state every file opened during startup is in.
    void refreshSymbols();
    // Same reasoning for colour: a file that opened before its server was up
    // has lexical highlighting only, and this is the moment that changes.
    refreshSemantic();
    // And for the lenses, which have the same "nothing at all until there is a
    // server" state and no local trigger that would end it.
    refreshLenses();
    // And the same for the whole-file commands: which of them the palette
    // should list is the server's answer, so it is unknown until there is one.
    publishSourceActions();
  }

  /**
   * Rebuild a buffer from unsaved work the last quit stashed.
   *
   * Two outcomes, and the difference is one argument to `fromJSON`. When the
   * file has not moved, the history field comes back with the document and the
   * buffer is exactly where it was left. When somebody rewrote the file while
   * the app was shut, the same JSON is read *without* that field, so the text
   * survives and only the history is dropped: it is a chain of positions into a
   * document that no longer exists. The editor's own conflict banner is then
   * raised over it, so the disk version is offered rather than silently lost.
   *
   * A stash that cannot be read at all falls back to the file. That is the loss
   * this feature exists to prevent, so it is the last resort rather than the
   * error path: refusing to open the buffer would lose the work *and* the tab.
   */
  function restoreStashed(
    path: string,
    stashed: StashEntry,
    disk: DiskText,
    extensions: Extension[],
    conf: BufferConf,
  ): Buffer {
    const moved = disk.text !== stashed.savedText;
    let state: EditorState;
    try {
      state = EditorState.fromJSON(
        stashed.state,
        { extensions },
        moved ? undefined : SERIALIZED_FIELDS,
      );
    } catch (e) {
      console.error("unreadable hot-exit stash, falling back to disk", path, e);
      return { state: EditorState.create({ doc: Text.of(disk.lines), extensions }), savedText: disk.text, ...conf };
    }
    return {
      state,
      // The baseline the buffer was dirty against, so it comes back dirty by
      // exactly the edits that were unsaved rather than against the new file.
      savedText: stashed.savedText,
      ...(moved ? { pendingExternal: disk.text, pendingKind: "changed" as const } : {}),
      ...conf,
    };
  }

  // The active file's symbol tree, published for the outline panel and the
  // palette's `@` mode to read. Only the active file: the store is what those
  // surfaces show, and neither of them can show a file that is not on screen.
  //
  // The ordering guard and the publish both live in `lspSymbols`; all this owns
  // is which file is being asked about and whether it is still open by the time
  // the answer arrives.
  async function refreshSymbols() {
    const path = shown;
    if (!path) return;
    await refreshDocumentSymbols(path, () => buffers.has(path));
  }

  // Long enough that a burst of typing asks once. The request syncs the
  // document itself, so this is only about how often the server is asked, not
  // about whether the answer is current.
  const refreshSymbolsSoon = debounce(() => void refreshSymbols(), 400);

  // What the Calls tab is rooted at: the symbol under the caret, in the file on
  // screen. Unlike the outline this follows the *selection*, because a call
  // hierarchy is about one symbol rather than about a file.
  //
  // The ordering guard and the publish both live in `lspCallHierarchy`; this
  // owns only which position is being asked about and whether the file is still
  // open by the time the answer lands. A server with no `callHierarchyProvider`
  // costs no request at all - the publish is `null` and the tab stays hidden.
  async function refreshCalls() {
    const path = shown;
    if (!path || !view) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    await rootCallHierarchy(
      path,
      // LSP counts lines from 0 and CodeMirror from 1.
      { line: line.number - 1, character: head - line.from },
      () => buffers.has(path),
    );
  }

  // Same 500 ms as the code-action refresh beside it, and for the same reason:
  // this one fires on arrow keys too, so a walk through a file must cost one
  // request rather than one per line.
  //
  // Gated on the panel being open, which is the difference between one request
  // per caret settle in every buffer and one only where the answer is on
  // screen. The tab still appears and disappears correctly without this
  // running at all: that comes from `noteCallSupport`, which reads a capability
  // the server already sent.
  const refreshCallsSoon = debounce(() => {
    if (props.callsVisible) void refreshCalls();
  }, 500);

  // What the bulb is drawn from: the caret's own line, because that is the only
  // line anything has been asked about. Asking per fixable line would be a
  // `textDocument/codeAction` per line, and tsserver answers one of those with
  // a compile.
  async function refreshCodeActionsHere() {
    const path = shown;
    if (!path || !view) return;
    const asked = caretRange(view);
    // No language client on this buffer, so there is nothing to ask and nothing
    // left over from a previous file to keep drawing.
    if (!asked) return clearCodeActions();
    await refreshCodeActions(path, asked, caretStillAt);
  }

  /** Whether an answer is still about where the caret is.
   *
   *  The file alone is not enough: a caret move re-asks only after the debounce,
   *  so between the move and that re-ask nothing would supersede a reply that is
   *  already about the wrong line, and the bulb would sit there describing it. */
  function caretStillAt(path: string, asked: LspRange): boolean {
    if (path !== shown || !view) return false;
    const now = caretRange(view);
    return !!now && sameRange(now, asked);
  }

  // Longer than the symbol refresh beside it: this one runs on caret movement
  // as well as typing, so it fires on arrow keys too, and a code action is the
  // more expensive question of the two.
  const refreshCodeActionsSoon = debounce(() => void refreshCodeActionsHere(), 500);

  // The offer changed, so the bulb does. Not inside the update listener that
  // asks for it: this arrives a server round trip later, and dispatching from
  // inside an update is the one thing CodeMirror refuses outright.
  const offCodeActions = onCodeActionsChange(() => {
    if (!view) return;
    const at = currentCodeActions();
    const mine = at && at.path === shown && at.actions?.length;
    // LSP counts lines from zero and CodeMirror from one.
    setCodeActionLine(view, mine ? at.range.start.line + 1 : null);
  });
  onCleanup(offCodeActions);

  /**
   * Answer the Problems panel's "what could be done about this?".
   *
   * Registered rather than imported: that panel is on the eager side of the
   * lazy editor boundary, so it cannot reach the LSP client itself without
   * putting CodeMirror in the startup chunk. Same shape as
   * `setWorkspaceSymbolSearch`.
   *
   * Deliberately not restricted to the file on screen. A problem in a
   * background tab is one of the main reasons to send one to an agent at all,
   * and `lspTargetFor` answers for any path a live session covers.
   */
  const offFixLookup = setDiagnosticFixLookup(async (path, problem) => {
    // A zero-width range at the diagnostic's own start. The store keeps no end
    // column, and a caret there is what a person asking "fix this" would put
    // the cursor on - `diagnosticsIn` counts a touching range as overlapping,
    // so the diagnostic itself still reaches the server as context.
    const at = { line: Math.max(problem.line - 1, 0), character: Math.max(problem.column - 1, 0) };
    // Quick fixes only, and asked for by kind rather than filtered afterwards.
    // A refactor is something the user might want; a fix is an answer to the
    // problem being sent, and the rest would pad the message with things that
    // have nothing to do with it. Asking is also the cheaper half of that: the
    // server skips computing what it is not going to be asked about.
    const actions = await requestCodeActions(path, { start: at, end: at }, ["quickfix"]);
    return (actions ?? [])
      // A backstop for a server that answers a filtered request with more than
      // it was asked for. A kindless action passes: under a quickfix-only
      // filter, that is what the server is saying it is.
      .filter((a) => !a.kind || a.kind === "quickfix" || a.kind.startsWith("quickfix."))
      .map((a) => a.title);
  });
  onCleanup(offFixLookup);

  /** Tell the palette which whole-file actions this file's server offers, so
   *  three commands nothing can answer never appear in a language that has
   *  none. Re-read on a tab swap and on every client lifecycle change, because
   *  both change the answer and neither is observable from the store. */
  function publishSourceActions() {
    const path = shown;
    const target = path ? lspTargetFor(path) : null;
    if (!target) return publishSourceActionKinds(null);
    void target.ready.then(() => {
      // Compared against the file this call was *started* for, not against
      // whatever is on screen now: `initialize` can take a cold rust-analyzer
      // a long time, and answering for the tab the user has since left would
      // put one language's commands in another language's palette.
      if (shown !== path) return;
      const provider = target.capability("codeActionProvider");
      if (!provider) return publishSourceActionKinds(null);
      // `true` is a server that does code actions without enumerating kinds,
      // which is "I have not told you" rather than "I have none".
      publishSourceActionKinds(
        provider === true ? [] : ((provider as { codeActionKinds?: string[] }).codeActionKinds ?? []),
      );
    });
  }

  /** Run one whole-file action by kind. Its own path rather than the menu's,
   *  because a source action is a claim about the file and there is no caret
   *  involved: the range asked about is the whole document. */
  async function runSourceAction(kind: string, label: string) {
    const path = shown;
    if (!path || !view) return;
    const action = await requestSourceAction(path, kind, wholeFileRange(view));
    // Swapped tabs while the server was answering. `applyCodeAction` reads the
    // client off the view, and the view is now showing somebody else's file -
    // in a monorepo that is a different server, whose workspace and mapping
    // would be the wrong ones to apply this file's edit through.
    if (path !== shown || !view) return;
    if (!action) {
      emitWith<ToastEvent>(TOAST, { message: `This server has no "${label}" action for this file.`, kind: "info" });
      return;
    }
    await applyCodeAction(view, path, action, codeActionIo);
  }

  // What the semantic-token refresh is allowed to know about this editor. The
  // decisions it feeds - superseded, moved, nothing to do - all live in
  // `lspSemanticTokens`, where they can be tested without a view; all this
  // supplies is the buffer and the dispatch.
  //
  // `id` is `state.doc`: `Text` is immutable, so its identity is the only handle
  // CodeMirror offers on "is this still the document I asked about?", and every
  // token in an answer is a position. The same guard format-on-save uses.
  const semanticDeps: SemanticDeps = {
    current: (path) =>
      authorityState(path)
        ? { id: authorityState(path)!.doc, painted: semanticTokenCount(authorityState(path)!) }
        : null,
    paint: (_path, tokens) => view?.dispatch({ effects: setSemanticTokens.of(tokens) }),
    again: () => refreshSemanticSoon(),
  };

  // Caught rather than left to float: an unhandled rejection here is invisible,
  // failing neither the suite nor the app, which Phase 2 learned the hard way.
  function refreshSemantic() {
    const path = shown;
    if (!path) return;
    refreshSemanticTokens(semanticDeps, path).catch((e) =>
      console.error("semantic tokens failed", path, e),
    );
  }

  const refreshSemanticSoon = debounce(refreshSemantic, 400);

  // The same arrangement for the lenses, and the same reason for injecting it:
  // which reply is still current, and whether the document moved under it, are
  // decisions that belong in `lspCodeLens` where they can be tested without a
  // view. All this supplies is the buffer and the dispatch.
  const codeLensDeps: CodeLensDeps = {
    current: (path) => (authorityState(path) ? { id: authorityState(path)!.doc } : null),
    paint: (_path, lenses) => view?.dispatch({ effects: setCodeLenses.of(lenses) }),
  };

  /** Ask for the shown file's lenses, unless the setting is off.
   *
   *  The gate is here rather than in `lspCodeLens` because it is the only thing
   *  standing between a default-off feature and a `textDocument/codeLens` for
   *  every file every user opens. Nothing else about the request is conditional:
   *  a server with no provider answers null and costs no round trip. */
  function refreshLenses() {
    const path = shown;
    if (!path || !editorDefaults().codeLens) return;
    refreshCodeLenses(codeLensDeps, path).catch((e) => console.error("code lens failed", path, e));
  }

  // 400 ms, the semantic refresh's interval rather than the code action's 500:
  // this fires on typing only, not on caret movement, so a walk through a file
  // costs nothing at all.
  const refreshLensesSoon = debounce(refreshLenses, 400);

  // A server saying its own counts are stale, which is the request
  // `workspace.codeLens.refreshSupport` invited. Almost always about a
  // *different* file than the one on screen: adding a call in `main.ts` changes
  // the number drawn above a function in `types.ts` without touching it.
  //
  // Root-filtered for `setSemanticRefreshListener`'s reason: in a monorepo,
  // `packages/a`'s server speaks only for the files it answers about.
  const offCodeLensRefresh = setCodeLensRefreshListener((root) => {
    if (shown && lspTargetFor(shown)?.root === root) refreshLensesSoon();
  });

  // A server saying its own answers are stale. The trigger is usually a
  // *different* file: semantic colour is a property of the resolved program, so
  // editing a type in one file changes what a name in this one means without
  // changing a character of it, and nothing observable here would ever prompt
  // the re-ask.
  //
  // Filtered by root because `workspace/semanticTokens/refresh` is one session
  // speaking for itself: in a monorepo, `packages/a`'s server going stale says
  // nothing about a file `packages/b`'s server answers for.
  const offSemanticRefresh = setSemanticRefreshListener((root) => {
    if (shown && lspTargetFor(shown)?.root === root) refreshSemanticSoon();
  });

  // The palette's `#` mode reaches the running servers through here, for the
  // same reason the language workspace reaches buffers through `liveBuffers`:
  // it is a sibling of the editor and must not import the module that owns the
  // clients. Registered in the component body so a palette opened during the
  // first swap already finds it.
  const offSymbolSearch = setWorkspaceSymbolSearch(requestWorkspaceSymbols);
  // The panel expands a level at a time and cannot hold a client of its own.
  const offCallFetcher = setCallFetcher(callFetcher);


  /** Open a file: read it, revive whatever was kept of it, and register the
   *  buffer. One caller at a time, through `building`. */
  async function buildBuffer(path: string): Promise<Buffer> {
    let raw: string;
    try {
      raw = await invoke<string>("fs_read_file", { path });
    } catch (e) {
      raw = `// failed to open ${path}\n// ${String(e)}`;
    }
    // The first open of a language awaits its pack's chunk import.
    const lang = await langForPath(path);
    const existing = buffers.get(path);
    if (existing) return existing;
    const disk = fromDisk(raw);
    const conf: BufferConf = {
      lsp: new Compartment(),
      completion: new Compartment(),
      eol: new Compartment(),
      codeLens: new Compartment(),
    };
    const extensions = bufferExtensions(path, disk, lang, conf);
    // A tab reopened onto an unchanged file comes back with its undo history,
    // cursor and folds. `disk.text` and not the raw bytes, so a CRLF file is
    // compared with what the buffer actually holds (see lineEndings.ts).
    const kept = reviveClosed(closedBuffers, path, disk.text);
    // Unsaved work the last quit stashed outranks both: the file on disk is by
    // definition not what the user was looking at.
    const stashed = takeStashEntry(path);
    // The baseline is `disk.text`, not the bytes: it is what `sliceDoc` will
    // answer for this buffer, and every dirty check compares against that.
    const buf: Buffer = stashed
      ? restoreStashed(path, stashed, disk, extensions, conf)
      : {
          state: kept
            ? EditorState.fromJSON(kept.json, { extensions }, SERIALIZED_FIELDS)
            : EditorState.create({ doc: Text.of(disk.lines), extensions }),
          savedText: disk.text,
          ...conf,
        };
    buffers.set(path, buf);
    // The baseline for the save guard, taken from the same open that produced
    // `savedText`. Out-of-root paths only; everything else has a watcher.
    void noteMtime(path);
    // First reading of a buffer nobody has typed in yet. Its text may differ
    // from the file already (a hot-exit stash, a reopened tab), so the preview
    // has to be told rather than left to read disk.
    publishText(path, buf.state.sliceDoc());
    // First open of this file: bring up the server for its language, at the
    // root the backend resolves for it. Fire-and-forget, because the plugin
    // arrives through `onLspChange` -> `relinkLsp`, the same path a file opened
    // before its server was ready already takes. Opening only `.ts` files
    // therefore never starts rust-analyzer.
    if (props.projectRoot) void ensureLspFor(path, props.projectRoot);
    return buf;
  }

  /**
   * Show `path` in one pane's view. The authority for a file builds (or takes
   * over) its buffer state; a second pane onto the same file gets a follower
   * state over the same document, which the sync listener keeps level.
   *
   * `force` rebuilds a view that already shows the path, which is how a view
   * changes role when the other one holding that file went away.
   */
  async function swapTo(paneId: string, path: string | null, force = false) {
    const rec = views.get(paneId);
    if (!rec) return;
    traceMark("cm:swap");
    const v = rec.view;
    const leaving = rec.path;
    if (!force && (leaving === path || (rec.pending !== undefined && rec.pending === path))) return;
    rec.pending = path;
    const focused = focusedId() === paneId || views.size === 1;
    const token = ++rec.swaps;
    // Whether the Calls tab exists for the file being swapped to. Free: it
    // reads a capability the server already sent at `initialize`. The roots
    // themselves are a request, and only happen while the panel is open.
    if (path) void noteCallSupport(path, () => buffers.has(path));
    // An action is an offer about a range in a document, and neither survives
    // the file leaving the screen. Dropped before the swap rather than after,
    // so nothing can pick from a menu describing the tab being left.
    if (focused) {
      setActionMenu(null);
      clearCodeActions();
    }
    // Stash the live state of the buffer being left, unless this view was only
    // following another pane's: then the authority already holds it.
    if (leaving && leaving !== path && !rec.follower) {
      const prev = buffers.get(leaving);
      if (prev) {
        prev.state = v.state;
        // The recorded snapshot, not a fresh one: this runs after the workspace
        // flip has hidden the view, and a hidden view has nothing to snapshot.
        prev.scrollSnap = rec.snap;
      }
    }
    if (!path) {
      rec.path = null;
      rec.pending = undefined;
      rec.follower = false;
      if (focused) {
        shown = null;
        afterShow(null);
      }
      fixRoles(leaving);
      return;
    }
    // Decided before the buffer is built, because it decides what is built: a
    // file already held by an earlier pane makes this view a follower of it.
    const follower = wouldFollow(paneId, path);
    // One build per file, shared: two panes opening the same file in the same
    // tick must end up with one buffer, or each would hold its own document.
    let buf = buffers.get(path);
    if (!buf) {
      let build = building.get(path);
      if (!build) {
        build = buildBuffer(path);
        building.set(path, build);
        void build.finally(() => building.delete(path));
      }
      buf = await build;
      if (token !== rec.swaps) return;
    }
    if (token !== rec.swaps) return;
    rec.pending = undefined;
    // The authority takes the buffer's own state, undo history and all; a
    // follower gets a second state over the same document, built without a
    // history of its own (see bufferExtensions).
    const authority = buf.state;
    traceMark("cm:setstate");
    v.setState(follower ? await followerState(path, authority) : authority);
    traceMark("cm:setstate-end");
    rec.path = path;
    rec.follower = follower;
    // `setState` puts the scroll back at the top whatever the selection says, so
    // a buffer restored with its cursor five hundred lines down would open
    // showing line one with the cursor off screen. Neither a stash nor a closed
    // tab carries a scroll offset (`toJSON` holds the document, the selection
    // and the named fields, and a pixel offset would not survive a font or pane
    // width change anyway), so the selection is the anchor worth returning to.
    //
    // Unless the preview left a position behind, which only happens on the way
    // back from it: then the file was being read rather than edited, and where
    // the reader was beats where the cursor was. Proportional by line, because
    // the two views share no units.
    const handedOff = takeHandOff(path, "source");
    const cursor = v.state.selection.main.head;
    const anchor =
      handedOff === undefined
        ? cursor
        : v.state.doc.line(lineAtFraction(handedOff, v.state.doc.lines)).from;
    // `center` rather than the default `nearest` for the cursor: `nearest`
    // scrolls the minimum to bring the line into view, which from a fresh
    // `setState` (scrolled to the top) means it lands hard against the bottom
    // edge with the whole file above it. The buffer is supposed to come back
    // looking like it was left, and a line pinned to the edge does not.
    // Unless this buffer remembers where the reader was, which a live one coming
    // back to a view does. Instead of the anchor and not after it: both are
    // applied in the same measure cycle, so dispatching both is a race.
    const snap = handedOff === undefined ? buf.scrollSnap : undefined;
    v.dispatch({
      effects:
        snap ??
        EditorView.scrollIntoView(anchor, handedOff === undefined ? { y: "center" } : { y: "start" }),
    });
    traceMark("cm:scrolled");
    // Landing on the cursor is itself a position, and saying so replaces
    // whatever this file's last scroll left pending. Otherwise a tab swap away
    // and back would leave the source at the cursor while the pending claim
    // still pointed at where the reader was before the swap, and the next
    // preview would open there.
    if (handedOff === undefined && isMarkdownPath(path)) {
      handOff(path, "source", fractionOfLine(v.state.doc.lineAt(cursor).number, v.state.doc.lines));
    }
    if (focused) {
      v.focus();
      view = v;
      shown = path;
    }
    props.onDirty(path, buf.state.sliceDoc() !== buf.savedText);
    // Where this buffer was left, for the trail above the editor. Reported here
    // rather than by `caretListener`, because a `setState` never reaches an
    // update listener: without this the trail would sit blank until the caret
    // moved, on every tab swap and on every first open.
    const at = v.state.doc.lineAt(cursor);
    if (focused) props.onCaretMove?.(path, at.number, cursor - at.from + 1);
    if (focused) afterShow(path);
    fixRoles(leaving);
    fixRoles(path);
    traceMark("cm:swapped");
  }

  /** A second view onto a file the authority owns: the same document, without
   *  a history or a language client of its own. */
  async function followerState(path: string, authority: EditorState): Promise<EditorState> {
    const buf = buffers.get(path);
    const disk = fromDisk(buf?.savedText ?? "");
    const lang = await langForPath(path);
    const conf: BufferConf = {
      lsp: new Compartment(),
      completion: new Compartment(),
      eol: new Compartment(),
      codeLens: new Compartment(),
    };
    return EditorState.create({
      doc: authority.doc,
      selection: authority.selection,
      extensions: bufferExtensions(path, disk, lang, conf, true),
    });
  }

  /** Everything that describes "the file on screen" for the focused pane: run
   *  after a swap and after focus moves, since both change that answer. */
  function afterShow(path: string | null) {
    const buf = path ? buffers.get(path) : undefined;
    // The breakpoints the pane holds for this file, laid onto the buffer now
    // showing it. Safe to re-seed on every swap because the field reports any
    // edit that moved one straight back, so the store is never behind the buffer.
    syncBreakpoints();
    syncFrameLine();
    // Surface a deferred conflict banner if this buffer changed on disk while
    // it was in the background.
    setConflict(
      buf?.pendingKind && path
        ? { path, external: buf.pendingExternal ?? "", kind: buf.pendingKind }
        : null,
    );
    refreshDiff();
    syncBlame();
    syncEditorPrefs();
    syncVim();
    applyGoto();
    void refreshSymbols();
    refreshSemantic();
    refreshLenses();
    publishSourceActions();
  }


  function evictClosed(openPaths: string[]) {
    const live = new Set(openPaths);
    for (const [key, buf] of buffers) {
      if (live.has(key)) continue;
      // Only a clean buffer is kept. Closing a dirty tab goes through a
      // "the edits in this tab will be lost" confirm (`Editor.tsx:614`), and
      // handing those edits back on reopen would make that promise a lie.
      // Stashing unsaved work across a *quit* is hot exit's job, not this one.
      if (buf.state.sliceDoc() === buf.savedText) {
        rememberClosed(closedBuffers, key, {
          savedText: buf.savedText,
          json: buf.state.toJSON(SERIALIZED_FIELDS),
        });
      }
      buffers.delete(key);
      // The tab is gone, so its diagnostics leave the Problems list with it,
      // even for a buffer being kept: the Problems panel lists open files, and
      // a closed one reappearing there would be a tab nobody can click. Its
      // symbols leave the outline the same way.
      dropDiagnostics(key);
      dropSymbols(key);
      dropCallRoots(key);
      // And the preview's copy of it, on the same rule and for the same
      // reason: the store is bounded by what is open, not by what has ever
      // been opened.
      dropLiveBuffer(key);
      // And the language workspace has to re-read it. Its snapshot is the text
      // this buffer last held, unsaved edits included, and closing the tab
      // discarded those - so without this the server goes on answering about a
      // document nobody has. Same call as an external change, which resolves it
      // through the buffer (now gone) to disk.
      //
      // After the eviction, not before: a *clean* buffer is kept in
      // `closedBuffers` but is no longer in `buffers`, so the workspace has to
      // resolve it to disk either way.
      notifyLspFileChanged(key);
    }
  }

  // Where the reader is in the shown file, for its preview to open at. Taken
  // off the scroller and not off the state: a line number stops being a
  // position on screen the moment anything wraps or folds.
  function noteSourceScroll(rec: PaneRec) {
    // Not while a move is settling: re-inserting a scroller zeroes it, and the
    // snapshot taken from that would name the top of the file rather than the
    // position being put back.
    if (!rec.moved) rec.snap = rec.view.scrollSnapshot();
    if (!rec.path || !isMarkdownPath(rec.path)) return;
    const el = rec.view.scrollDOM;
    const fraction = scrollFraction(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (fraction !== undefined) handOff(rec.path, "source", fraction);
  }

  /** Put a view back where the reader left it, through CodeMirror rather than by
   *  writing `scrollTop`: a pixel written behind its back came back one line low
   *  on every restore, measured, and poisoned the next snapshot with it. */
  function restoreScroll(rec: PaneRec) {
    if (rec.snap) rec.view.dispatch({ effects: rec.snap });
  }

  /** The view that owns a file: the first pane, in the order the shell hands
   *  them over, showing it. Every other view onto that file follows it, and
   *  every consumer read (save, dirty, hot exit, LSP) comes off this one. */
  function authorityRec(path: string): PaneRec | undefined {
    for (const id of paneIds()) {
      const rec = views.get(id);
      if (rec?.path === path) return rec;
    }
    return undefined;
  }
  const authorityView = (path: string): EditorView | undefined => authorityRec(path)?.view;
  const authorityState = (path: string): EditorState | undefined =>
    authorityView(path)?.state ?? buffers.get(path)?.state;
  /** Send a compartment reconfigure to the view that owns a file, and say
   *  whether there was one: a buffer no pane shows is updated in place instead. */
  function dispatchToAuthority(path: string, effects: StateEffect<unknown>): boolean {
    const owner = authorityView(path);
    if (!owner) return false;
    owner.dispatch({ effects });
    return true;
  }

  /** Run an authority-only command (undo, redo) from whichever view asked. */
  function runOnAuthority(path: string, cmd: (v: EditorView) => boolean): boolean {
    const rec = authorityRec(path);
    return rec ? cmd(rec.view) : false;
  }
  /** What a pane holds or is on its way to holding. Both halves matter while two
   *  panes open the same file at once: neither holds it yet, and the answer
   *  still has to be the same for both. */
  const claims = (rec: PaneRec, path: string) =>
    rec.path === path || (rec.pending !== undefined && rec.pending === path);

  /** Would this pane's view be a follower for `path`? Decided by pane order
   *  rather than by who finished reading first, so it does not depend on
   *  timing: the earliest pane claiming a file owns it. */
  const wouldFollow = (paneId: string, path: string) => {
    for (const id of paneIds()) {
      if (id === paneId) return false;
      const rec = views.get(id);
      if (rec && claims(rec, path)) return true;
    }
    return false;
  };

  // One read per file, however many panes ask at once: the second swap awaits
  // the first one's build instead of opening the file a second time.
  const building = new Map<string, Promise<Buffer>>();

  function attachView(paneId: string, el: HTMLElement) {
    // A parked view first: the pane that just went away and the one arriving
    // are the same editor under two ids.
    const rec = parked.pop();
    if (rec) {
      traceMark("cm:adopt");
      el.appendChild(rec.view.dom);
      rec.id = paneId;
      rec.moved = true;
      views.set(paneId, rec);
      // Re-inserting a scroller resets it. Once here and again when the pane is
      // revealed, since only the second one has a laid-out box behind it.
      restoreScroll(rec);
      if (focusedId() === paneId || !view) focusPane(paneId);
      void swapTo(paneId, pathOf(paneId));
      // Parking dropped this view out of `views`, so anything that had taken
      // its file over while it was gone has to be resolved again.
      fixRoles(rec.path);
      return;
    }
    traceMark("cm:attach");
    const v = new EditorView({
      parent: el,
      state: EditorState.create({ doc: "", extensions: commonExtensions() }),
    });
    const fresh: PaneRec = { id: paneId, view: v, path: null, follower: false, swaps: 0 };
    // Removed with the element itself: `view.destroy()` takes the scroller
    // down, and this listener with it. Closed over the record rather than the
    // pane id, which changes under it when another pane adopts this view.
    v.scrollDOM.addEventListener("scroll", () => noteSourceScroll(fresh), { passive: true });
    views.set(paneId, fresh);
    if (focusedId() === paneId || !view) focusPane(paneId);
    void swapTo(paneId, pathOf(paneId));
  }

  /** Roles are decided by which panes hold a file, so a view arriving at one or
   *  leaving it can change another view's role: the last follower on a file
   *  becomes its authority, and a view an earlier pane just took over from
   *  becomes a follower. Rebuilt from the buffer, which both agree on. */
  function fixRoles(path: string | null) {
    if (!path) return;
    for (const rec of views.values()) {
      if (rec.path === path && rec.follower !== wouldFollow(rec.id, path)) {
        void swapTo(rec.id, path, true);
      }
    }
  }

  function detachView(paneId: string) {
    const rec = views.get(paneId);
    if (!rec) return;
    traceMark("cm:detach");
    // Its live state is the buffer's, unless somebody else is already the
    // authority for that file; either way the map keeps what it held.
    if (rec.path && !rec.follower) {
      const buf = buffers.get(rec.path);
      if (buf) {
        buf.state = rec.view.state;
        buf.scrollSnap = rec.snap;
      }
    }
    views.delete(paneId);
    // Parked, not destroyed: the pane replacing this one adopts it in the same
    // flush. Nothing claimed by the time that flush ends is destroyed below.
    parked.push(rec);
    sweepParked();
    fixRoles(rec.path);
    if (view === rec.view) {
      const next = paneIds().map((id) => views.get(id)).find(Boolean);
      if (next) focusPane(next.id);
      else {
        view = undefined;
        shown = null;
      }
    }
  }

  /** Destroy whatever nobody adopted. A task rather than a microtask: the pane
   *  replacing this one renders once its column hands over a mount element, and
   *  that is a signal write away. Sweeping early only costs a rebuild. */
  function sweepParked() {
    if (sweeping) return;
    sweeping = true;
    setTimeout(() => {
      sweeping = false;
      while (parked.length) {
        const rec = parked.pop()!;
        rec.view.destroy();
        traceMark("cm:destroyed");
      }
    }, 0);
  }

  /** Point `view`/`shown` at a pane, and re-run everything that describes "the
   *  file on screen" for the new one. */
  function focusPane(paneId: string) {
    const rec = views.get(paneId);
    if (!rec) return;
    view = rec.view;
    shown = rec.path;
    afterShow(rec.path);
  }

  onMount(async () => {
    // Subscribed before the first await, and before the opening swap, because
    // the client can finish starting inside either. A fire that lands with no
    // subscriber leaves the buffer holding no plugin for good, which is the bug
    // this whole compartment exists to fix. One subscription for the component
    // rather than one per buffer: the client is one per project, and every open
    // buffer wants the same news about it.
    offLsp = onLspChange(relinkLsp);
    // Genuine external changes to any open buffer: reload (clean) or banner
    // (dirty). Sway's own saves are skipped via isSelfWrite. handleExternalChange
    // also resyncs the gutter for the active file.
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      if (e.payload.root && e.payload.root !== props.projectRoot) return;
      for (const p of e.payload.paths) {
        // Every path, not only the open ones: the language workspace holds
        // snapshots of files the user never opened, and a snapshot that keeps
        // describing the old text is worse than no snapshot at all. Not gated
        // on `isSelfWrite` - Sway only ever writes the file it is showing, and
        // that one is view-backed, which `fileChanged` ignores anyway.
        notifyLspFileChanged(p);
        if (buffers.has(p) && !isSelfWrite(p)) void handleExternalChange(p);
      }
    });
    // A chat session reporting its own writes, ~250ms before the watcher's
    // debounce would. Same handler and the same isSelfWrite check, so the two
    // routes cannot disagree; the watcher's echo re-runs it against a file that
    // by then matches what is already loaded, which is a no-op rather than a
    // second reload.
    offAgentWrites = onWith<AgentFilesWritten>(AGENT_FILES_WRITTEN, ({ paths }) => {
      for (const p of paths) agentWritten.add(p);
      flushAgentWrites();
    });
    // Re-measure when a pane is revealed: an editor that laid out while
    // display:none has a stale viewport until CodeMirror re-reads its geometry.
    //
    // Every pane's view and not the focused one: a split builds a view in the
    // pane that did not take focus, and a view that never measures never
    // renders - it keeps CM6's placeholder height. Measured at the split, that
    // view reported a scrollHeight of 33554432 (2^25) before this loop and a
    // real 4628 after it.
    offRefit = onEvent(REFIT_PANES, () => {
      for (const rec of views.values()) {
        rec.view.requestMeasure();
        // A reveal is the first moment a view adopted into a hidden pane has a
        // box to scroll inside, so it is also the first moment the position it
        // was moved away from can land.
        if (rec.moved) {
          rec.moved = false;
          restoreScroll(rec);
        }
      }
    });
  });

  // The palette's "Save file". It lands here rather than in Editor because the
  // buffer is here: `saveActive` writes what the view actually holds, which is
  // the same text Mod-s writes, rather than a copy something else was passing
  // around. The key binding is still CM6's own, and stays the only key: a
  // table-level Mod-s would fire while a terminal had focus.
  const offSave = onEvent(EDITOR_SAVE, () => void saveActive());

  /** Run a CM6 command the palette asked for, and hand focus back: the palette
   *  took it to be typed into, and a selection nobody can see moved is not a
   *  selection command. */
  function runSelectionCommand(cmd: StateCommand) {
    const v = view;
    if (!v) return;
    cmd({ state: v.state, dispatch: (tr) => v.dispatch(tr) });
    v.focus();
  }

  // The same four commands the keymap above carries, reached by name instead of
  // by chord. They land here rather than in Editor for save's reason: the
  // selection is the buffer's, and only this component holds it.
  const offSelection = [
    onEvent(EDITOR_EXPAND_SELECTION, () => runSelectionCommand(expandSelection)),
    onEvent(EDITOR_SHRINK_SELECTION, () => runSelectionCommand(shrinkSelection)),
    onEvent(EDITOR_JOIN_LINES, () => runSelectionCommand(joinLines)),
    onEvent(EDITOR_SPLIT_SELECTION, () => runSelectionCommand(splitSelectionIntoLines)),
  ];

  /**
   * Every buffer with unsaved edits, serialized for the stash.
   *
   * The shown buffer is read from the view rather than from its record: the
   * record is only refreshed on a swap, so mid-edit it is one buffer behind,
   * and a quit is exactly the moment that gap matters.
   */
  function dirtyStash(now: number): HotExitStore {
    const out: HotExitStore = {};
    for (const [path, buf] of buffers) {
      const state = authorityState(path) ?? buf.state;
      if (state.sliceDoc() === buf.savedText) continue;
      out[path] = { savedText: buf.savedText, state: state.toJSON(SERIALIZED_FIELDS), savedAt: now };
    }
    return out;
  }

  // The quit handshake. Answered here rather than in Editor.tsx for save's
  // reason: the buffers are this component's, and only it can serialize one.
  // Always answers, including with `false`, because the caller is a window
  // close waiting on it and silence would hold the app open until its timeout.
  const offStash = onWith<EditorStashDirty>(EDITOR_STASH_DIRTY, ({ requestId }) => {
    const answer = (ok: boolean) => emitWith<EditorStashResult>(EDITOR_STASH_RESULT, { requestId, ok });
    // The try wraps the *serializing* too, not only the write: building the
    // stash runs `toJSON` over every dirty buffer, and a throw there would
    // leave this handler dead and the quit waiting out its whole timeout with
    // no dialog and no window.
    try {
      void saveStash(stashToWrite(dirtyStash(Date.now()))).then(answer);
    } catch (e) {
      console.error("could not build the hot-exit stash", e);
      answer(false);
    }
  });
  // What a cross-file rename needs from the app: a question it cannot answer
  // itself, and somewhere to say what it did.
  const renameIo = {
    projectRoot: () => props.projectRoot,
    confirm: (opts: { title: string; message: string; confirmLabel: string }) =>
      props.confirm
        ? props.confirm(opts)
        : // No host to ask means no informed consent, so the safe answer is no.
          // The rename refuses rather than saving somebody's work for them.
          Promise.resolve(false),
    report: reportRename,
  };

  function reportRename(outcome: RenameOutcome, root: string | null) {
    const said = describeRename(outcome);
    if (!said) return; // a single-file rename is its own feedback, on screen
    // The undo is offered here because here is where the user learns that files
    // they were not looking at just changed, and a toast is the only place that
    // moment exists.
    const ts = outcome.kind === "applied" ? outcome.backstopTs : null;
    const written = outcome.kind === "applied" ? outcome.written : [];
    emitWith<ToastEvent>(TOAST, {
      ...said,
      action:
        ts !== null && root
          ? { label: "Undo", run: () => void revertRename(root, ts, written) }
          : undefined,
    });
  }

  async function revertRename(root: string, ts: number, written: string[]) {
    try {
      await invoke("backstop_restore_tree", { repoPath: root, ts });
      // The files went back on disk; the open buffers still hold the rename.
      // Routed through the external-change path so a clean buffer reloads in
      // place and a dirty one gets the banner rather than being overwritten.
      for (const p of written) if (buffers.has(p)) void handleExternalChange(p);
      emitWith<ToastEvent>(TOAST, { message: "Rename undone.", kind: "info" });
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: `Undo failed: ${String(e)}`, kind: "error" });
    }
  }

  /**
   * Format the active buffer now, without saving.
   *
   * The project's own formatter wins, and the language server's is what runs
   * only when there is none. A repo pins Biome or Prettier so that everyone's
   * output matches; tsserver's formatter agrees with neither, so preferring it
   * would mean the manual command and CI disagreed about the same file.
   */
  async function formatNow() {
    const path = shown;
    if (!path || !view) return;
    const outcome = await formatForSave(formatDeps, path, {
      text: view.state.sliceDoc(),
      id: view.state.doc,
    });
    if (outcome.kind === "gone") return;
    if (outcome.kind === "formatted") return applyFormatted(path, outcome.text);
    // Nothing to apply. Fall through to the server only when the project had no
    // formatter at all: a detected one that refused has already said why, and
    // reformatting with a different tool on top of that would be worse than
    // doing nothing.
    if (!outcome.formatter && view) formatDocument(view);
  }

  // What running a code action needs from the app: the same question the rename
  // asks about unsaved work, and somewhere to say what it did.
  const codeActionIo = {
    projectRoot: () => props.projectRoot,
    confirm: (opts: { title: string; message: string; confirmLabel: string }) =>
      // No host to ask means no informed consent, so the safe answer is no,
      // exactly as the rename decides it.
      props.confirm ? props.confirm(opts) : Promise.resolve(false),
    notify: (message: string, kind: "error" | "info") => emitWith<ToastEvent>(TOAST, { message, kind }),
  };

  /**
   * Ask what is on offer at the caret and put it on screen.
   *
   * Silence is the right answer for a file no server claims: ⌘⌥A in a `.txt`
   * tab should feel like the key does nothing, which is how F12 already
   * behaves. An *empty* list is different - the server looked and had nothing -
   * and saying so is what keeps a working server from looking broken.
   */
  async function openCodeActions() {
    const path = shown;
    if (!path || !view) return;
    const asked = caretRange(view);
    // No LSP plugin on this buffer: no client, so nothing to ask.
    if (!asked) return;

    await refreshCodeActions(path, asked, caretStillAt);
    const at = currentCodeActions();
    // Superseded while the server was answering, or about a file that is no
    // longer on screen. Compared by value rather than by identity: the caret
    // refresh below runs on a debounce and can ask the very same question at
    // the same moment, and whichever of the two the store ends up holding
    // answers this press. By identity, that coincidence would swallow the
    // keystroke and say nothing.
    if (!at || at.path !== shown || !sameRange(at.range, asked)) return;
    if (!at.actions) return;
    if (!at.actions.length) {
      emitWith<ToastEvent>(TOAST, { message: "No code actions here.", kind: "info" });
      return;
    }
    setActionMenu(menuAt(view, path, at.actions));
  }

  /** The menu, anchored on the caret rather than the mouse: this opens from a
   *  keystroke, and the caret is where the user is looking. */
  function menuAt(v: EditorView, path: string, actions: CodeAction[]): ActionMenu {
    const coords = v.coordsAtPos(v.state.selection.main.head);
    const items: MenuItem[] = [];
    for (const group of groupedCodeActions(actions)) {
      if (items.length) items.push({ separator: true });
      for (const action of group) {
        items.push({ label: action.title, onClick: () => void runAction(path, action) });
      }
    }
    // Null coords means the caret is scrolled out of the rendered viewport,
    // which a keystroke cannot cause but a stale selection can. The editor's
    // own top-left is a worse anchor than the caret and a better one than
    // nowhere.
    const box = v.dom.getBoundingClientRect();
    return { x: coords?.left ?? box.left, y: coords?.bottom ?? box.top, items };
  }

  async function runAction(path: string, action: CodeAction) {
    if (!view) return;
    await applyCodeAction(view, path, action, codeActionIo);
    // The document moved, so whatever the menu was built from describes a file
    // that no longer exists in that shape.
    clearCodeActions();
    view?.focus();
  }

  // The palette's and the sheet's language-server entries, run against whatever
  // the view is showing. Each is the same CM6 command the library's own key
  // binding fires, and each returns false (a no-op) when the active file has no
  // server, which is the state a `.txt` tab is permanently in.
  const offLspCommands = [
    onEvent(EDITOR_LSP_DEFINITION, () => void (view && jumpToDefinition(view))),
    onEvent(EDITOR_LSP_REFERENCES, () => void (view && findReferences(view))),
    onEvent(EDITOR_LSP_RENAME, () => void (view && swayRenameSymbol(view, renameIo))),
    onEvent(EDITOR_LSP_FORMAT, () => void formatNow()),
    onEvent(EDITOR_LSP_CODE_ACTION, () => void openCodeActions()),
    onWith<SourceAction>(EDITOR_LSP_SOURCE_ACTION, ({ kind, label }) => void runSourceAction(kind, label)),
    onEvent(EDITOR_PEEK_DEFINITION, () => peekFromCaret("definition")),
    onEvent(EDITOR_PEEK_REFERENCES, () => peekFromCaret("references")),
  ];

  // No listener for the vim-mode toggle: it is a setting rather than an editor
  // action, so it rides the generic `PREFS_TOGGLE` that every `Preferences: ...`
  // command emits, and App writes the layer in force. The reconfigure arrives
  // here through the `vimModeOn` effect either way, which is what it always did
  // - the old handler only supplied the flip.

  // Same reason as REFIT_PANES: geometry measured while display:none is stale.
  // The editor now stays mounted but hidden whenever the selected workspace has
  // no tabs open, so revealing it again is a case that did not exist when the
  // pane was simply unmounted.
  createEffect(
    on(
      () => paneIds().map((id) => hiddenOf(id)).join(","),
      () => {
        for (const rec of views.values()) rec.view.requestMeasure();
      },
      { defer: true },
    ),
  );
  // What each pane shows, and which one is being acted in. Both are props, and
  // both move a view rather than re-create one.
  createEffect(() => {
    for (const id of paneIds()) {
      const rec = views.get(id);
      const path = pathOf(id);
      if (rec && rec.path !== path) void swapTo(id, path);
    }
  });
  createEffect(
    on(
      () => focusedId(),
      (id) => focusPane(id),
      { defer: true },
    ),
  );
  // Opening the panel roots it at once; waiting for the next caret move would
  // show an empty panel over a caret that is already on a function.
  createEffect(
    on(
      () => props.callsVisible,
      (visible) => {
        if (visible) void refreshCalls();
      },
      { defer: true },
    ),
  );
  createEffect(on(() => props.openPaths, (paths) => evictClosed(paths), { defer: true }));
  // Toggling blame reconfigures the compartment, which takes the field, the
  // gutter and the inline widget with it in one go, so switching off leaves
  // nothing behind to clean up.
  createEffect(on(() => props.blame, () => syncBlame(), { defer: true }));
  // The pane's answer changed: a click toggled one, or a rename swept them.
  // `defer` because the swap already seeds the buffer it shows, and doing it
  // twice on open would be a dispatch nobody asked for.
  createEffect(on(() => props.breakpoints, () => syncBreakpoints(), { defer: true }));
  createEffect(on(() => props.frameLine, () => syncFrameLine(), { defer: true }));
  // Every editing-comfort key at once: `Object.values` reads all of them, so a
  // change to any one re-runs this without the list having to be repeated here
  // each time a phase adds a key. The per-tab override rides along, since the
  // palette can flip it without any setting moving.
  createEffect(
    on(
      () => [...Object.values(editorDefaults()), props.softWrap],
      () => syncEditorPrefs(),
      { defer: true },
    ),
  );
  // Its own effect rather than a line in the one above: this one reaches every
  // buffer's compartment, and doing that for a whitespace toggle would be work
  // for nothing.
  createEffect(
    on(() => editorDefaults().wordCompletion, () => syncFallbackCompletion(), { defer: true }),
  );
  // Its own effect for the same reason, and one more: switching this on is what
  // asks the server for the first time, so it has to be told apart from a
  // whitespace toggle rather than folded into the list above.
  createEffect(on(() => editorDefaults().codeLens, () => syncCodeLens(), { defer: true }));
  // Toggling vim from Settings takes effect where the caret already is, with
  // the file's text and undo history untouched: a compartment reconfigure, not
  // a rebuild.
  createEffect(on(vimModeOn, () => syncVim(), { defer: true }));
  // A commit or a checkout moved HEAD, so the blame that was read at the old one
  // no longer describes this file. Reading `head` alone (a memo, not the store
  // signal) keeps this off the path of every file save, which rewrites the
  // store's file list and nothing else this cares about. This buffer's own
  // member, not the one in front: a background member commits too.
  const head = createMemo(() => gitStateFor(props.projectRoot).head);

  // The chats in this worktree, by id and name. Both halves matter and neither
  // is a doc change, so nothing else would repaint on them: a new chat changes
  // whose turns the read covers, and a renamed one changes what the widget calls
  // the turn it is already showing. Keyed on those two fields rather than on the
  // list, whose status flips on every turn a chat starts or finishes.
  const chatNames = createMemo(() =>
    liveChats()
      .map((c) => `${c.sessionId} ${c.sessionName}`)
      .join(""),
  );
  createEffect(on(head, () => void refreshBlame(), { defer: true }));
  createEffect(on(chatNames, () => void refreshAgentLines(), { defer: true }));
  // Editor font size (base setting × global zoom) reaches .cm-content through the
  // --editor-font-size CSS var, but CM6 caches the char/line geometry it measured
  // at the old size. Re-measure when either input changes so the cursor, gutter
  // and scroll geometry reflow to the new font rather than lagging a frame.
  createEffect(
    on(
      () => [settings.typography.editorFontSize, zoom()],
      () => view?.requestMeasure(),
      { defer: true },
    ),
  );
  // Jump to line/col (nonce makes a repeated click on the same target retrigger).
  createEffect(
    on(
      () => props.goto,
      (g) => {
        if (!g) return;
        gotoReq = { path: g.path, line: g.line, col: g.col ?? 1 };
        applyGoto(); // applies now if shown; otherwise swapTo() applies it
      },
      { defer: true },
    ),
  );

  // Files rewritten under us by something the app did on purpose: a tree
  // revert, a backstop restore, a discard. All resolved through the same
  // external-change path the watcher would use, so the outcome never depends on
  // watcher timing, and an unsaved buffer gets Reload / Keep mine rather than
  // quietly writing the discarded content back on the next save.
  createEffect(
    on(
      () => props.reverted,
      (r) => {
        if (!r) return;
        for (const p of r.paths) if (buffers.has(p)) void handleExternalChange(p);
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    unlistenFs?.();
    offAgentWrites?.();
    offRefit?.();
    offLsp?.();
    offSave();
    offStash();
    for (const off of offSelection) off();
    for (const off of offLspCommands) off();
    offBufferAccess();
    offSymbolSearch();
    offCallFetcher();
    offSemanticRefresh();
    offCodeLensRefresh();
    // Nothing is shown any more, which is also what stops both debounces: their
    // timers are not cancellable, so a doc change 400 ms before teardown fires
    // after the clear below and would publish one entry straight back into a
    // store describing an editor that no longer exists. The semantic one bails
    // on the same check before it can touch a destroyed view.
    shown = null;
    // No editor means no client, so every tree in the store describes a server
    // that is gone. Same rule as `clearEditorState`.
    clearSymbols();
    clearCallRoots();
    clearCodeActions();
    // No editor, no server answering for anything, so the palette must stop
    // offering three commands with nothing behind them.
    publishSourceActionKinds(null);
    for (const rec of views.values()) rec.view.destroy();
    views.clear();
    // Nothing is going to adopt these now.
    for (const rec of parked) rec.view.destroy();
    parked.length = 0;
    view = undefined;
  });

  /** One pane's editor: the reload banner for the file it holds, and the
   *  element its view lives in for as long as the pane does. */
  function PaneEditor(p: { id: string }) {
    onCleanup(() => detachView(p.id));
    return (
      <div
        class={styles.codeEditorWrap}
        classList={{ [styles.debugging]: debugRunning() }}
        style={{ display: hiddenOf(p.id) ? "none" : undefined }}
      >
        <Show when={conflict()?.path === pathOf(p.id) ? conflict() : null}>
          {(c) => (
            <div class={styles.reloadBanner}>
              <Show
                when={c().kind === "deleted"}
                fallback={<span>This file changed on disk while you had unsaved edits.</span>}
              >
                <span>This file was deleted on disk, so saving would bring it back.</span>
              </Show>
              <Button size="sm" onClick={reloadConflict}>{c().kind === "deleted" ? "Close file" : "Reload"}</Button>
              <Button size="sm" onClick={keepMine}>Keep mine</Button>
            </div>
          )}
        </Show>
        <div class={styles.codeEditor} ref={(el) => attachView(p.id, el)} />
      </div>
    );
  }

  return (
    <>
      {/* One view per pane, each in the element that pane handed over; the solo
          form keeps its view here, where it always was. */}
      <For each={paneIds()}>
        {(id) => (
          <Show when={props.paneIds ? props.paneHost?.(id) : undefined} fallback={<PaneEditor id={id} />}>
            {(mount) => (
              <Portal mount={mount()}>
                <PaneEditor id={id} />
              </Portal>
            )}
          </Show>
        )}
      </For>
      <Show when={actionMenu()}>
        {(m) => (
          <Dropdown
            anchor={{ x: m().x, y: m().y }}
            open
            items={m().items}
            onOpenChange={(open) => {
              if (open) return;
              setActionMenu(null);
              // Closing without picking should leave the caret where it was and
              // the focus where it came from. The wrapper restores focus to
              // whatever held it at open, which in anchor mode is the CM6 view,
              // so this is the belt to that braces: a pick moves the document
              // first and the restore would land on a node that has been redrawn.
              view?.focus();
            }}
          />
        )}
      </Show>
    </>
  );
}
