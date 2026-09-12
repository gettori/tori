// The Files tab's layout: the tree, and under it one section showing one of
// three tabs. Same store as the Changes tab's (`sectionLayout.ts`), its own
// instance, plus the tab, which is a choice of its own.

import { createSignal } from "solid-js";
import { createSectionLayout, SECTION_MIN_H } from "./sectionLayout";

export type FilesSection = "folders" | "views";
export type FilesTab = "scripts" | "outline" | "todos";

export const FILES_TABS: { id: FilesTab; label: string }[] = [
  { id: "scripts", label: "Scripts" },
  { id: "outline", label: "Outline" },
  { id: "todos", label: "TODOs" },
];

export { SECTION_MIN_H };

/** v2: the three sections under the tree became one tabbed section, so a v1
 *  layout named sections that no longer exist. The tab ids stay in the id set
 *  for one field only, `hidden`: a tab the ... menu unticks leaves the strip. */
export const filesLayout = createSectionLayout<FilesSection | FilesTab>({
  key: "sway.files.sections.v2",
  ids: ["folders", "views", "scripts", "outline", "todos"],
  pinned: "folders",
});

export const sectionShown = filesLayout.shown;
export const sectionOpen = filesLayout.open;
export const setSectionShown = filesLayout.setShown;

const TAB_KEY = "sway.files.viewTab";

function loadTab(): FilesTab {
  const raw = localStorage.getItem(TAB_KEY);
  return FILES_TABS.some((t) => t.id === raw) ? (raw as FilesTab) : "scripts";
}

const [filesTab, setFilesTabSignal] = createSignal<FilesTab>(loadTab());

export { filesTab };

export function setFilesTab(tab: FilesTab): void {
  setFilesTabSignal(tab);
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage blocked: the choice still holds for this run.
  }
}

/** Shown, picked and open at once, for the palette's Show Scripts and Show
 *  Outline. */
export function revealTab(tab: FilesTab): void {
  filesLayout.setShown(tab, true);
  setFilesTab(tab);
  filesLayout.setOpen("views", true);
}
