// The engine's own half of a diagram: what it hands mermaid, and what it hands
// back. Mermaid itself is mocked, so the seeds are sentinel strings rather than
// colours - which is also what keeps the token guard happy about a file in src/.
//
// `.tsx` for the extension alone. It needs no JSX; it needs the jsdom that the
// extension selects (see vitest.config.ts), because every seed it passes is read
// off `getComputedStyle`.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The two result shapes mermaid's own types insist on, so a mock cannot drift
// from the API it stands in for.
const PARSED = { diagramType: "flowchart", config: {} };

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => PARSED),
    render: vi.fn(async () => ({ svg: "<svg></svg>", diagramType: "flowchart" })),
  },
}));
import mermaid from "mermaid";
import { configure, render } from "./mermaidEngine";

const FLOW = "flowchart TD\n  a --> b";

// One sentinel per token, so a seed wired to the wrong role reads as a swap
// rather than as two colours that happen to look alike.
const TOKENS: Record<string, string> = {
  "--canvas-default": "canvas-default",
  "--canvas-card": "canvas-card",
  "--canvas-head": "canvas-head",
  "--canvas-input": "canvas-input",
  "--fg-default": "fg-default",
  "--fg-muted": "fg-muted",
  "--fg-subtle": "fg-subtle",
  "--sway-font-ui": "the-ui-font",
};

function paint(tokens: Record<string, string> = TOKENS) {
  const root = document.documentElement;
  root.removeAttribute("style");
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
}

/** The config of the most recent `initialize`. */
function lastConfig() {
  const calls = vi.mocked(mermaid.initialize).mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.mocked(mermaid.initialize).mockClear();
  vi.mocked(mermaid.parse).mockClear();
  vi.mocked(mermaid.parse).mockResolvedValue(PARSED);
  vi.mocked(mermaid.render).mockClear();
  vi.mocked(mermaid.render).mockResolvedValue({ svg: "<svg></svg>", diagramType: "flowchart" });
  document.documentElement.dataset.theme = "dark";
  paint();
});

describe("seeding mermaid from the token layer", () => {
  it("maps every seed onto the role it is meant to read", () => {
    configure();
    expect(lastConfig().themeVariables).toEqual({
      background: "canvas-default",
      primaryColor: "canvas-card",
      primaryTextColor: "fg-default",
      primaryBorderColor: "fg-subtle",
      secondaryColor: "canvas-head",
      tertiaryColor: "canvas-input",
      lineColor: "fg-muted",
      textColor: "fg-default",
      titleColor: "fg-default",
    });
    expect(lastConfig().fontFamily).toBe("the-ui-font");
  });

  it("leaves an unpainted token out rather than passing it empty", () => {
    // Mermaid does colour maths on these. Its own default renders; an empty
    // string throws inside khroma and takes the whole diagram with it.
    paint({ "--fg-default": "fg-default" });
    configure();
    expect(lastConfig().themeVariables).toEqual({
      primaryTextColor: "fg-default",
      textColor: "fg-default",
      titleColor: "fg-default",
    });
    expect(lastConfig().fontFamily).toBeUndefined();
  });

  it("follows the appearance the theme layer is painting", () => {
    // The base theme derives its whole palette differently on each side, so a
    // light theme seeded as dark comes out legible but wrong.
    document.documentElement.dataset.theme = "light";
    configure();
    expect(lastConfig().darkMode).toBe(false);
    document.documentElement.dataset.theme = "dark";
    configure();
    expect(lastConfig().darkMode).toBe(true);
  });

  it("keeps mermaid's own sanitizer on, and its error graphic off", () => {
    // Strict mode is what DOMPurifies the SVG that goes into innerHTML, since
    // ours would strip the <style> the diagram's colours live in.
    configure();
    expect(lastConfig().securityLevel).toBe("strict");
    // Without this a bad fence injects mermaid's error picture into the page,
    // instead of the caller showing the source.
    expect(lastConfig().suppressErrorRendering).toBe(true);
    expect(lastConfig().startOnLoad).toBe(false);
  });
});

describe("rendering a diagram", () => {
  it("hands back the SVG mermaid drew", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({ svg: "<svg id='drawn'></svg>", diagramType: "flowchart" });
    expect(await render(FLOW)).toBe("<svg id='drawn'></svg>");
  });

  it("gives every render its own id, so two diagrams cannot collide", async () => {
    await render(FLOW);
    await render(FLOW);
    const ids = vi.mocked(mermaid.render).mock.calls.map((c) => c[0]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("answers null for a source that is not a diagram yet", async () => {
    vi.mocked(mermaid.parse).mockResolvedValue(false as never);
    expect(await render("flowchart TD\n  a --")).toBeNull();
    // Never drawn: a half-written fence must not reach the renderer at all.
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("answers null rather than throwing when mermaid fails mid-render", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error("no layout"));
    expect(await render(FLOW)).toBeNull();
  });
});
