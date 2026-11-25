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

export type QuitHook = () => boolean | Promise<boolean>;

const hooks = new Set<QuitHook>();

/** Register work for a quit nothing refused any more. Returns the unregister. */
export function registerQuitHook(hook: QuitHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/**
 * Run the quit hooks, right before the window goes. Guards can still refuse
 * after the first one has answered (the editor's unsaved prompt), so anything
 * that cannot be taken back waits for this. False when a hook refused.
 */
export async function runQuitHooks(): Promise<boolean> {
  for (const hook of [...hooks]) {
    if (!(await hook())) return false;
  }
  return true;
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
