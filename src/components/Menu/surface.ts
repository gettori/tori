import { createContext, useContext, type Accessor } from "solid-js";

/**
 * Where an open menu's parts are portalled to, published by whichever wrapper
 * opened it.
 *
 * A menu is not one portal. Every flyout inside it is its own portal, mounted
 * where it is told, and a flyout that resolved its own mount would diverge from
 * the menu it belongs to the moment a call site passed `mount` explicitly:
 * flyouts in the body, the rows they came from in a dialog panel. The mount is
 * one decision, made once by the wrapper, and read from here by the parts.
 *
 * `undefined` is the honest answer when no wrapper is above (a `MenuSub` used
 * outside one, which nothing does today), and `<Portal>` reads it as "no mount
 * given" and uses the body.
 */
export const MenuSurface = createContext<Accessor<HTMLElement | undefined>>();

/** What the enclosing wrapper portals into. Call during component setup, like
 *  any `useContext`: the returned accessor is what stays live. */
export function useMenuSurface(): Accessor<HTMLElement | undefined> {
  const surface = useContext(MenuSurface);
  return () => surface?.();
}
