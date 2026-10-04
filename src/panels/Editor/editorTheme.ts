import { EditorView } from "@codemirror/view";

const editorFont = 'var(--editor-font-family, "SF Mono", Menlo, Monaco, monospace)';
const editorSize = "var(--editor-font-size, 13px)";

// Where a popup's text wraps. Past about seventy characters the eye loses its
// way back to the start of the next line, and without a cap a type error runs
// to the edge of the window.
const measure = "min(72ch, 90vw)";

/** The file tab's colours and fonts, for every buffer that should read like one. */
export const toriTheme = EditorView.theme(
  {
    "&": { backgroundColor: "var(--canvas-card)", color: "var(--fg-default)", height: "100%" },
    ".cm-content": {
      caretColor: "var(--fg-default)",
      fontFamily: editorFont,
      fontSize: editorSize,
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
      fontFamily: editorFont,
      fontSize: editorSize,
    },
    // What a folded range collapses to. CodeMirror's own is three fixed greys,
    // which is a light chip sitting in a dark buffer until something says
    // otherwise.
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--neutral-hover)",
      border: "1px solid var(--border-default)",
      color: "var(--fg-muted)",
      borderRadius: "var(--tori-radius-sm)",
      margin: "0 var(--tori-space-1)",
      padding: "0 var(--tori-space-2)",
    },
    // Translucent, so the line keeps whatever is already under it. An opaque
    // wash would erase the diff colours on the line being edited and the
    // paused-frame stripe on the line the debugger stopped at, which are the
    // two lines most likely to have a caret on them. It reads as `transparent`
    // until the setting asks for it: `activeLineHighlight` decides whether the
    // class is ever on a line at all (see editorPrefs.ts), so "none" is the
    // extension being absent rather than a colour being cleared here.
    ".cm-activeLine": { backgroundColor: "var(--neutral-subtle)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--neutral-hover)" },

    // Everything that floats over the code: the hover (LSP info, diagnostics and
    // the debugger's value share one box), signature help, completion and its
    // docs. CodeMirror's own is `#333338` with white text whatever the palette,
    // because this theme declares itself dark to the library in light mode too.
    // `canvas-head` rather than the chrome tooltip's `canvas-card`: that is the
    // buffer's own colour, and a hover holding code would read as more buffer.
    ".cm-tooltip": {
      backgroundColor: "var(--canvas-head)",
      color: "var(--fg-default)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--tori-radius-md)",
      boxShadow: "var(--shadow-md)",
      fontFamily: "var(--tori-font-ui)",
      fontSize: "var(--tori-text-md)",
      lineHeight: "var(--tori-line-normal)",
    },
    ".cm-tooltip-hover": { maxWidth: measure, maxHeight: "min(24em, 50vh)", overflowY: "auto" },
    ".cm-tooltip-section:not(:first-child)": { borderTop: "1px solid var(--border-default)" },

    ".cm-lsp-documentation": {
      // The completion docs sit in CodeMirror's `pre-line` box, which would turn
      // every newline marked leaves between blocks into a blank line.
      whiteSpace: "normal",
      overflowWrap: "anywhere",
      "& p, & pre, & ul, & ol": { margin: "var(--tori-space-2) 0" },
      "& > :first-child": { marginTop: "0" },
      "& > :last-child": { marginBottom: "0" },
      "& ul, & ol": { paddingLeft: "var(--tori-space-6)" },
      "& pre": { whiteSpace: "pre-wrap", fontFamily: editorFont, fontSize: editorSize },
      "& code": { fontFamily: editorFont },
      "& :not(pre) > code": {
        padding: "0 var(--tori-space-1)",
        borderRadius: "var(--tori-radius-sm)",
        backgroundColor: "var(--neutral-subtle)",
      },
      "& a": { color: "var(--accent-fg)" },
      "& hr": { border: "none", borderTop: "1px solid var(--border-default)", margin: "var(--tori-space-3) 0" },
    },
    ".cm-lsp-hover-tooltip": { padding: "var(--tori-space-3) var(--tori-space-4)" },

    ".cm-diagnostic": { padding: "var(--tori-space-3) var(--tori-space-4)", overflowWrap: "anywhere" },
    ".cm-diagnostic-error": { borderLeft: "3px solid var(--diag-error)" },
    ".cm-diagnostic-warning": { borderLeft: "3px solid var(--diag-warning)" },
    ".cm-diagnostic-info": { borderLeft: "3px solid var(--diag-info)" },
    ".cm-diagnostic-hint": { borderLeft: "3px solid var(--diag-hint)" },
    ".cm-diagnosticSource": { color: "var(--fg-muted)", fontSize: "var(--tori-text-xs)", opacity: "1" },
    ".cm-diagnosticAction": {
      marginLeft: "var(--tori-space-4)",
      padding: "0 var(--tori-space-3)",
      backgroundColor: "var(--neutral-hover)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--tori-radius-sm)",
      color: "var(--fg-default)",
      fontSize: "var(--tori-text-sm)",
      "&:hover": { borderColor: "var(--brand-default)" },
    },

    ".cm-lsp-signature-tooltip": {
      maxWidth: measure,
      padding: "var(--tori-space-2) var(--tori-space-4)",
      overflowY: "auto",
      "&.cm-lsp-signature-multiple": { paddingLeft: "calc(var(--tori-space-4) + 3ch)" },
      "& .cm-lsp-signature": { fontFamily: editorFont, fontSize: editorSize },
      "& .cm-lsp-signature-num": {
        left: "var(--tori-space-3)",
        top: "var(--tori-space-2)",
        color: "var(--fg-muted)",
        fontFamily: editorFont,
      },
      "& .cm-lsp-active-parameter": { color: "var(--accent-fg)", fontWeight: "600" },
      "& .cm-lsp-documentation": { marginTop: "var(--tori-space-1)", color: "var(--fg-muted)", fontSize: "var(--tori-text-sm)" },
    },

    ".cm-tooltip.cm-tooltip-autocomplete": {
      "& > ul": {
        padding: "var(--tori-space-1)",
        maxWidth: "min(60ch, 95vw)",
        fontFamily: editorFont,
        fontSize: editorSize,
        "& > li": { padding: "var(--tori-space-1) var(--tori-space-3)", borderRadius: "var(--tori-radius-sm)" },
        "& > completion-section": { borderBottom: "1px solid var(--border-default)", color: "var(--fg-muted)", opacity: "1" },
      },
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--neutral-hover)", color: "var(--fg-default)" },
    ".cm-tooltip-autocomplete-disabled ul li[aria-selected]": { background: "var(--neutral-subtle)" },
    ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent-fg)", fontWeight: "600" },
    ".cm-completionDetail": { color: "var(--fg-muted)" },
    ".cm-completionIcon": { color: "var(--fg-muted)", opacity: "1" },
    ".cm-tooltip.cm-completionInfo": { padding: "var(--tori-space-3) var(--tori-space-4)" },
    ".cm-completionInfo .cm-lsp-documentation": { padding: "0" },

    // CodeMirror's own pair is a fixed cyan and magenta, whatever the palette.
    ".cm-searchMatch": { backgroundColor: "var(--brand-subtle)", borderRadius: "var(--tori-radius-sm)" },
    ".cm-searchMatch-selected": { outline: "1px solid var(--brand-default)" },

    // The strips above and below the code: the rename prompt, a server's
    // message, the reference list and vim's status line. The border is the
    // container's so a panel added later cannot forget it.
    ".cm-panels": {
      backgroundColor: "var(--canvas-head)",
      color: "var(--fg-default)",
      fontFamily: "var(--tori-font-ui)",
      fontSize: "var(--tori-text-md)",
    },
    ".cm-panels-top": { borderBottom: "1px solid var(--border-default)" },
    ".cm-panels-bottom": { borderTop: "1px solid var(--border-default)" },
    ".cm-dialog": {
      // The right inset is room for the close button CodeMirror pins there.
      padding: "var(--tori-space-2) var(--tori-space-7) var(--tori-space-2) var(--tori-space-3)",
      "& label": { color: "var(--fg-muted)", fontSize: "var(--tori-text-md)" },
    },
    ".cm-lsp-message-error": { boxShadow: "inset 3px 0 0 var(--diag-error)" },
    ".cm-lsp-message-warning": { boxShadow: "inset 3px 0 0 var(--diag-warning)" },
    ".cm-lsp-message-info": { boxShadow: "inset 3px 0 0 var(--diag-info)" },
    ".cm-textfield": {
      height: "var(--control-height-sm)",
      padding: "0 var(--tori-space-3)",
      backgroundColor: "var(--canvas-input)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--tori-radius-md)",
      color: "var(--fg-default)",
      caretColor: "var(--brand-default)",
      fontFamily: "inherit",
      fontSize: "var(--tori-text-md)",
      outline: "none",
      "&:focus": { borderColor: "var(--brand-default)" },
    },
    ".cm-button": {
      height: "var(--control-height-sm)",
      padding: "0 var(--tori-space-4)",
      backgroundColor: "var(--neutral-hover)",
      backgroundImage: "none",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--tori-radius-md)",
      color: "var(--fg-default)",
      fontFamily: "inherit",
      fontSize: "var(--tori-text-md)",
      cursor: "pointer",
      "&:hover": { borderColor: "var(--brand-default)" },
      "&:active": { backgroundImage: "none" },
      "&:focus-visible": { outline: "none", borderColor: "var(--brand-default)", boxShadow: "0 0 0 3px var(--brand-ring)" },
    },
    ".cm-dialog-close": {
      color: "var(--fg-muted)",
      cursor: "pointer",
      "&:hover": { color: "var(--fg-default)" },
    },
    ".cm-lsp-reference-panel": {
      padding: "var(--tori-space-2) var(--tori-space-3)",
      fontFamily: editorFont,
      fontSize: editorSize,
      "&:focus": { outline: "none" },
      "& .cm-lsp-reference": {
        padding: "0 var(--tori-space-2)",
        borderRadius: "var(--tori-radius-sm)",
        "&[aria-selected]": { backgroundColor: "var(--neutral-hover)" },
      },
      "& .cm-lsp-reference-line": { color: "var(--fg-muted)", opacity: "1" },
    },
  },
  { dark: true },
);
