// Stacked panel sections: which are shown, which are open, how tall each is.
//
// One layout per tab, shared by every workspace, like VS Code's Explorer. The
// Files and Changes tabs each make an instance rather than sharing a store:
// their section names are different sets, and one store would let a tab hide a
// section the other one owns.

import { createSignal } from "solid-js";

/** A section nobody has dragged yet: the header and about seven rows. */
export const SECTION_DEFAULT_H = 230;
export const SECTION_MIN_H = 90;

type Layout<Id extends string> = {
  hidden: Id[];
  closed: Id[];
  /** Heights in design px (before `--ui-scale`), header included. */
  sizes: Partial<Record<Id, number>>;
};

export type SectionLayout<Id extends string> = {
  shown: (id: Id) => boolean;
  open: (id: Id) => boolean;
  setShown: (id: Id, shown: boolean) => void;
  setOpen: (id: Id, open: boolean) => void;
  /** Shown and open at once, for the palette's "Show X" commands. */
  reveal: (id: Id) => void;
  size: (id: Id) => number;
  /** Mid-drag writes skip storage; `saveSizes` at the drag's end saves once. */
  setSize: (id: Id, h: number) => void;
  saveSizes: () => void;
};

export function createSectionLayout<Id extends string>(opts: {
  /** Storage key, versioned by the caller so a changed section set can be
   *  retired rather than half-read. */
  key: string;
  ids: readonly Id[];
  /** The section that is the tab itself. It can close but never hide, or the
   *  tab would have no body. */
  pinned?: Id;
  defaultH?: number;
}): SectionLayout<Id> {
  const { key, ids, pinned, defaultH = SECTION_DEFAULT_H } = opts;
  const known = (v: unknown): v is Id => typeof v === "string" && (ids as readonly string[]).includes(v);

  function load(): Layout<Id> {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<Layout<Id>> | null;
      const list = (v: unknown) => (Array.isArray(v) ? v.filter(known) : []);
      const sizes: Partial<Record<Id, number>> = {};
      for (const [k, v] of Object.entries(raw?.sizes ?? {})) {
        if (known(k) && typeof v === "number" && v >= SECTION_MIN_H) sizes[k] = v;
      }
      return {
        hidden: list(raw?.hidden).filter((s) => s !== pinned),
        closed: list(raw?.closed),
        sizes,
      };
    } catch {
      // Unparseable or blocked storage: this run starts from the defaults
      // rather than refusing to draw the tab.
      return { hidden: [], closed: [], sizes: {} };
    }
  }

  const [layout, setLayout] = createSignal<Layout<Id>>(load());

  function write(next: Layout<Id>, persist = true) {
    setLayout(next);
    if (!persist) return;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the layout still holds for this run.
    }
  }

  const without = (xs: Id[], s: Id) => xs.filter((x) => x !== s);

  return {
    shown: (id) => !layout().hidden.includes(id),
    open: (id) => !layout().closed.includes(id),
    setShown(id, shown) {
      if (id === pinned) return;
      const l = layout();
      write({ ...l, hidden: shown ? without(l.hidden, id) : [...without(l.hidden, id), id] });
    },
    setOpen(id, open) {
      const l = layout();
      write({ ...l, closed: open ? without(l.closed, id) : [...without(l.closed, id), id] });
    },
    reveal(id) {
      const l = layout();
      write({ ...l, hidden: without(l.hidden, id), closed: without(l.closed, id) });
    },
    size: (id) => layout().sizes[id] ?? defaultH,
    setSize(id, h) {
      const l = layout();
      write({ ...l, sizes: { ...l.sizes, [id]: Math.max(SECTION_MIN_H, Math.round(h)) } }, false);
    },
    saveSizes() {
      write(layout());
    },
  };
}
