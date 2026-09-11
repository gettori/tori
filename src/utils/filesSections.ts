// Which sections the Files tab stacks under its tree, and which of them are
// open. One layout for every workspace, like VS Code's Explorer.

import { createSignal } from "solid-js";

export type FilesSection = "folders" | "scripts" | "outline";

/** The sections the ... menu can hide. The tree is the tab, so it cannot go. */
export const OPTIONAL_SECTIONS: { id: Exclude<FilesSection, "folders">; label: string }[] = [
  { id: "scripts", label: "Scripts" },
  { id: "outline", label: "Outline" },
];

/** Heights in design px (before `--ui-scale`), header included. */
type Sizes = Partial<Record<FilesSection, number>>;
type Layout = { hidden: FilesSection[]; closed: FilesSection[]; sizes: Sizes };

/** A section nobody has dragged yet: the header and about seven rows. */
export const SECTION_DEFAULT_H = 230;
export const SECTION_MIN_H = 90;

const KEY = "sway.files.sections.v1";

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Layout> | null;
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((s): s is FilesSection => s === "folders" || s === "scripts" || s === "outline") : [];
    const sizes: Sizes = {};
    for (const [k, v] of Object.entries(raw?.sizes ?? {})) {
      if (list([k]).length && typeof v === "number" && v >= SECTION_MIN_H) sizes[k as FilesSection] = v;
    }
    return { hidden: list(raw?.hidden).filter((s) => s !== "folders"), closed: list(raw?.closed), sizes };
  } catch {
    return { hidden: [], closed: [], sizes: {} };
  }
}

const [layout, setLayout] = createSignal<Layout>(load());

function write(next: Layout, persist = true) {
  setLayout(next);
  if (!persist) return;
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
  write({ ...l, hidden: without(l.hidden, s), closed: without(l.closed, s) });
}

export const sectionSize = (s: FilesSection) => layout().sizes[s] ?? SECTION_DEFAULT_H;

/** Mid-drag writes skip storage; the drag's end saves once. */
export function setSectionSize(s: FilesSection, h: number) {
  const l = layout();
  write({ ...l, sizes: { ...l.sizes, [s]: Math.max(SECTION_MIN_H, Math.round(h)) } }, false);
}

export function saveSectionSizes() {
  write(layout());
}
