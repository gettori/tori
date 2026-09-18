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
    // The same font as the code it numbers, rather than the UI's. A line number
    // is a coordinate into the buffer, so it should read at the size the buffer
    // reads at and follow it when that size changes, and monospace digits put
    // the column on the same grid as the text beside it. App.css sizes the fold
    // chevron in `em`, which is measured off this.
    ".cm-gutters": {
      backgroundColor: "var(--canvas-card)",
      color: "var(--fg-subtle)",
      border: "none",
      fontFamily: 'var(--editor-font-family, "SF Mono", Menlo, Monaco, monospace)',
      fontSize: "var(--editor-font-size, 13px)",
    },
    // What a folded range collapses to. CodeMirror's own is three fixed greys,
    // which is a light chip sitting in a dark buffer until something says
    // otherwise.
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--neutral-hover)",
      border: "1px solid var(--border-default)",
      color: "var(--fg-muted)",
      borderRadius: "var(--tori-radius-sm)",
      margin: "0 2px",
      padding: "0 4px",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "var(--neutral-hover)" },
  },
  { dark: true },
);
