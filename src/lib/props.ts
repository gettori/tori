import { omit, untrack } from "solid-js";

// `merge` lets an `undefined` override, and a default has to survive `attr={maybe}`.
export const defined = <T extends Record<string, any>>(props: T) => {
  const kept = omit(props, (key) => props[key as keyof T] === undefined);
  return kept as T;
};

// `defined` decides once per key, so an attribute that starts undefined and turns
// defined later would be dropped for good. This falls back per read.
export function mergeDefined<A extends object, B extends object>(base: A, over: B): A & B {
  const out = {} as Record<string, unknown>;
  for (const key of untrack(() => new Set([...Object.keys(base), ...Object.keys(over)]))) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => {
        const v = (over as Record<string, unknown>)[key];
        return v === undefined ? (base as Record<string, unknown>)[key] : v;
      },
    });
  }
  return out as A & B;
}
