import { createSignal, createStore, flush } from "solid-js";

const flushed =
  <A extends unknown[], R>(write: (...args: A) => R) =>
  (...args: A) => {
    const out = write(...args);
    flush();
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
