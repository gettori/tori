// What a `mermaid` fence does when mermaid is not the thing under test: the
// engine is mocked, because the real one measures text through `getBBox`, which
// jsdom does not implement. What is left is the contract the component owes
// either way - draw when there is a diagram, show the source when there is not,
// and never leave the fence's own text unreachable.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import Diagram from "./Diagram";

const SVG = '<svg role="img" aria-label="a flowchart"><g></g></svg>';
const FLOW = "flowchart TD\n  a --> b";

vi.mock("../../utils/mermaidEngine", () => ({
  configure: vi.fn(),
  render: vi.fn(async () => SVG),
}));
import { configure, render as draw } from "../../utils/mermaidEngine";
import { emit, THEME_APPLIED } from "../../utils/events";

beforeEach(() => {
  vi.mocked(configure).mockClear();
  vi.mocked(draw).mockReset();
  vi.mocked(draw).mockResolvedValue(SVG);
});

describe("a mermaid fence", () => {
  it("draws the SVG the engine returns", async () => {
    const { container } = render(() => <Diagram code={FLOW} />);
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
    expect(vi.mocked(draw).mock.calls[0][0]).toBe(FLOW);
  });

  it("shows the source when the fence does not parse as a diagram", async () => {
    // The streaming case as much as the broken one: half a diagram is not a
    // diagram, and the half that has arrived is still worth reading.
    vi.mocked(draw).mockResolvedValue(null);
    const { container } = render(() => <Diagram code={"flowchart TD\n  a --"} />);
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toBe("flowchart TD\n  a --");
  });

  it("shows the source when the engine itself cannot be reached", async () => {
    // A failed chunk load must not swallow the fence: the source is the
    // fallback rendering anyway, so it is what a missing megabyte degrades to.
    vi.mocked(draw).mockRejectedValue(new Error("chunk load failed"));
    const { container } = render(() => <Diagram code={FLOW} />);
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toBe(FLOW);
  });

  it("redraws on a theme switch, because the palette is baked into the SVG", async () => {
    const { container } = render(() => <Diagram code={FLOW} />);
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());

    emit(THEME_APPLIED);

    // Re-seeded and re-drawn: the colours mermaid derives from live in the
    // markup it already returned, so nothing repaints without a second pass.
    await waitFor(() => expect(vi.mocked(draw)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(configure)).toHaveBeenCalledTimes(2);
  });

  it("has no axe violations", async () => {
    const { container } = render(() => <Diagram code={FLOW} />);
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
    await expectNoAxeViolations(container);
  });
});
