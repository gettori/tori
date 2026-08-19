// A store write that leaves the click frame. `localStorage.setItem` is
// synchronous and these writers stringify every workspace, so running one
// inside a click spends the frame the click was meant to paint.

/** Pending flushes, so one lifecycle event lands every deferred store at once. */
const pending = new Set<() => void>();
let installed = false;

// A debounced write that never lands is data loss, so every way the window can
// go away flushes first. The quit path calls `flushDeferredWrites` itself:
// `getCurrentWindow().destroy()` skips `beforeunload`.
function install() {
  if (installed) return;
  installed = true;
  addEventListener("beforeunload", flushDeferredWrites);
  addEventListener("pagehide", flushDeferredWrites);
  addEventListener("blur", flushDeferredWrites);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDeferredWrites();
  });
}

export function flushDeferredWrites() {
  for (const flush of [...pending]) flush();
}

export type DeferredWrite = {
  /** Ask for the write. Repeated calls inside the window cost nothing extra. */
  schedule: () => void;
  /** Run a pending write now. A no-op when nothing is pending. */
  flush: () => void;
  /** Drop a pending write unrun (a model reset is about to replace its state). */
  cancel: () => void;
};

/** Wrap a synchronous store write so callers can fire it per click and it lands
 *  once, after the frame. */
export function deferredWrite(write: () => void, delayMs = 250): DeferredWrite {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer === undefined) return false;
    clearTimeout(timer);
    timer = undefined;
    pending.delete(flush);
    return true;
  };
  function flush() {
    if (clear()) write();
  }
  return {
    schedule() {
      if (timer !== undefined) return;
      install();
      pending.add(flush);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel: clear,
  };
}
