import { createSignal, createStore, flush, getOwner } from "solid-js";

let holding = false;

// For an effect callback, where flush is refused but the write cannot wait for a
// microtask, since a caller may write the same state again before one runs.
export function withoutFlush(write: () => void) {
  holding = true;
  try {
    write();
  } finally {
    holding = false;
  }
}

const flushed =
  <A extends unknown[], R>(write: (...args: A) => R) =>
  (...args: A) => {
    const out = write(...args);
    // Inside a render or settle callback, flush throws or runs other effects early.
    if (!holding && !getOwner()) flush();
    return out;
  };

// For module level state. 1.9 showed a write at once and callers read it back in
// the same handler, where 2.0 would hand them the old value. #109 removes these.
export const createLiveSignal = ((...args: Parameters<typeof createSignal>) => {
  const [read, write] = createSignal(...args);
  return [read, flushed(write as (...a: unknown[]) => unknown)];
}) as typeof createSignal;

export const createLiveStore = ((...args: Parameters<typeof createStore>) => {
  const [read, write] = createStore(...args);
  return [read, flushed(write as (...a: unknown[]) => unknown)];
}) as typeof createStore;
