// Which sections the Files tab stacks under its tree, and which of them are
// open. The store itself is `sectionLayout.ts`, shared with the Changes tab.

import { createSectionLayout, SECTION_DEFAULT_H, SECTION_MIN_H } from "./sectionLayout";

export type FilesSection = "folders" | "scripts" | "outline" | "todos";

/** The sections the ... menu can hide. The tree is the tab, so it cannot go. */
export const OPTIONAL_SECTIONS: { id: Exclude<FilesSection, "folders">; label: string }[] = [
  { id: "scripts", label: "Scripts" },
  { id: "outline", label: "Outline" },
  { id: "todos", label: "TODOs" },
];

export { SECTION_DEFAULT_H, SECTION_MIN_H };

export const filesLayout = createSectionLayout<FilesSection>({
  key: "sway.files.sections.v1",
  ids: ["folders", "scripts", "outline", "todos"],
  pinned: "folders",
});

export const sectionShown = filesLayout.shown;
export const sectionOpen = filesLayout.open;
export const setSectionShown = filesLayout.setShown;
export const setSectionOpen = filesLayout.setOpen;
/** Shown and open, for the palette's Show Scripts and Show Outline. */
export const revealSection = filesLayout.reveal;
export const sectionSize = filesLayout.size;
export const setSectionSize = filesLayout.setSize;
export const saveSectionSizes = filesLayout.saveSizes;
