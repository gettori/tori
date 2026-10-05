// Bare-letter keys on a surface, and the one guard they cannot ship without.
//
// Every app-wide hotkey in Tori carries a modifier (`commands.ts` has no bare
// key in it), so nothing until now had to answer "is this person typing". A
// review surface does: `j`/`k` through the panel's files and `n`/`p` between a
// diff's conversations are single letters, and every one of those surfaces also
// holds a text box. A reply, a comment, a summary and a branch name are all
// typed inside the element the handler is attached to, so an unguarded `n` is a
// key that jumps the page while somebody is writing the word "not".
//
// Hence two rules, both here rather than at each call site:
//
//   * **A modifier means it is not ours.** Cmd+J, Ctrl+P and Alt+N belong to
//     the app, the browser or the OS, and a surface that matched on `e.key`
//     alone would swallow them.
//   * **A typing target means it is not ours.** An input, a textarea, a select
//     or anything `contenteditable` gets the key, always.
//
// The focus step is here for the same reason: the panel walks file rows and a
// diff tab walks conversation cards, which is one rule about "the next element
// matching a selector", and two copies of it are two places for the clamp to be
// wrong.

/** Whether the key event is a bare press of one of these keys, meant for the
 *  surface rather than for the app or for a text box the reader is in. */
export function bareKey(e: KeyboardEvent, ...keys: string[]): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (!keys.includes(e.key)) return false;
  return !typingIn(e.target);
}

/** Whether this event target is somewhere text is being entered. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Move focus one step through the elements matching `selector` inside
 * `container`, and say whether it actually moved.
 *
 * Clamped rather than wrapped. A list that jumps from its last row to its first
 * gives a reader holding `j` no way to feel the end, and the end of a review is
 * a fact worth arriving at. With nothing in the list focused yet, a step
 * forward starts at the top and a step back starts at the bottom, so the first
 * press always lands somewhere.
 *
 * **False means the focus is where it was**, at one end or with nothing to step
 * through, which is what lets a caller that has more to offer than these
 * elements go and find it.
 */
export function stepFocus(container: Element, selector: string, delta: 1 | -1): boolean {
  const all = [...container.querySelectorAll<HTMLElement>(selector)];
  if (!all.length) return false;
  const from = all.indexOf(document.activeElement as HTMLElement);
  const to = from < 0 ? (delta === 1 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, from + delta));
  if (to === from) return false;
  all[to].focus();
  return true;
}

/**
 * The keydown handler a surface puts on its root to wire a pair of bare keys to
 * a focus step, for the surfaces whose whole answer is the step.
 *
 * The container is read per press rather than captured, because a `ref` is
 * assigned after the handler is built.
 */
export function stepKeys(
  container: () => Element | undefined,
  selector: string,
  forward: string,
  back: string,
): (e: KeyboardEvent) => void {
  return (e) => {
    const root = container();
    if (!root || !bareKey(e, forward, back)) return;
    if (stepFocus(root, selector, e.key === forward ? 1 : -1)) e.preventDefault();
  };
}
