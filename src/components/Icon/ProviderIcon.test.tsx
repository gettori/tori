import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { Dynamic } from "solid-js/web";
import { providerIcon } from "./ProviderIcon";

/** The brand marks are filled paths; every Lucide glyph is `fill="none"` and
 *  stroked. That one attribute is the whole difference, and it is stable. */
function isBrandMark(model: string | null, agentId?: string): boolean {
  const { container, unmount } = render(() => (
    <Dynamic component={providerIcon(model, agentId)} />
  ));
  const fill = container.querySelector("svg")?.getAttribute("fill");
  unmount();
  return fill === "currentColor";
}

describe("providerIcon", () => {
  it("marks a model whose id names Anthropic, however it is spelled", () => {
    expect(isBrandMark("claude-opus-4-6-20260514")).toBe(true);
    expect(isBrandMark("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(isBrandMark("us.anthropic.claude-haiku-4-5")).toBe(true);
  });

  it("falls back to the generic glyph for a model that is someone else's", () => {
    expect(isBrandMark("gpt-5")).toBe(false);
    expect(isBrandMark("google/gemini-3-pro")).toBe(false);
    expect(isBrandMark("qwen/qwen3.6-plus")).toBe(false);
  });

  // A session before its first `system/init` has no model id to read, and the
  // pill still has to draw something; the adapter is what we know then.
  it("uses the adapter when no model has been reported yet", () => {
    expect(isBrandMark(null, "claude")).toBe(true);
    expect(isBrandMark("", "claude")).toBe(true);
    expect(isBrandMark(null, "opencode")).toBe(false);
    expect(isBrandMark(null)).toBe(false);
  });

  // A short alias names the model without naming the vendor, so the adapter
  // decides - but only where the id has not already named another vendor.
  it("lets the adapter answer for an alias, not for another vendor's model", () => {
    expect(isBrandMark("opus", "claude")).toBe(true);
    expect(isBrandMark("sonnet-4.6", "claude")).toBe(true);
    expect(isBrandMark("gpt-5-codex", "claude")).toBe(false);
  });
});
