import { describe, expect, it } from "vite-plus/test";
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
    expect(isBrandMark(null, "some-other-agent")).toBe(false);
    expect(isBrandMark(null)).toBe(false);
  });

  // A short alias names the model without naming the vendor, so the adapter
  // decides - but only where the id has not already named another vendor.
  it("lets the adapter answer for an alias, not for another vendor's model", () => {
    expect(isBrandMark("opus", "claude")).toBe(true);
    expect(isBrandMark("sonnet-4.6", "claude")).toBe(true);
    expect(isBrandMark("gpt-5-codex", "claude")).toBe(false);
  });

  /**
   * **The case the vendor guard used to get backwards.**
   *
   * It read "any model naming a vendor other than Anthropic keeps the generic
   * glyph", so a Codex session - which runs `gpt-*` by definition - lost the
   * Codex mark on every model it has. The guard fired on the one pairing it was
   * never written about.
   *
   * Contradiction takes two vendor claims. `codex` is OpenAI's, so a `gpt` id
   * agrees with it and the mark stands; `claude` is Anthropic's, so the same id
   * disagrees and the mark goes (the test above).
   */
  it("keeps an agent's mark for a model of the vendor that agent is", () => {
    expect(isBrandMark("gpt-5.6-terra", "codex")).toBe(true);
    expect(isBrandMark("gpt-5.4-mini", "codex")).toBe(true);
    expect(isBrandMark("gemini-3-pro", "gemini")).toBe(true);

    // And the mismatch still loses its mark, from the other direction.
    expect(isBrandMark("claude-opus-5", "codex")).toBe(true); // Anthropic's own mark wins
    expect(isBrandMark("gemini-3-pro", "codex")).toBe(false);
  });

  /** A mark that is a tool's brand rather than a vendor's claims nothing about
   *  who answers, so no model id can contradict it. OpenCode runs whatever the
   *  user authenticated, and the pill should still say OpenCode. */
  it("keeps a tool's own mark whatever model it is running", () => {
    expect(isBrandMark("gpt-5.6", "opencode")).toBe(true);
    expect(isBrandMark("qwen/qwen3.6-plus", "opencode")).toBe(true);
  });
});
