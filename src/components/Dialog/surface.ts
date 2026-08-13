import { createContext, useContext, type Accessor } from "solid-js";

/**
 * The open dialog's panel element, for the things that must portal *into* it
 * rather than onto `document.body`.
 *
 * A modal dialog expresses its modality by aria-hiding the rest of the
 * document: Kobalte's `Dialog.Content` calls `createHideOutside`, which walks
 * the tree and sets `aria-hidden` on every subtree that is not the panel. A
 * `<Portal>` mounts to the body by default, which is one of those subtrees, so
 * anything portalled from inside a dialog is painted on screen and absent from
 * the accessibility tree at the same time - the failure that is hardest to
 * catch, because it looks right.
 *
 * The panel is published here rather than passed down by hand because the
 * elements that need it (`Tooltip`, and whatever floats next) sit arbitrarily
 * deep in a dialog's children, and threading a ref through every call site is
 * exactly the per-site plumbing this component cluster exists to delete.
 *
 * Lives in its own module rather than in `Dialog.tsx` so that a floating
 * component can read it without importing the dialog, which would be a cycle
 * the moment a dialog wanted one of them.
 *
 * Outside a dialog the context is absent, and `undefined` is the honest answer:
 * `<Portal>` reads it as "no mount given" and uses the body, which is correct
 * when there is no panel to be hidden by.
 */
export const DialogSurface = createContext<Accessor<HTMLElement | undefined>>();

/** The enclosing dialog's panel, or `undefined` outside a dialog.
 *
 *  Call during component setup, like any `useContext`: the returned accessor
 *  is what stays live. Reading the context itself later would resolve against
 *  whatever owner happened to be current at that moment. */
export function useDialogSurface(): Accessor<HTMLElement | undefined> {
  const surface = useContext(DialogSurface);
  return () => surface?.();
}
