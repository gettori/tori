// What a fresh chat can know before its first turn ends.
//
// A `.tsx` file for the DOM project, which is the one with a `localStorage`:
// the whole point of this module is that the answer survives the session that
// measured it.
import { describe, expect, it, beforeEach } from "vite-plus/test";
import { rememberWindows, rememberedWindows } from "./contextWindowMemory";
import { contextWindowFor } from "./chatModels";

beforeEach(() => localStorage.clear());

describe("remembering a measured context window", () => {
  it("has nothing to say before anything has been measured", () => {
    expect(rememberedWindows()).toEqual({});
  });

  it("gives the next session the figure the last one reported", () => {
    rememberWindows({ "claude-sonnet-5": 1_000_000 });
    expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
  });

  // The running session always wins: this is a head start, never an answer.
  it("yields to what the running session reports", () => {
    rememberWindows({ "claude-sonnet-5": 200_000 });
    expect(contextWindowFor("claude-sonnet-5", { "claude-sonnet-5": 1_000_000 })).toBe(1_000_000);
  });

  it("merges rather than replaces, so a turn cannot forget the other models", () => {
    rememberWindows({ "claude-opus-5": 1_000_000 });
    rememberWindows({ "claude-haiku-4-5": 200_000 });
    expect(rememberedWindows()).toEqual({ "claude-opus-5": 1_000_000, "claude-haiku-4-5": 200_000 });
  });

  it("refuses a figure that is not a window", () => {
    rememberWindows({ a: 0, b: -1, c: Number.NaN as number });
    expect(rememberedWindows()).toEqual({});
  });

  it("survives a store holding something that is not a map of windows", () => {
    localStorage.setItem("tori.contextWindows.v1", '["not", "a", "map"]');
    expect(rememberedWindows()).toEqual({});
    localStorage.setItem("tori.contextWindows.v1", "{oh dear");
    expect(rememberedWindows()).toEqual({});
  });
});
