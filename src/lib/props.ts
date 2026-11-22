import { omit } from "solid-js";

// `merge` lets an `undefined` override, and a default has to survive `attr={maybe}`.
export const defined = <T extends Record<string, any>>(props: T) =>
  omit(props, (key) => props[key as keyof T] === undefined) as T;
