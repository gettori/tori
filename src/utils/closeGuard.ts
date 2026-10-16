// What a quit has to get past before the window goes away.
//
// A registry rather than a second `app://quit` listener: two listeners would
// each run their own prompts and destroy the window on their own answer. The
// one listener is the editor's, the panel with unsaved buffers to lose.
export type CloseGuard = () => boolean | Promise<boolean>;

const guards = new Set<CloseGuard>();

/** Register a question to ask before quitting. Returns the unregister. */
export function registerCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/**
 * True when every guard agrees the app may quit. Serial, not `Promise.all`:
 * these open modals, and two prompts at once is not a question anyone can
 * answer. The first refusal ends it, so a cancelled quit never gets as far as
 * the next dialog.
 */
export async function closeAllowed(): Promise<boolean> {
  for (const guard of [...guards]) {
    if (!(await guard())) return false;
  }
  return true;
}
