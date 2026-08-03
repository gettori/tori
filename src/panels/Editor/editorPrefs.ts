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
import type { Extension } from "@codemirror/state";
import type { EditorPrefs } from "../Settings/settingsStore";

/**
 * The extensions the current preferences call for.
 *
 * Empty while wave 5 is still landing: each phase adds the one entry its
 * feature needs (soft wrap, whitespace, indent guides, ...). A preference whose
 * extension cannot be added and removed live does not belong here, it belongs
 * in `makeState` with a rebuild.
 */
export function editorPrefExtensions(_prefs: EditorPrefs): Extension[] {
  return [];
}
