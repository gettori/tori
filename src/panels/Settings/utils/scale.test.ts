import { describe, expect, it } from "vitest";
import { editorFontSizePx, terminalFontSizePx, uiScale } from "./scale";

describe("uiScale (chrome multiplier)", () => {
  it("rests at 1.0 at the 15px default", () => {
    // The whole point of the rebaseline: at the default UI size with no zoom,
    // every calc(<base> * var(--ui-scale)) token renders its authored px.
    expect(uiScale(15, 1)).toBe(1);
  });

  it("scales linearly with the UI font size", () => {
    expect(uiScale(30, 1)).toBe(2);
    expect(uiScale(7.5, 1)).toBe(0.5);
  });

  it("folds zoom exactly once (no double-application)", () => {
    expect(uiScale(15, 1.2)).toBeCloseTo(1.2, 10);
    // A larger base and a zoom compound multiplicatively, not additively.
    expect(uiScale(18, 1.5)).toBeCloseTo((18 / 15) * 1.5, 10);
  });
});

describe("editorFontSizePx (independent of chrome)", () => {
  it("is the editor's own size, untouched by the UI baseline", () => {
    expect(editorFontSizePx(15, 1)).toBe(15);
    expect(editorFontSizePx(13, 1)).toBe(13);
  });

  it("folds zoom and nothing else", () => {
    expect(editorFontSizePx(15, 2)).toBe(30);
  });
});

describe("terminalFontSizePx (independent, integer grid)", () => {
  it("is the terminal's own size × zoom, rounded to a whole pixel", () => {
    expect(terminalFontSizePx(15, 1)).toBe(15);
    expect(terminalFontSizePx(13, 1.1)).toBe(Math.round(13 * 1.1)); // 14
  });
});
