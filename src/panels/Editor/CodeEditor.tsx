import { onCleanup, onMount, createEffect, createMemo, on, createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from "@codemirror/view";
import { EditorState, Compartment, Prec, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, StreamLanguage } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { debounce } from "../../utils/debounce";
import { markSelfWrite, isSelfWrite } from "../../utils/selfWrites";
import { diffGutterExtension, setDiffMarkers, type Hunk } from "./diffGutter";
import { blameExtension, setAgentMarkers, setBlameMarkers, type TurnLink } from "./blameGutter";
import { blameFor, canPlaceBlame, dropBlame, emptyBlame } from "../../utils/blame";
import { agentLinesFor, dropAgentLines, emptyAgentLines } from "../../utils/agentLines";
import { chatsInFolder, liveChats } from "../../utils/chatSessions";
import { gitState } from "../../utils/gitActions";
import { ensureLspFor, lspPluginFor, notifyLspFileChanged, onLspChange } from "./lspClient";
import { setBufferAccess } from "./liveBuffers";
import { cmdClickDefinitionExtension } from "./lspCommands";
import { swayRenameSymbol } from "./lspRenameCommand";
import { describeRename, type RenameOutcome } from "./lspRename";
import { reattachLsp } from "./lspReattach";
import { formatDocument, jumpToDefinition, findReferences } from "@codemirror/lsp-client";
import { lintGutter, setDiagnosticsEffect } from "@codemirror/lint";
import { publishDiagnostics, dropDiagnostics } from "../../utils/diagnostics";
import { problemsFromState } from "./problemsFromState";
import { requestSend, composeSelectionMention, type SessionTarget } from "../../utils/safeSend";
import { selectionBlocks } from "../../utils/chatCompose";
import { findAgent } from "../../utils/agents";
import { settings, zoom } from "../Settings/settingsStore";
import {
  on as onEvent,
  onWith,
  emitWith,
  AGENT_FILES_WRITTEN,
  AGENT_WRITE_DEBOUNCE_MS,
  REFIT_PANES,
  EDITOR_SAVE,
  EDITOR_LSP_DEFINITION,
  EDITOR_LSP_REFERENCES,
  EDITOR_LSP_RENAME,
  EDITOR_LSP_FORMAT,
  REVEAL_TURN,
  TOAST,
  type AgentFilesWritten,
  type RevealTurn,
  type ToastEvent,
  type FsChanged,
} from "../../utils/events";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import Button from "../../components/Button/Button";
import styles from "./CodeEditor.module.css";

function relTo(root: string, abs: string): string {
  return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
}

// Syntax colors read live from the --syn-* CSS vars set by the theme module
// (src/theme, which derives them from the active palette). Because
// the values are var() references, re-theming on THEME_APPLIED is automatic: the
// theme module rewrites the vars and the browser re-resolves them on the next
// paint, so the editor never needs to reconfigure for a theme change.
// Ordered least to most specific: CodeMirror applies every matching rule, so a
// later rule wins for a tag both cover. `t.function(t.propertyName)` must
// therefore come after `t.propertyName`, or every method reads as a property.
const swayHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: "var(--syntax-keyword)" },
  { tag: [t.controlKeyword, t.operatorKeyword], color: "var(--syntax-control)" },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator], color: "var(--syntax-operator)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syntax-string)" },
  { tag: [t.escape, t.character], color: "var(--syntax-escape)" },
  { tag: [t.regexp], color: "var(--syntax-regexp)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float], color: "var(--syntax-number)" },
  { tag: [t.bool, t.null, t.constant(t.variableName), t.standard(t.variableName)], color: "var(--syntax-constant)" },
  { tag: [t.typeName, t.standard(t.typeName)], color: "var(--syntax-type)" },
  { tag: [t.className], color: "var(--syntax-class)" },
  { tag: [t.namespace], color: "var(--syntax-namespace)" },
  { tag: [t.variableName], color: "var(--syntax-variable)" },
  // The closest lexical proxy for a parameter that a grammar alone can offer.
  // Real parameter detection needs LSP semantic tokens, which are out of scope
  // for this ticket; when they land this rule is what they replace.
  { tag: [t.local(t.variableName)], color: "var(--syntax-parameter)" },
  { tag: [t.propertyName], color: "var(--syntax-property)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syntax-tag)" },
  { tag: [t.attributeName], color: "var(--syntax-attribute)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket], color: "var(--syntax-punctuation)" },
  // Most specific last: these are refinements of tags matched above.
  { tag: [t.function(t.variableName)], color: "var(--syntax-function)" },
  { tag: [t.function(t.propertyName)], color: "var(--syntax-method)" },
  { tag: [t.function(t.definition(t.variableName))], color: "var(--syntax-function)" },
]);

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

