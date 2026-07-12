// VS Code theme -> Sway semantic-token mapping. A theme (bundled or imported)
// is distilled to ThemeColors, then resolved to the CSS custom properties the
// chrome and CM6 read. Keys are tried in order; the first present wins, else the
// fallback (which equals the token-layer default, so an unmapped theme still
// looks like Dark+).

export type ThemeColors = {
  kind: string | null;
  colors: Record<string, string>;
  syntax: Record<string, string>;
};

/** A raw VS Code theme file (subset we read). */
export type RawTheme = {
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: Array<{
    scope?: string | string[];
    settings?: { foreground?: string };
  }>;
};

// [cssVar, vscode color keys (first present wins), fallback].
export const MAP: [string, string[], string][] = [
  ["--bg", ["editor.background"], "#1a1a1a"],
  ["--pane-bg", ["sideBar.background", "editor.background"], "#1e1e1e"],
  [
    "--pane-head-bg",
    ["sideBarSectionHeader.background", "tab.inactiveBackground", "editorGroupHeader.tabsBackground"],
    "#252526",
  ],
  ["--border", ["panel.border", "sideBar.border", "editorGroup.border", "contrastBorder"], "#2d2d2d"],
  ["--text", ["foreground", "sideBar.foreground", "editor.foreground"], "#d4d4d4"],
  ["--text-dim", ["descriptionForeground", "disabledForeground"], "#808080"],
  ["--accent", ["focusBorder", "button.background", "textLink.foreground", "progressBar.background"], "#4a9eff"],
  ["--sel", ["list.activeSelectionBackground", "list.inactiveSelectionBackground"], "#094771"],
  ["--hover", ["list.hoverBackground", "toolbar.hoverBackground"], "#2a2d2e"],
  ["--input-bg", ["input.background", "dropdown.background"], "#1a1a1a"],
];

// [cssVar, syntax category (from distilled tokenColors), fallback].
// Fallbacks are the VS Code Dark+ defaults; CM6's HighlightStyle reads these via
// var(), so re-theming is automatic when the props change.
export const SYN_MAP: [string, string, string][] = [
  ["--syn-keyword", "keyword", "#569cd6"],
  ["--syn-string", "string", "#ce9178"],
  ["--syn-comment", "comment", "#6a9955"],
  ["--syn-number", "number", "#b5cea8"],
  ["--syn-function", "function", "#dcdcaa"],
  ["--syn-type", "type", "#4ec9b0"],
  ["--syn-variable", "variable", "#9cdcfe"],
];

// Category -> candidate TextMate scopes (exact match first, then shortest
// `scope.`-prefixed match). Mirrors the Rust distiller in src-tauri/src/theme.rs
// so bundled themes distil in the frontend without a native round-trip.
export const SYN_SCOPES: [string, string[]][] = [
  ["keyword", ["keyword", "keyword.control", "storage.type", "storage.modifier"]],
  ["string", ["string", "string.quoted"]],
  ["comment", ["comment"]],
  ["number", ["constant.numeric", "constant.language", "constant"]],
  ["function", ["entity.name.function", "support.function", "meta.function-call"]],
  ["type", ["entity.name.type", "support.type", "support.class", "entity.name.class"]],
  ["variable", ["variable", "variable.other"]],
];
