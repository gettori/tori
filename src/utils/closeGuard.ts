// What a quit has to get past before the window goes away.
//
// There is exactly one `onCloseRequested` listener in the app, and it lives in
// the editor: it is the panel with unsaved buffers to lose, and its `onMount` is
// where the window listeners already are. Two listeners cannot share a window,
// which is the reason this registry exists rather than a second handler. Tauri
// hands each listener its own event object and destroys the window after any
// handler that did not call `preventDefault` - so a panel with nothing to say
// about the quit would close it out from under the one still asking.
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
