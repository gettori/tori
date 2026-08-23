import { describe, it, expect, vi } from "vitest";
import { cappedHtml, highlightedHtml, HIGHLIGHT_MAX } from "./highlight";

// The real engine is shiki, imported lazily and asynchronously. What is under
// test here is the policy in front of it, so the engine is a stub that always
// answers.
vi.mock("./shikiEngine", () => ({
  init: async () => {},
  canHighlight: () => true,
  isLoaded: () => true,
  loadLang: async () => {},
  toHtml: (code: string) => `<span>${code}</span>`,
}));

describe("the highlighting cap", () => {
  it("paints a block once the engine is in, and never one this big", async () => {
    // The first call is what asks for the engine, so it answers plain.
    expect(highlightedHtml("const x = 1;", "ts")).toBeNull();
    await vi.waitFor(() => expect(highlightedHtml("const x = 1;", "ts")).not.toBeNull());

    expect(cappedHtml("const x = 1;", "ts")).toBe("<span>const x = 1;</span>");
    // 200 KB of anything is pasted output, not code being read, and the pass
    // over it would be the one thing on this path worth feeling.
    expect(cappedHtml("x".repeat(200_000), "ts")).toBeNull();
    expect(HIGHLIGHT_MAX).toBeLessThan(200_000);
  });
});
