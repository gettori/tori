// What each way into the sidebar was last left on: a unit per space, and the
// one Feature. Hints, never truth: the caller re-reads the live tree or the
// Feature list and drops an entry whose folder or record is gone.
import type { Selection } from "../panels/LeftSidebar/LeftSidebar";

const KEY = "tori.selection-memory.v1";

type Memory = { spaces: Record<string, Selection>; feature: Selection | null };

function sel(v: unknown): Selection | null {
  const s = v as Selection | null;
  return s && typeof s === "object" && typeof s.folderPath === "string" ? s : null;
}

function read(): Memory {
  const empty: Memory = { spaces: {}, feature: null };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Memory> | null;
    if (!parsed || typeof parsed !== "object") return empty;
    const spaces: Record<string, Selection> = {};
    for (const [space, v] of Object.entries(parsed.spaces ?? {})) {
      const s = sel(v);
      if (s && s.folderPath) spaces[space] = s;
    }
    return { spaces, feature: sel(parsed.feature) };
  } catch {
    return empty;
  }
}

function write(next: Memory) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or disabled store costs the next switch its memory and nothing
    // else; the live selection never comes from here.
  }
}

/** Record a selection under the way back to it: its space, or the Feature slot.
 *  A Feature spans members and has no space, so the two never collide. */
export function rememberSelection(s: Selection | null) {
  if (!s) return;
  const mem = read();
  if (s.kind === "feature") {
    if (!s.featureId) return;
    write({ ...mem, feature: s });
    return;
  }
  if (!s.spaceName || !s.folderPath) return;
  write({ ...mem, spaces: { ...mem.spaces, [s.spaceName]: s } });
}

/** The unit `space` was last left on, or null when it has never been opened. */
export function rememberedUnit(space: string): Selection | null {
  if (!space) return null;
  return read().spaces[space] ?? null;
}

/** The Feature last selected, in either mode. */
export function rememberedFeature(): Selection | null {
  return read().feature;
}
