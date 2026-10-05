// The Changes tab's layout: the file list, and under it one history section
// showing one of three tabs. Same store as the Files tab's (`sectionLayout.ts`),
// its own instance, plus the tab, which is a choice of its own.

import { createSignal } from "solid-js";
import { createSectionLayout } from "./sectionLayout";

export type ChangesSection = "changes" | "history";
export type HistoryTab = "graph" | "stashes" | "checkpoints";

export const HISTORY_TABS: { id: HistoryTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "stashes", label: "Stashes" },
  { id: "checkpoints", label: "Checkpoints" },
];

/** v2: the three history sections became one tabbed section, so a v1 layout
 *  named sections that no longer exist. The tab ids stay in the id set for one
 *  field only, `hidden`: a tab the ... menu unticks leaves the strip. */
export const changesLayout = createSectionLayout<ChangesSection | HistoryTab>({
  key: "tori.changes.sections.v2",
  ids: ["changes", "history", "graph", "stashes", "checkpoints"],
  pinned: "changes",
});

export const tabShown = changesLayout.shown;
export const setTabShown = changesLayout.setShown;

const TAB_KEY = "tori.changes.historyTab";

function loadTab(): HistoryTab {
  const raw = localStorage.getItem(TAB_KEY);
  return HISTORY_TABS.some((t) => t.id === raw) ? (raw as HistoryTab) : "graph";
}

const [historyTab, setHistoryTabSignal] = createSignal<HistoryTab>(loadTab());

export { historyTab };

export function setHistoryTab(tab: HistoryTab): void {
  setHistoryTabSignal(tab);
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage blocked: the choice still holds for this run.
  }
}

const COMMIT_BOX_KEY = "tori.changes.commitBox";

const [commitBoxShown, setCommitBoxSignal] = createSignal(localStorage.getItem(COMMIT_BOX_KEY) === "1");

export { commitBoxShown };

export function setCommitBoxShown(on: boolean): void {
  setCommitBoxSignal(on);
  try {
    localStorage.setItem(COMMIT_BOX_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice still holds for this run.
  }
}
