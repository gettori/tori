import { describe, expect, it } from "vite-plus/test";
import { compactAge, compactAgo } from "./compactAge";

describe("compactAge", () => {
  const now = 400 * 24 * 60 * 60;

  it.each([
    [3, "3s"],
    [3 * 60, "3m"],
    [3 * 60 * 60, "3h"],
    [3 * 24 * 60 * 60, "3d"],
    [3 * 7 * 24 * 60 * 60, "3w"],
    [3 * 30 * 24 * 60 * 60, "3M"],
    [365 * 24 * 60 * 60, "1Y"],
  ])("formats an age of %i seconds as %s", (seconds, expected) => {
    expect(compactAge(now - seconds, now)).toBe(expected);
  });

  it("uses the same units in prose", () => {
    expect(compactAgo(now - 3 * 30 * 24 * 60 * 60, now)).toBe("3M ago");
  });
});
