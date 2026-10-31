/** Run `fn` once two frames have been drawn: for work a click causes but the
 *  user is not looking at, so it cannot hold back the frame that shows what
 *  they clicked. */
export function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(fn, 0)));
}
