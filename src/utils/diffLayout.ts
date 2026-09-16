// Whether a file's diff tab shows the file itself instead of rows. One signal
// for every open diff tab, for `sideBySide.ts`'s reason: tabs that each read the
// key at mount disagree the moment one of them is toggled.
import { createSignal } from "solid-js";

const DIFF_EDITOR_LAYOUT_KEY = "tori.diff.editorLayout";

const [diffEditorLayoutOn, setDiffEditorLayoutSignal] = createSignal(
  localStorage.getItem(DIFF_EDITOR_LAYOUT_KEY) === "1",
);

export { diffEditorLayoutOn };

export function writeDiffEditorLayout(on: boolean): void {
  setDiffEditorLayoutSignal(on);
  localStorage.setItem(DIFF_EDITOR_LAYOUT_KEY, on ? "1" : "0");
}
