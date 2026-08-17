/**
 * Run `requestAnimationFrame` callbacks synchronously, for a test that needs a
 * measurement to have happened before it looks.
 *
 * `OverflowTabBar` seeds its visible count from the item list it was created
 * with, which in a panel that opens tabs later is empty, and corrects it in an
 * `onMount` frame. jsdom does run that frame, but asynchronously, so a
 * synchronous query right after the render sees the seed rather than the
 * measurement: no drawn tabs at all. This makes the correction land in time.
 *
 * It lives here rather than in the editor agent because the terminal strip
 * needs it too, and both strips are about to need it again when they move onto
 * Kobalte Tabs (skarif2/sway#111). An async `waitFor`/`findBy` around the
 * lookup is the alternative, and is better when the test is already async.
 */
export function installAnimationFrame(): void {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;
}
