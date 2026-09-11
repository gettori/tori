// Which sections the Files tab stacks under its tree, and which of them are
// open. One layout for every workspace, like VS Code's Explorer.

import { createSignal } from "solid-js";

export type FilesSection = "folders" | "scripts" | "outline";

/** The sections the ... menu can hide. The tree is the tab, so it cannot go. */
export const OPTIONAL_SECTIONS: { id: Exclude<FilesSection, "folders">; label: string }[] = [
  { id: "scripts", label: "Scripts" },
  { id: "outline", label: "Outline" },
];

type Layout = { hidden: FilesSection[]; closed: FilesSection[] };

const KEY = "sway.files.sections.v1";

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Layout> | null;
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((s): s is FilesSection => s === "folders" || s === "scripts" || s === "outline") : [];
    return { hidden: list(raw?.hidden).filter((s) => s !== "folders"), closed: list(raw?.closed) };
  } catch {
    return { hidden: [], closed: [] };
  }
}

const [layout, setLayout] = createSignal<Layout>(load());

function write(next: Layout) {
  setLayout(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the layout still holds for this run.
  }
}

const without = (xs: FilesSection[], s: FilesSection) => xs.filter((x) => x !== s);

export const sectionShown = (s: FilesSection) => !layout().hidden.includes(s);
export const sectionOpen = (s: FilesSection) => !layout().closed.includes(s);

export function setSectionShown(s: FilesSection, shown: boolean) {
  if (s === "folders") return;
  const l = layout();
  write({ ...l, hidden: shown ? without(l.hidden, s) : [...without(l.hidden, s), s] });
}

export function setSectionOpen(s: FilesSection, open: boolean) {
  const l = layout();
  write({ ...l, closed: open ? without(l.closed, s) : [...without(l.closed, s), s] });
}

/** Shown and open, for the palette's Show Scripts and Show Outline. */
export function revealSection(s: FilesSection) {
  const l = layout();
  write({ hidden: without(l.hidden, s), closed: without(l.closed, s) });
}
