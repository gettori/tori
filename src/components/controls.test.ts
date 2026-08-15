import { describe, expect, it } from "vitest";
import { nextSegmentIndex } from "./controls";

describe("nextSegmentIndex (Settings tab-strip roving nav)", () => {
  it("steps forward with Right/Down and wraps past the end", () => {
    expect(nextSegmentIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextSegmentIndex(1, "ArrowDown", 3)).toBe(2);
    expect(nextSegmentIndex(2, "ArrowRight", 3)).toBe(0);
  });

  it("steps back with Left/Up and wraps past the start", () => {
    expect(nextSegmentIndex(2, "ArrowLeft", 3)).toBe(1);
    expect(nextSegmentIndex(1, "ArrowUp", 3)).toBe(0);
    expect(nextSegmentIndex(0, "ArrowLeft", 3)).toBe(2);
  });

  it("jumps to the ends with Home/End", () => {
    expect(nextSegmentIndex(1, "Home", 3)).toBe(0);
    expect(nextSegmentIndex(1, "End", 3)).toBe(2);
  });

  it("leaves the index unchanged for other keys or an empty group", () => {
    expect(nextSegmentIndex(1, "Enter", 3)).toBe(1);
    expect(nextSegmentIndex(0, "ArrowRight", 0)).toBe(0);
  });
});
