import { onCleanup, onMount, createEffect, on, createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markSelfWrite, isSelfWrite } from "../../utils/selfWrites";
import { diffGutterExtension, setDiffMarkers, type Hunk } from "./diffGutter";
import { lspPluginFor } from "./lspClient";
import { lintGutter, setDiagnosticsEffect } from "@codemirror/lint";
import { publishDiagnostics, dropDiagnostics, problemsFromState } from "../../utils/diagnostics";
import { requestSend, composeSelectionMention, type SessionTarget } from "../../utils/safeSend";
import { findAgent } from "../../utils/agents";
import { on as onEvent, emitWith, REFIT_PANES, TOAST, type ToastEvent } from "../../utils/events";
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

function langForPath(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
  if (ext === "tsx") return javascript({ typescript: true, jsx: true });
  if (["js", "mjs", "cjs"].includes(ext)) return javascript();
  if (ext === "jsx") return javascript({ jsx: true });
  if (ext === "json") return json();
  return [];
}

// `pendingKind` (not a truthy `pendingExternal`) is what marks a deferred
// conflict: a deleted file's stashed text is the empty string, which would
// read as "no conflict" and silently drop the banner on tab activation.
type Buffer = { state: EditorState; savedText: string; pendingExternal?: string; pendingKind?: ConflictKind };
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
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let unlistenFs: UnlistenFn | undefined;
  let offRefit: (() => void) | undefined;
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
      if (path === shown) refreshDiff();
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
    await requestSend({ ...t, text: mention });
    return true;
  }

  const commonExtensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    foldGutter(),
    highlightSelectionMatches(),
    diffGutterExtension(),
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
  ];

  // Mirror a buffer's lint state into the Problems store. Only files with a
  // live buffer ever reach here, which is what keeps a monorepo's server-wide
  // publishes from accumulating: the store never learns about a file the user
  // has not opened.
  function publishFrom(path: string, state: EditorState) {
    publishDiagnostics(path, problemsFromState(state));
  }

  function makeState(path: string, text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        ...commonExtensions,
        langForPath(path),
        lspPluginFor(path),
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
      // A newer swap superseded us while reading: drop this result.
      if (token !== swapToken) return;
      buf = { state: makeState(path, text), savedText: text };
      buffers.set(path, buf);
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
    applyGoto();
  }

  function evictClosed(openPaths: string[]) {
    const live = new Set(openPaths);
    for (const key of buffers.keys()) {
      if (!live.has(key)) {
        buffers.delete(key);
        // The tab is gone, so its diagnostics leave the Problems list with it.
        dropDiagnostics(key);
      }
    }
  }

  onMount(async () => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "", extensions: commonExtensions }),
    });
    if (props.activePath) swapTo(props.activePath);
    // Genuine external changes to any open buffer: reload (clean) or banner
    // (dirty). Sway's own saves are skipped via isSelfWrite. handleExternalChange
    // also resyncs the gutter for the active file.
    unlistenFs = await listen<{ paths: string[] }>("fs://changed", (e) => {
      for (const p of e.payload.paths) {
        if (buffers.has(p) && !isSelfWrite(p)) void handleExternalChange(p);
      }
    });
    // Re-measure when a pane is revealed: an editor that laid out while
    // display:none has a stale viewport until CodeMirror re-reads its geometry.
    offRefit = onEvent(REFIT_PANES, () => view?.requestMeasure());
  });

  createEffect(on(() => props.activePath, (p) => swapTo(p), { defer: true }));
  createEffect(on(() => props.openPaths, (paths) => evictClosed(paths), { defer: true }));
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

  // A tree revert's files, resolved through the same external-change path the
  // watcher would use, so the outcome never depends on watcher timing.
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
    offRefit?.();
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
