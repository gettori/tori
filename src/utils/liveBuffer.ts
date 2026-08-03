// What a sibling surface may learn about an open buffer: its current text, and
// where the user was last looking at it.
//
// The markdown preview and the source view are two renderings of one file, but
// only one of them owns the buffer. `docOf` is internal to CodeEditor, so the
// preview used to read the file from disk instead, which is a different
// document the moment anything is unsaved. The editor publishes here, the
// preview reads back - the same shape the Problems list already uses.
//
// This module must stay free of runtime CodeMirror imports. `Editor.tsx` and
// `MarkdownPreview.tsx` import it eagerly, so a `@codemirror/*` value import
// here would pull the editor's dependency graph into the startup chunk and
// defeat the lazy boundary around CodeEditor.

import { createSignal } from "solid-js";

/** Files with a rendered second view worth publishing text for. Deliberately
 *  narrow: the store holds whole documents, so it holds only the ones a
 *  consumer exists for. SVG previews render the file itself through the asset
 *  protocol and never ask for its text. */
export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

// ---- text --------------------------------------------------------------

const [texts, setTexts] = createSignal<Record<string, string>>({});

/** The buffer's own reading of a file, or undefined when no buffer holds it
 *  (a restored tab nobody has focused yet), which is the caller's cue to fall
 *  back to disk. */
export function bufferTextOf(path: string): string | undefined {
  return texts()[path];
}

export function publishBufferText(path: string, text: string): void {
  setTexts((prev) => (prev[path] === text ? prev : { ...prev, [path]: text }));
}

// ---- scroll handoff ----------------------------------------------------

/** Which of a file's two views wrote the position down. */
export type Side = "source" | "preview";

// One pending handoff per file, and it is only ever read by the *other* side.
// Not a general scroll memory: a fraction the source view left behind is for
// the preview to pick up, and returning to the source by any other route (a tab
// swap, a reopen) still lands on the cursor, which is where it was before this
// existed.
const handoffs = new Map<string, { from: Side; fraction: number }>();

export function handOff(path: string, from: Side, fraction: number): void {
  handoffs.set(path, { from, fraction: Math.min(Math.max(fraction, 0), 1) });
}

/** Consume a position the other side left, if it left one. Reading it clears
 *  it, so a second mount with nothing in between opens where it was told to,
 *  not where the file was a toggle ago. */
export function takeHandOff(path: string, to: Side): number | undefined {
  const held = handoffs.get(path);
  if (!held || held.from === to) return undefined;
  handoffs.delete(path);
  return held.fraction;
}

/** How far down a scroll container is, or undefined when it has nothing to
 *  scroll (or has not been laid out, which is every element under jsdom). */
export function scrollFraction(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number | undefined {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return undefined;
  return Math.min(Math.max(scrollTop / max, 0), 1);
}

/** The 1-based line a fraction points at. The source side scrolls by line
 *  rather than by pixel: the preview's height is rendered HTML and shares no
 *  units with the editor, so proportional is the most the two can agree on. */
export function lineAtFraction(fraction: number, lines: number): number {
  if (lines <= 1) return 1;
  const line = Math.round(Math.min(Math.max(fraction, 0), 1) * (lines - 1)) + 1;
  return Math.min(Math.max(line, 1), lines);
}

/** The other direction, for the source view to describe where it just landed
 *  when it landed on a cursor rather than on a handed-over position. Without
 *  it a position from before a tab swap stays pending, and the next preview
 *  opens where the file was two swaps ago. */
export function fractionOfLine(line: number, lines: number): number {
  if (lines <= 1) return 0;
  return Math.min(Math.max((line - 1) / (lines - 1), 0), 1);
}

// ---- lifecycle ---------------------------------------------------------

/** Forget a file entirely, called when its tab closes. Same bound as the
 *  Problems store: open tabs only, so neither grows for a session. */
export function dropLiveBuffer(path: string): void {
  handoffs.delete(path);
  setTexts((prev) => {
    if (!(path in prev)) return prev;
    const next = { ...prev };
    delete next[path];
    return next;
  });
}

/** Drop everything. Not called in the app: switching project does not close
 *  the tabs of the workspace being left (CodeEditor keeps their buffers alive
 *  on purpose), so there is no moment where every entry here has stopped being
 *  true. `dropLiveBuffer` on tab close is the whole of the bound. Kept for
 *  tests, which need one store shared across a file to start each case empty. */
export function clearLiveBuffers(): void {
  handoffs.clear();
  setTexts({});
}
