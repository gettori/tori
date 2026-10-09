// The glyph resolves a logo or it does not, and what it does when it does not
// is the whole point: an initial, never a borrowed mark and never a hole.
import { describe, it, expect, vi } from "vite-plus/test";
import { render } from "@solidjs/testing-library";
import AgentGlyph from "./AgentGlyph";
import { FALLBACK_ADAPTERS, reloadAdapters } from "../../utils/agents";

const KITE_ICON = "/Users/me/.config/tori/packs/icons/kite.svg";
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
  invoke: async (cmd: string) =>
    cmd === "list_agents"
      ? [
          ...FALLBACK_ADAPTERS,
          { ...FALLBACK_ADAPTERS[0], id: "kite", label: "Kite", icon: null, icon_file: KITE_ICON },
          { ...FALLBACK_ADAPTERS[0], id: "wren", label: "Wren", icon: null, icon_file: null },
        ]
      : null,
}));

const svgIn = (el: HTMLElement) => el.querySelector("svg");
const textIn = (el: HTMLElement) => el.textContent?.trim();

describe("AgentGlyph", () => {
  it("draws the mark for an agent Tori has a logo for", () => {
    const { container } = render(() => <AgentGlyph id="claude" label="Claude" />);
    expect(svgIn(container)).toBeTruthy();
    expect(textIn(container)).toBe("");
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

  // A pack's icon is a mask, so nothing from the file is ever parsed into the
  // page: no <svg> appears, only a span whose mask points at the asset URL.
  it("draws a pack's icon as a mask, never as inline markup", async () => {
    await reloadAdapters();
    const { container } = render(() => <AgentGlyph id="kite" label="Kite" />);
    expect(svgIn(container)).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(textIn(container)).toBe("");
    const masked = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(masked.style.getPropertyValue("--icon")).toBe(`url("asset://localhost/${encodeURIComponent(KITE_ICON)}")`);
  });

  it("prefers a bundled mark to a pack's icon, and the initial to nothing", async () => {
    await reloadAdapters();
    expect(svgIn(render(() => <AgentGlyph id="claude" label="Claude" />).container)).toBeTruthy();
    const wren = render(() => <AgentGlyph id="wren" label="Wren" />).container;
    expect(textIn(wren)).toBe("W");
  });

  // Decoration beside a name that is already on the row: announcing it would
  // read the agent's name twice.
  it("is hidden from the accessibility tree", () => {
    const { container } = render(() => <AgentGlyph id="claude" label="Claude" />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
