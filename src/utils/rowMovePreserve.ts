// Scroll and focus across a keyed row move (plan phase 6, measured by the
// phase 1 spike): Solid moves a keyed `<For>` row by detach plus reattach,
// which resets plain-DOM scrollTop to 0 and drops DOM focus to body while the
// row's data is untouched. Any strip action that reorders a `<For>` holding
// live views wraps its write in this, so both are put back in the same task.
export function preserveScrollAndFocus<T>(scope: ParentNode, fn: () => T): T {
  const scrolled: { el: Element; top: number; left: number }[] = [];
  for (const el of scope.querySelectorAll("*")) {
    if (el.scrollTop || el.scrollLeft) scrolled.push({ el, top: el.scrollTop, left: el.scrollLeft });
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const result = fn();
  for (const s of scrolled) {
    if (!s.el.isConnected) continue;
    if (s.el.scrollTop !== s.top) s.el.scrollTop = s.top;
    if (s.el.scrollLeft !== s.left) s.el.scrollLeft = s.left;
  }
  if (focused && focused.isConnected && document.activeElement !== focused) focused.focus();
  return result;
}
