// What `settings.editor` resolves to as CodeMirror extensions.
//
// One function rather than a `prefsConf.reconfigure` spread through the pane,
// because the editor asks this question twice and the two answers must not be
// allowed to differ: once when a buffer's state is *built* (`makeState`), and
// again when a buffer is *swapped in* (`swapTo`). A compartment reconfigure
// reaches the active state only, so a buffer stashed while a preference was off
// still carries the old config when it comes back; re-resolving from here on
// swap is what reconciles it. See `syncEditorPrefs` in CodeEditor.tsx.
//
// Editor-side on purpose: this imports CodeMirror, so it sits behind the lazy
// editor boundary and must never be imported from the eager side.
import { EditorView, highlightWhitespace, scrollPastEnd } from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { rainbowBrackets, bracketPairGuides } from "./bracketPairs";
import { minimap } from "./minimap";
import { stickyScroll } from "./stickyScroll";
import type { Extension } from "@codemirror/state";
import type { EditorDefaults } from "../Settings/settingsStore";

/** A preference that resolves to a live-swappable extension. Named separately
 *  from the settings keys because deciding *which* are on is the part with
 *  rules in it (an override outranks a setting), and it is worth testing
 *  without a DOM to build extensions in. */
export type EditorFeature =
  | "indentGuides"
  | "softWrap"
  | "renderWhitespace"
  | "scrollPastEnd"
  | "rainbowBrackets"
  | "bracketPairGuides"
  | "minimap"
  | "stickyScroll";

/**
 * Per-buffer answers that outrank the global setting.
 *
 * `null` and `undefined` both mean "no override, follow the setting", which is
 * what lets the palette's toggle return a tab to the default rather than only
 * ever pinning it.
 */
export type EditorPrefOverrides = { softWrap?: boolean | null };

/** Which features are on for this buffer, override first, setting second. */
export function activeEditorFeatures(
  prefs: EditorDefaults,
  overrides: EditorPrefOverrides = {},
): EditorFeature[] {
  const on: EditorFeature[] = [];
  if (prefs.indentGuides) on.push("indentGuides");
  if (overrides.softWrap ?? prefs.softWrap) on.push("softWrap");
  if (prefs.renderWhitespace) on.push("renderWhitespace");
  if (prefs.scrollPastEnd) on.push("scrollPastEnd");
  if (prefs.rainbowBrackets) on.push("rainbowBrackets");
  if (prefs.bracketPairGuides) on.push("bracketPairGuides");
  if (prefs.minimap) on.push("minimap");
  if (prefs.stickyScroll) on.push("stickyScroll");
  return on;
}

// A total map rather than a chain of ifs: a feature added to the union without
// an extension behind it fails to compile here, which is the one way this file
// could otherwise ship a preference that quietly does nothing.
const FEATURE_EXTENSIONS: Record<EditorFeature, () => Extension> = {
  // The colours are handed over as `var()` references rather than left to the
  // package's light/dark defaults, for two reasons. They then follow whichever
  // theme is active, including an imported one, instead of picking between two
  // literals; and they land in the same declaration the package writes, so
  // there is no specificity race between its `baseTheme` and a rule of ours
  // further up the tree. Sway's tokens already switch with the palette, so
  // light and dark take the same value here.
  indentGuides: () =>
    indentationMarkers({
      highlightActiveBlock: true,
      colors: {
        light: "var(--border-default)",
        dark: "var(--border-default)",
        activeLight: "var(--border-strong)",
        activeDark: "var(--border-strong)",
      },
    }),
  softWrap: () => EditorView.lineWrapping,
  renderWhitespace: () => highlightWhitespace(),
  scrollPastEnd: () => scrollPastEnd(),
  // Two views of one pass over the same bracket pairs, kept as separate keys
  // because they answer different questions: which bracket closes which, and
  // how far a block reaches. Either can be had without the other.
  rainbowBrackets: () => rainbowBrackets(),
  bracketPairGuides: () => bracketPairGuides(),
  minimap: () => minimap(),
  // Off means the plugin is never in the configuration, so nothing walks the
  // syntax tree and nothing listens for a scroll. That is the whole of the
  // gate: there is no "on but idle" state to get wrong.
  stickyScroll: () => stickyScroll(),
};

/**
 * The extensions the current preferences call for.
 *
 * A preference whose extension cannot be added and removed live does not belong
 * here, it belongs in `makeState` with a rebuild.
 */
export function editorPrefExtensions(
  prefs: EditorDefaults,
  overrides: EditorPrefOverrides = {},
): Extension[] {
  return activeEditorFeatures(prefs, overrides).map((f) => FEATURE_EXTENSIONS[f]());
}
