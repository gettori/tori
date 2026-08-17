// The glyph resolves a logo or it does not, and what it does when it does not
// is the whole point: an initial, never a borrowed mark and never a hole.
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import AgentGlyph from "./AgentGlyph";

const svgIn = (el: HTMLElement) => el.querySelector("svg");
const textIn = (el: HTMLElement) => el.textContent?.trim();

describe("AgentGlyph", () => {
  it("draws the mark for an agent Sway has a logo for", () => {
    const { container } = render(() => <AgentGlyph id="claude" label="Claude" />);
    expect(svgIn(container)).toBeTruthy();
    expect(textIn(container)).toBe("");
  });

  it("resolves a catalogue id through its alias", () => {
    const { container } = render(() => <AgentGlyph id="qwen-code" label="Qwen Code" />);
    expect(svgIn(container)).toBeTruthy();
  });

  it("falls back to the label's initial, not to another agent's mark", () => {
    const { container } = render(() => <AgentGlyph id="stakpak" label="Stakpak" />);
    expect(svgIn(container)).toBeNull();
    expect(textIn(container)).toBe("S");
  });

  // The id decides the mark and the label decides the fallback, so an agent
  // whose label starts differently from its id still reads correctly.
  it("takes the initial from the label rather than the id", () => {
    const { container } = render(() => <AgentGlyph id="factory-droid" label="Factory Droid" />);
    expect(textIn(container)).toBe("F");
  });

  // Sources normalize differently: Simple Icons inks the full 24x24, while a
  // mark taken from a plated set inks only the middle, so one `size` would mean
  // two sizes on screen. Codex's was measured at 18 units, inset 3 a side.
  it("crops a plated mark to its ink so every logo lands the same size", () => {
    const plated = render(() => <AgentGlyph id="codex" label="Codex" />);
    expect(svgIn(plated.container)?.getAttribute("viewBox")).toBe("3 3 18 18");
    const full = render(() => <AgentGlyph id="claude" label="Claude" />);
    expect(svgIn(full.container)?.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  // Decoration beside a name that is already on the row: announcing it would
  // read the agent's name twice.
  it("is hidden from the accessibility tree", () => {
    const { container } = render(() => <AgentGlyph id="claude" label="Claude" />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