// Packs beyond ts/js/json load on demand so the (already lazy) editor chunk
// stays lean; the module cache makes every open after the first free. The
// suffix comes from the basename so a dotted directory can't fake one, and
// dotfiles like .zshrc resolve to their own name.
async function langForPath(path: string): Promise<Extension> {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = file.split(".").pop() ?? "";
  if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
  if (ext === "tsx") return javascript({ typescript: true, jsx: true });
  if (["js", "mjs", "cjs"].includes(ext)) return javascript();
  if (ext === "jsx") return javascript({ jsx: true });
  if (ext === "json") return json();
  if (["md", "markdown"].includes(ext)) return (await import("@codemirror/lang-markdown")).markdown();
  if (ext === "css") return (await import("@codemirror/lang-css")).css();
  if (["html", "htm"].includes(ext)) return (await import("@codemirror/lang-html")).html();
  if (ext === "rs") return (await import("@codemirror/lang-rust")).rust();
  if (ext === "py") return (await import("@codemirror/lang-python")).python();
  if (["yaml", "yml"].includes(ext)) return (await import("@codemirror/lang-yaml")).yaml();
  if (ext === "toml") return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
  if (["sh", "bash", "zsh", "zshrc", "bashrc"].includes(ext)) return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
  return [];
}

// `pendingKind` (not a truthy `pendingExternal`) is what marks a deferred
// conflict: a deleted file's stashed text is the empty string, which would
// read as "no conflict" and silently drop the banner on tab activation.
// `lsp` is this buffer's own compartment holding the LSP plugin (or nothing).
// It has to be per buffer, not shared: `client.plugin(uri)` is file-addressed,
// so one compartment across buffers would hand every file the same file's
// plugin. Reconfiguring it is what lets a file opened before the server was
// ready pick LSP up in place, instead of needing a close and reopen.
type Buffer = {
  state: EditorState;
  savedText: string;
  lsp: Compartment;
  pendingExternal?: string;
  pendingKind?: ConflictKind;
};
// "changed": the file still exists but its contents moved under unsaved edits.
// "deleted": the file is gone from disk (a checkpoint tree revert removes the
// files a later checkpoint had added). The deleted case raises the banner even
// for a clean buffer, because a clean buffer can still be saved, and that save
// would silently recreate the file and undo the revert.
type ConflictKind = "changed" | "deleted";
type Conflict = { path: string; external: string; kind: ConflictKind };

/** Multi-buffer CM6 editor: one EditorView, one EditorState per open file (so
 *  cursor, selection and undo history are preserved per tab). The active file is
 *  `props.activePath`; `props.openPaths` is the live tab set used to evict the
 *  state of closed tabs. Dirty transitions are pushed up via `props.onDirty`. */
