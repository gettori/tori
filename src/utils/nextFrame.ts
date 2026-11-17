/**
 * Run `fn` once, on the next animation frame or after a short timer, whichever
 * comes first. The timer is for a window that is not being drawn (occluded, or
 * a test DOM that serves no frames): work queued for the frame must not wait on
 * someone looking at it.
 */
export function nextFrame(fn: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fn();
  };
  const timer = setTimeout(once, 50);
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    clearTimeout(timer);
    once();
  });
}
