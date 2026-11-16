import { onCleanup, onMount } from "solid-js";

const FALLBACK_MS = 600;

/** A CSS animation replays whenever its pane is shown again, so the class comes
 *  off when it ends (or after `FALLBACK_MS`, if no end is ever reported), and an
 *  element created inside a hidden pane never gets it. */
export function enterOnce(el: HTMLElement, className: string): void {
  onMount(() => {
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
    onCleanup(finish);
  });
}