export default function CodeEditor(props: {
  activePath: string | null;
  openPaths: string[];
  projectRoot: string | null;
  goto: { path: string; line: number; col?: number; nonce: number } | null;
  onDirty: (path: string, dirty: boolean) => void;
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
  // CSS-hidden (not unmounted) while an image/markdown-preview overlay is
  // showing for the active tab, so background buffers/undo history survive
  // the swap the same way TerminalView keeps inactive PTYs alive.
  hidden?: boolean;
  // Show git blame: an age-shaded gutter stripe, and the commit behind the
  // cursor's line beside it. Held in a compartment rather than gated inside the
  // extension, so switching it off takes the whole column with it instead of
  // leaving an empty one.
  blame?: boolean;
  // The host's in-app confirm (WKWebView has no `window.confirm`). Used by the
  // cross-file rename, which has to ask before saving a background tab's
  // unsaved work. Absent means the rename refuses rather than deciding for the
  // user.
  confirm?: (opts: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
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
  let swapToken = 0;
  // The active buffer has an external on-disk change conflicting with unsaved
  // edits (drives the reload banner).
  const [conflict, setConflict] = createSignal<Conflict | null>(null);

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

  function docOf(path: string): string | null {
    if (path === shown && view) return view.state.doc.toString();
    return buffers.get(path)?.state.doc.toString() ?? null;
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
    adopt: (path, text) => {
      const buf = buffers.get(path);
      if (!buf) return;
      setBufferText(path, text);
      buf.savedText = text;
      props.onDirty(path, false);
      if (path === shown) refreshDiff();
    },
  });

  // Replace a buffer's whole document with `text`, in the live view if it's the
  // active buffer, otherwise in its stored state.
  function setBufferText(path: string, text: string) {
    const buf = buffers.get(path);
    if (!buf) return;
    if (path === shown && view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    } else {
      buf.state = buf.state.update({
        changes: { from: 0, to: buf.state.doc.length, insert: text },
      }).state;
    }
  }

  // An open file changed on disk (already filtered to genuine external edits).
  // Clean buffer: reload in place. Dirty buffer: stash the disk version and
  // raise a conflict banner (now if active, on activation otherwise).
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
    let text: string;
    try {
      text = await invoke<string>("fs_read_file", { path });
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
    const buf = buffers.get(path);
    if (!buf) return; // closed while reading
    const current = docOf(path);
    if (current === null || text === current) {
      buf.savedText = text;
      if (path === shown) refreshDiff();
      return;
    }
    const dirty = current !== buf.savedText;
    if (!dirty) {
      buf.savedText = text; // set baseline first so the dirty listener stays clean
      setBufferText(path, text);
      props.onDirty(path, false);
      if (path === shown) {
        refreshDiff();
        // The buffer just adopted a different file, so its markers describe
        // lines that are no longer there. Clean again, so a rebuild is safe.
        void refreshBlame();
        void refreshAgentLines();
      }
    } else {
      buf.pendingExternal = text;
      buf.pendingKind = "changed";
      if (path === shown) setConflict({ path, external: text, kind: "changed" });
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
      buf.savedText = buf.state.doc.toString(); // clean, so the close carries no discard prompt
      props.onDirty(c.path, false);
      setConflict(null);
      props.onCloseFile?.(c.path);
      return;
    }
    buf.savedText = c.external;
    setBufferText(c.path, c.external);
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
    const head = gitState().root === root ? (gitState().head ?? "") : "";
    const blame = head ? await blameFor(root, relTo(root, path), head) : emptyBlame();
    if (!view || shown !== path || !props.blame) return;
    if (!canPlaceBlame(view.state.doc.toString(), buffers.get(path)?.savedText)) return;
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
    if (!canPlaceBlame(view.state.doc.toString(), buffers.get(path)?.savedText)) return;
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

  async function saveActive() {
    const path = shown;
    if (!path || !view) return;
    const text = view.state.doc.toString();
    try {
      await invoke("fs_write_file", { path, contents: text });
      markSelfWrite(path);
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
    if (findAgent(sel.agent ?? "claude").resume_args.length === 0) return "This agent's sessions can't be resumed";
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

  const commonExtensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
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
    highlightSpecialChars(),
    foldGutter(),
    highlightSelectionMatches(),
    diffGutterExtension(),
    blameConf.of([]),
    syntaxHighlighting(swayHighlight),
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
      // Before defaultKeymap so pair-aware Backspace wins over plain delete.
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    // Severity markers beside the line numbers. lsp-client's serverDiagnostics
    // already self-installs the lint state field when it publishes, but the
    // gutter is a separate extension and has to be asked for.
    lintGutter(),
    // Falls through to an ordinary click for a file with no server, so it costs
    // nothing in a buffer the LSP knows nothing about.
    cmdClickDefinitionExtension,
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

  function makeState(path: string, text: string, lang: Extension, lsp: Compartment): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        ...commonExtensions,
        lang,
        lsp.of(lspPluginFor(path)),
        EditorView.updateListener.of((u) => {
          // Diagnostics arrive as a transaction effect from the LSP client, so
          // republish only when one actually lands rather than on every keypress.
          if (u.transactions.some((t) => t.effects.some((e) => e.is(setDiagnosticsEffect)))) {
            publishFrom(path, u.state);
          }
        }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const buf = buffers.get(path);
          if (buf) props.onDirty(path, u.state.doc.toString() !== buf.savedText);
        }),
      ],
    });
  }

  // The language client moved: came up, went away, or was replaced by a project
  // switch. Every open buffer re-asks `lspPluginFor` what it should hold, so a
  // file opened before the server was ready attaches in place, and one left over
  // from the previous project drops a plugin that now points at a dead client.
  function relinkLsp() {
    reattachLsp(buffers, shown, lspPluginFor, (effects) => view?.dispatch({ effects }));
  }

  async function swapTo(path: string | null) {
    if (!view) return;
    const token = ++swapToken;
    // Stash the live state of the buffer we're leaving.
    if (shown && shown !== path) {
      const prev = buffers.get(shown);
      if (prev) prev.state = view.state;
    }
    if (!path) {
      shown = null;
      return;
    }
    let buf = buffers.get(path);
    if (!buf) {
      let text: string;
      try {
        text = await invoke<string>("fs_read_file", { path });
      } catch (e) {
        text = `// failed to open ${path}\n// ${String(e)}`;
      }
      // The first open of a language awaits its pack's chunk import; the
      // token check below covers this await too.
      const lang = await langForPath(path);
      // A newer swap superseded us while reading: drop this result.
      if (token !== swapToken) return;
      const lsp = new Compartment();
      buf = { state: makeState(path, text, lang, lsp), savedText: text, lsp };
      buffers.set(path, buf);
      // First open of this file: bring up the server for its language, at the
      // root the backend resolves for it. Fire-and-forget, because the plugin
      // arrives through `onLspChange` -> `relinkLsp`, the same path a file
      // opened before its server was ready already takes. Opening only `.ts`
      // files therefore never starts rust-analyzer.
      if (props.projectRoot) void ensureLspFor(path, props.projectRoot);
    }
    if (token !== swapToken) return;
    view.setState(buf.state);
    view.focus();
    shown = path;
    props.onDirty(path, buf.state.doc.toString() !== buf.savedText);
    // Surface a deferred conflict banner if this buffer changed on disk while
    // it was in the background.
    setConflict(buf.pendingKind ? { path, external: buf.pendingExternal ?? "", kind: buf.pendingKind } : null);
    refreshDiff();
    syncBlame();
    applyGoto();
  }

  function evictClosed(openPaths: string[]) {
    const live = new Set(openPaths);
    for (const key of buffers.keys()) {
      if (!live.has(key)) {
        buffers.delete(key);
        // The tab is gone, so its diagnostics leave the Problems list with it.
        dropDiagnostics(key);
        // And the language workspace has to re-read it. Its snapshot is the
        // text this buffer last held, unsaved edits included, and closing the
        // tab discarded those - so without this the server goes on answering
        // about a document nobody has. Same call as an external change, which
        // resolves it through the buffer (now gone) to disk.
        notifyLspFileChanged(key);
      }
    }
  }

  onMount(async () => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "", extensions: commonExtensions }),
    });
    // Subscribed before the first await, and before the opening swap, because
    // the client can finish starting inside either. A fire that lands with no
    // subscriber leaves the buffer holding no plugin for good, which is the bug
    // this whole compartment exists to fix. One subscription for the component
    // rather than one per buffer: the client is one per project, and every open
    // buffer wants the same news about it.
    offLsp = onLspChange(relinkLsp);
    if (props.activePath) swapTo(props.activePath);
    // Genuine external changes to any open buffer: reload (clean) or banner
    // (dirty). Sway's own saves are skipped via isSelfWrite. handleExternalChange
    // also resyncs the gutter for the active file.
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
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
    offRefit = onEvent(REFIT_PANES, () => view?.requestMeasure());
  });

  // The palette's "Save file". It lands here rather than in Editor because the
  // buffer is here: `saveActive` writes what the view actually holds, which is
  // the same text Mod-s writes, rather than a copy something else was passing
  // around. The key binding is still CM6's own, and stays the only key: a
  // table-level Mod-s would fire while a terminal had focus.
  const offSave = onEvent(EDITOR_SAVE, () => void saveActive());

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

  // The palette's and the sheet's language-server entries, run against whatever
  // the view is showing. Each is the same CM6 command the library's own key
  // binding fires, and each returns false (a no-op) when the active file has no
  // server, which is the state a `.txt` tab is permanently in.
  const offLspCommands = [
    onEvent(EDITOR_LSP_DEFINITION, () => void (view && jumpToDefinition(view))),
    onEvent(EDITOR_LSP_REFERENCES, () => void (view && findReferences(view))),
    onEvent(EDITOR_LSP_RENAME, () => void (view && swayRenameSymbol(view, renameIo))),
    onEvent(EDITOR_LSP_FORMAT, () => void (view && formatDocument(view))),
  ];

  // Same reason as REFIT_PANES: geometry measured while display:none is stale.
  // The editor now stays mounted but hidden whenever the selected workspace has
  // no tabs open, so revealing it again is a case that did not exist when the
  // pane was simply unmounted.
  createEffect(
    on(
      () => props.hidden,
      (h) => {
        if (!h) view?.requestMeasure();
      },
      { defer: true },
    ),
  );
  createEffect(on(() => props.activePath, (p) => swapTo(p), { defer: true }));
  createEffect(on(() => props.openPaths, (paths) => evictClosed(paths), { defer: true }));
  // Toggling blame reconfigures the compartment, which takes the field, the
  // gutter and the inline widget with it in one go, so switching off leaves
  // nothing behind to clean up.
  createEffect(on(() => props.blame, () => syncBlame(), { defer: true }));
  // A commit or a checkout moved HEAD, so the blame that was read at the old one
  // no longer describes this file. Reading `head` alone (a memo, not the store
  // signal) keeps this off the path of every file save, which rewrites the
  // store's file list and nothing else this cares about.
  const head = createMemo(() => gitState().head);

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
    for (const off of offLspCommands) off();
    offBufferAccess();
    view?.destroy();
  });

  return (
    <div class={styles.codeEditorWrap} style={{ display: props.hidden ? "none" : undefined }}>
      <Show when={conflict()}>
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
      <div class={styles.codeEditor} ref={host} />
    </div>
  );
}
