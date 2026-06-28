import { onCleanup, onMount, createEffect, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markSelfWrite } from "../selfWrites";

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

type Buffer = { state: EditorState; savedText: string };

/** Multi-buffer CM6 editor: one EditorView, one EditorState per open file (so
 *  cursor, selection and undo history are preserved per tab). The active file is
 *  `props.activePath`; `props.openPaths` is the live tab set used to evict the
 *  state of closed tabs. Dirty transitions are pushed up via `props.onDirty`. */
export default function CodeEditor(props: {
  activePath: string | null;
  openPaths: string[];
  onDirty: (path: string, dirty: boolean) => void;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const buffers = new Map<string, Buffer>();
  let shown: string | null = null;
  let swapToken = 0;

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
  }

  function evictClosed(openPaths: string[]) {
    const live = new Set(openPaths);
    for (const key of buffers.keys()) {
      if (!live.has(key)) buffers.delete(key);
    }
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "", extensions: commonExtensions }),
    });
    if (props.activePath) swapTo(props.activePath);
  });

  createEffect(on(() => props.activePath, (p) => swapTo(p), { defer: true }));
  createEffect(on(() => props.openPaths, (paths) => evictClosed(paths), { defer: true }));

  onCleanup(() => view?.destroy());

  return <div class="code-editor" ref={host} />;
}
