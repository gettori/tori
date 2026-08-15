// Shared control primitives vocabulary. Kept DOM-free so the logic here is
// unit-testable under the node-env vitest (see scale.ts for the same split).

/** The three control sizes, each mapping to a fixed --control-height* token. */
export type ControlSize = "md" | "sm" | "xs";

/** Roving-tabindex arrow navigation for a horizontal group (the Settings tab
 *  strip; the segmented control gets the same movement from Kobalte).
 *  Left/Up step back, Right/Down step forward, Home/End jump to the ends; the
 *  index wraps. Any other key returns the current index unchanged (no move).
 *  Pure so it can be tested without a DOM. */
export function nextSegmentIndex(current: number, key: string, count: number): number {
  if (count <= 0) return current;
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}
