const FALLBACK_MS = 600;

/** A CSS animation replays whenever its pane is shown again, so the class comes
 *  off when it ends (or after `FALLBACK_MS`, if no end is ever reported), and an
 *  element created inside a hidden pane never gets it. */
export function enterOnce(el: HTMLElement, className: string): void {
  // Called from refs, which cannot own a primitive on 2.0, and the element is
  // only in the document once the render returns. Runs before the next paint.
  queueMicrotask(() => {
    if (el.getClientRects().length === 0) return;
    const finish = () => {
      clearTimeout(timer);
      el.removeEventListener("animationend", onEnd);
      el.removeEventListener("animationcancel", onEnd);
      el.classList.remove(className);
    };
    const onEnd = (e: AnimationEvent) => {
      if (e.target === el) finish();
    };
    const timer = setTimeout(finish, FALLBACK_MS);
    el.addEventListener("animationend", onEnd);
    el.addEventListener("animationcancel", onEnd);
    el.classList.add(className);
  });
}
