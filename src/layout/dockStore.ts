// Module-level rather than App's own signals because the tab model asks it what
// is on screen, and the terminal panel opens it for a command. App.tsx resets it
// at setup with the stored open state.
import { createLiveSignal } from "../lib/liveState";

/** Which of the two strips on screen the tab keys address. */
export type Surface = "workspace" | "dock";

const [dockOpen, setDockOpen] = createLiveSignal(false);
const [focusedSurface, setFocusedSurface] = createLiveSignal<Surface>("workspace");

export { dockOpen, focusedSurface, setFocusedSurface };

export function showDock(open: boolean) {
  setDockOpen(open);
  // A hidden dock has no strip left to address.
  if (!open) setFocusedSurface("workspace");
}

export const dockFocused = () => dockOpen() && focusedSurface() === "dock";

export function resetDock(open: boolean) {
  setDockOpen(open);
  setFocusedSurface("workspace");
}
