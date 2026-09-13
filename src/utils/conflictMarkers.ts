// Read from the text rather than the stages `conflict.ts` uses, because the
// reader may already have half resolved the file by hand.

import type { LineRange } from "./conflict";

export type MarkerConflict = {
  // The marker lines, 1-based. `base` is the `|||||||` line diff3 adds.
  markers: { start: number; base: number | null; split: number; end: number };
  current: LineRange;
  base: LineRange | null;
  incoming: LineRange;
};

type Lines = { readonly lines: number; line(n: number): { readonly text: string } };

// Exactly seven, git's default, then a label or nothing, so "========" is
// content. A file given a wider `conflict-marker-size` attribute is not read.
const marker = (text: string, char: string) =>
  text.startsWith(char.repeat(7)) && (text.length === 7 || text[7] === " ");

export function parseMarkers(doc: Lines): MarkerConflict[] {
  const out: MarkerConflict[] = [];
  let start = 0;
  let base: number | null = null;
  let split = 0;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    // A second start before an end means the first was never closed, which is
    // a hand edit gone wrong rather than a conflict to paint.
    if (marker(text, "<")) {
      [start, base, split] = [n, null, 0];
    } else if (!start) {
      continue;
    } else if (!split && base === null && marker(text, "|")) {
      base = n;
    } else if (!split && text === "=======") {
      split = n;
    } else if (split && marker(text, ">")) {
      out.push({
        markers: { start, base, split, end: n },
        current: { from: start + 1, to: base ?? split },
        base: base === null ? null : { from: base + 1, to: split },
        incoming: { from: split + 1, to: n },
      });
      [start, base, split] = [0, null, 0];
    } else if (!split && marker(text, ">")) {
      [start, base] = [0, null];
    }
  }
  return out;
}
