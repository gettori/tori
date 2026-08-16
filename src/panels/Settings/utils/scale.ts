// The chrome sizing formula, factored out of settingsStore so it is unit-testable
// without the DOM, localStorage, or the Tauri bridge the store pulls in at load.
//
// One multiplier drives the whole chrome: the chosen UI font size over the 15px
// design baseline, times the global zoom. It rests at 1.0 at the 15px default,
// so every `calc(<base> * var(--ui-scale))` token renders its authored px. The
// editor and terminal are deliberately independent: they keep their own px size,
// folding only zoom, so their sliders never move the surrounding chrome.

/** The value written to --ui-scale: UI font size over the 15px baseline × zoom. */
export function uiScale(uiFontSize: number, zoom: number): number {
  return (uiFontSize / 15) * zoom;
}

/** The editor's font size in px: its own setting × zoom (independent of chrome). */
export function editorFontSizePx(editorFontSize: number, zoom: number): number {
  return editorFontSize * zoom;
}

/** The terminal's font size in px: its own setting × zoom, rounded to a whole
 *  pixel (xterm renders on an integer cell grid). */
export function terminalFontSizePx(terminalFontSize: number, zoom: number): number {
  return Math.round(terminalFontSize * zoom);
}
