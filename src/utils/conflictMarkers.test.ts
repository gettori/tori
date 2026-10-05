import { describe, it, expect } from "vite-plus/test";
import { Text } from "@codemirror/state";
import { parseMarkers } from "./conflictMarkers";

const doc = (lines: string[]) => Text.of(lines);

describe("reading conflict markers", () => {
  it("reads a plain conflict into current and incoming", () => {
    const blocks = parseMarkers(
      doc(["one", "<<<<<<< HEAD", "ours", "=======", "theirs", "more", ">>>>>>> feature", "two"]),
    );

    expect(blocks).toEqual([
      {
        markers: { start: 2, base: null, split: 4, end: 7 },
        current: { from: 3, to: 4 },
        base: null,
        incoming: { from: 5, to: 7 },
      },
    ]);
  });

  it("reads diff3's base section between the two sides", () => {
    const blocks = parseMarkers(
      doc(["<<<<<<< HEAD", "ours", "||||||| merged common ancestors", "base", "=======", "theirs", ">>>>>>> feature"]),
    );

    expect(blocks).toEqual([
      {
        markers: { start: 1, base: 3, split: 5, end: 7 },
        current: { from: 2, to: 3 },
        base: { from: 4, to: 5 },
        incoming: { from: 6, to: 7 },
      },
    ]);
  });

  it("paints nothing for a conflict that never closes, and still reads the next one", () => {
    const blocks = parseMarkers(
      doc(["<<<<<<< HEAD", "lost", "=======", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> x", "<<<<<<< HEAD", "tail"]),
    );

    expect(blocks.map((b) => b.markers)).toEqual([{ start: 4, base: null, split: 6, end: 8 }]);
  });

  it("does not take a line that only starts with seven equals signs for the separator", () => {
    const blocks = parseMarkers(
      doc(["<<<<<<< HEAD", "======== heading", "======= not a split", "ours", "=======", "theirs", ">>>>>>> x"]),
    );

    expect(blocks.map((b) => b.markers)).toEqual([{ start: 1, base: null, split: 5, end: 7 }]);
    expect(blocks[0].current).toEqual({ from: 2, to: 5 });
  });
});
