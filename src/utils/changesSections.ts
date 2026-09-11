// Which sections the Changes tab stacks, and which of them are open. Same
// store as the Files tab's (`sectionLayout.ts`), its own instance.

import { createSectionLayout } from "./sectionLayout";

export type ChangesSection = "changes" | "stashes" | "checkpoints" | "graph";

/** The sections the ... menu can hide. The file list is the tab, so it stays. */
export const OPTIONAL_CHANGES_SECTIONS: {
  id: Exclude<ChangesSection, "changes">;
  label: string;
}[] = [
  { id: "stashes", label: "Stashes" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "graph", label: "Graph" },
];

export const changesLayout = createSectionLayout<ChangesSection>({
  key: "sway.changes.sections.v1",
  ids: ["changes", "stashes", "checkpoints", "graph"],
  pinned: "changes",
});
