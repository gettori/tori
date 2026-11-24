import { createProjection } from "solid-js";

// A row that reads a whole Map or Set wakes on every change to it. Reading its
// own key here wakes it only when its entry changes.
export function byKey<T>(source: () => ReadonlyMap<string, T>): Readonly<Record<string, T>> {
  return createProjection<Record<string, T>>((draft) => {
    const next = source();
    for (const key of Object.keys(draft)) if (!next.has(key)) delete draft[key];
    for (const [key, value] of next) if (draft[key] !== value) draft[key] = value;
  }, {});
}

export function flagsOf(source: () => Iterable<string | null | undefined>): Readonly<Record<string, true>> {
  return byKey(() => {
    const on = new Map<string, true>();
    for (const key of source()) if (key) on.set(key, true);
    return on;
  });
}
