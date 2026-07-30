/**
 * Waiting for a font before something measures it.
 *
 * **Why the terminal needs this and nothing else does.** CSS text reflows for
 * free when a webfont arrives: the browser repaints and the paragraph is
 * correct. xterm does not reflow - it measures one cell of the font once, lays
 * the whole grid on that measurement, and reports the resulting cols/rows to the
 * pty. Measure while the bundled Nerd Font is still loading and the grid is
 * built on the fallback's metrics, so every column is wrong and the shell has
 * been told a size that does not match what is on screen.
 *
 * So the terminal waits for the face it is about to measure. The wait is short -
 * the file is bundled, not fetched - and bounded, because a font that never
 * resolves must not leave a tab with no terminal in it.
 */

/** The first family in a CSS font stack, unquoted. Shared with Settings, which
 *  shows the same name in its input: two parsers would eventually disagree
 *  about a stack with quotes in it. */
export function primaryFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "");
}

/** Longest a measurement will wait on a font. Past this the grid is built on
 *  whatever is available: a terminal on the wrong metrics is a bad tab, a
 *  terminal that never appears is a broken app. */
const LOAD_TIMEOUT_MS = 2000;

/**
 * Resolve once `family` is usable at `sizePx`, or once waiting has cost more
 * than it is worth.
 *
 * Only the regular face is awaited. The grid is measured off it, and on a
 * monospace family bold and italic carry the same advance width by definition,
 * so they can arrive later without moving a single column. Bold is started
 * anyway, unawaited, so the first bold line is not the thing that fetches it.
 *
 * A platform font (`Menlo`, `SF Mono`) has nothing to load and `fonts.load`
 * resolves immediately, so this is not conditional on the family being bundled.
 */
export async function ensureFontLoaded(stack: string, sizePx: number): Promise<void> {
  const fonts = document.fonts;
  // jsdom has no FontFaceSet, and neither does an old webview. Nothing to wait
  // for is not an error - it is the pre-webfont behaviour, which was fine.
  if (!fonts?.load) return;
  const family = primaryFamily(stack);
  if (!family) return;
  const spec = /\s/.test(family) ? `"${family}"` : family;

  void fonts.load(`700 ${sizePx}px ${spec}`).catch(() => {});
  await Promise.race([
    fonts.load(`${sizePx}px ${spec}`).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS)),
  ]);
}
