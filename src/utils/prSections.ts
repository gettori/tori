// The Pull requests panel's bottom section: one tabbed strip, the way the Files
// tab stacks Scripts, Outline and TODOs under its tree.
//
// The layout store is the one the Files and Changes tabs use, so the section
// opens, closes, keeps a dragged height and survives a relaunch the way every
// other section in the right pane does. Its own instance, because a section set
// belongs to one tab.
//
// The chosen tab is stored separately and per machine rather than per pull
// request: it is where the reader likes to work, not a fact about the branch in
// front of them.

import { createSignal } from "solid-js";
import { createSectionLayout } from "./sectionLayout";

export type PrTab = "checks" | "review" | "merge";

export const PR_TABS: { id: PrTab; label: string }[] = [
  { id: "checks", label: "Checks" },
  { id: "review", label: "Review" },
  { id: "merge", label: "Merge" },
];

export const prLayout = createSectionLayout<"detail">({
  key: "tori.pulls.sections.v1",
  ids: ["detail"],
  // The summary box, three verdicts and the button, without a drag.
  defaultH: 260,
});

const TAB_KEY = "tori.pulls.tab";

function loadTab(): PrTab {
  const raw = localStorage.getItem(TAB_KEY);
  return PR_TABS.some((t) => t.id === raw) ? (raw as PrTab) : "review";
}

const [prTab, setTabSignal] = createSignal<PrTab>(loadTab());

export { prTab };

export function setPrTab(tab: PrTab): void {
  setTabSignal(tab);
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage blocked: the choice still holds for this run.
  }
}

/** Pick a tab and open the section, for the summary rows above it: a row whose
 *  click left the section shut would read as a click that did nothing. */
export function revealPrTab(tab: PrTab): void {
  setPrTab(tab);
  prLayout.setOpen("detail", true);
}
