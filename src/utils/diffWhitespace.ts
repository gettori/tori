// Whether diff tabs ask git to ignore whitespace. One signal for every open
// diff tab, for `sideBySide.ts`'s reason: tabs that each read the key at mount
// disagree the moment one of them is toggled.
import { createSignal } from "solid-js";

const DIFF_IGNORE_WHITESPACE_KEY = "sway.diff.ignoreWhitespace";

const [diffIgnoreWhitespaceOn, setDiffIgnoreWhitespaceSignal] = createSignal(
  localStorage.getItem(DIFF_IGNORE_WHITESPACE_KEY) === "1",
);

export { diffIgnoreWhitespaceOn };

export function writeDiffIgnoreWhitespace(on: boolean): void {
  setDiffIgnoreWhitespaceSignal(on);
  localStorage.setItem(DIFF_IGNORE_WHITESPACE_KEY, on ? "1" : "0");
}
