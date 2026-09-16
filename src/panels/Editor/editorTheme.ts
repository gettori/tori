import { EditorView } from "@codemirror/view";

/** The file tab's colours and fonts, for every buffer that should read like one. */
export const toriTheme = EditorView.theme(
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
