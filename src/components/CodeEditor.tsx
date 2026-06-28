import { onCleanup, onMount, createEffect, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor } from "@codemirror/view";
import { Compartment, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";

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

/** A single-file CM6 editor. Loads `props.path` (an absolute path) via the
 *  fs_read_file command and re-loads when the path changes. Multi-file/tabs and
 *  save arrive in Phase 3. */
export default function CodeEditor(props: { path: string | null }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const language = new Compartment();

  async function openPath(path: string) {
    let text: string;
    try {
      text = await invoke<string>("fs_read_file", { path });
    } catch (e) {
      text = `// failed to open ${path}\n// ${String(e)}`;
    }
    const v = view;
    if (!v) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      effects: language.reconfigure(langForPath(path)),
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  }

  onMount(() => {
    view = new EditorView({
      doc: "",
      parent: host,
      extensions: [
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
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
        language.of([]),
      ],
    });
    if (props.path) openPath(props.path);
  });

  // Subsequent path changes reload the buffer (initial load handled in onMount).
  createEffect(
    on(
      () => props.path,
      (p) => {
        if (p && view) openPath(p);
      },
      { defer: true },
    ),
  );

  onCleanup(() => view?.destroy());

  return <div class="code-editor" ref={host} />;
}
