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
import { markSelfWrite, isSelfWrite } from "../selfWrites";
import { diffGutterExtension, setDiffMarkers, type Hunk } from "../diffGutter";

function relTo(root: string, abs: string): string {
  return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
}

// Syntax colors read live from the --syn-* CSS vars set by theme.ts (which
// distills them from the active VS Code theme's tokenColors). Because the values
// are var() references, re-theming on THEME_APPLIED is automatic: theme.ts
// rewrites the vars and the browser re-resolves them on the next paint, so the
// editor never needs to reconfigure for a theme change.
const swayHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: "var(--syn-variable)" },
]);

const swayTheme = EditorView.theme(
  {
    "&": { backgroundColor: "var(--bg)", color: "var(--text)", height: "100%" },
    ".cm-content": {
      caretColor: "var(--text)",
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: "13px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--sel)",
    },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--text-dim)", border: "none" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
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

type Buffer = { state: EditorState; savedText: string; pendingExternal?: string };
type Conflict = { path: string; external: string };

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
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let unlistenFs: UnlistenFn | undefined;
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
      if (path === shown) setConflict({ path, external: text });
    }
  }

  function reloadConflict() {
    const c = conflict();
    const buf = c && buffers.get(c.path);
    if (!c || !buf) return setConflict(null);
    buf.savedText = c.external;
    setBufferText(c.path, c.external);
    delete buf.pendingExternal;
    props.onDirty(c.path, false);
    if (c.path === shown) refreshDiff();
    setConflict(null);
  }

  function keepMine() {
    const c = conflict();
    const buf = c && buffers.get(c.path);
    if (buf) delete buf.pendingExternal;
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
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
  ];

  function makeState(path: string, text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        ...commonExtensions,
        langForPath(path),
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
    setConflict(buf.pendingExternal ? { path, external: buf.pendingExternal } : null);
    refreshDiff();
    applyGoto();
  }

  function evictClosed(openPaths: string[]) {
    const live = new Set(openPaths);
    for (const key of buffers.keys()) {
      if (!live.has(key)) buffers.delete(key);
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

  onCleanup(() => {
    unlistenFs?.();
    view?.destroy();
  });

  return (
    <div class="code-editor-wrap">
      <Show when={conflict()}>
        <div class="reload-banner">
          <span>This file changed on disk while you had unsaved edits.</span>
          <button onClick={reloadConflict}>Reload</button>
          <button onClick={keepMine}>Keep mine</button>
        </div>
      </Show>
      <div class="code-editor" ref={host} />
    </div>
  );
}
