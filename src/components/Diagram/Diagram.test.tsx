// What a `mermaid` fence does when mermaid is not the thing under test: the
// engine is mocked, because the real one measures text through `getBBox`, which
// jsdom does not implement. What is left is the contract the component owes
// either way - draw when there is a diagram, show the source when there is not,
// and never leave the fence's own text unreachable.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
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
    await waitFor(() => expect(vi.mocked(draw)).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toBe("flowchart TD\n  a --");
  });

  it("shows the source when the engine itself cannot be reached", async () => {
    // A failed chunk load must not swallow the fence: the source is the
    // fallback rendering anyway, so it is what a missing megabyte degrades to.
    vi.mocked(draw).mockRejectedValue(new Error("chunk load failed"));
    const { container } = render(() => <Diagram code={FLOW} />);
    await waitFor(() => expect(vi.mocked(draw)).toHaveBeenCalled());
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

describe("a mermaid fence off screen", () => {
  // An observer the test drives: nothing is on screen until `show` says so.
  const observed: { node: Element; cb: IntersectionObserverCallback }[] = [];
  class FakeObserver {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(node: Element) {
      observed.push({ node, cb: this.cb });
    }
    disconnect() {}
  }
  const show = (at: number) =>
    observed[at].cb([{ isIntersecting: true, target: observed[at].node } as IntersectionObserverEntry], {} as never);

  beforeEach(() => {
    observed.length = 0;
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    return () => vi.unstubAllGlobals();
  });

  it("draws nothing for ten diagrams out of view, and only the one scrolled to", async () => {
    const { container } = render(() => (
      <>
        {Array.from({ length: 10 }, () => (
          <Diagram code={FLOW} />
        ))}
      </>
    ));
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(draw)).not.toHaveBeenCalled();
    expect(container.querySelectorAll("pre")).toHaveLength(10);

    show(3);
    await waitFor(() => expect(container.querySelectorAll("svg")).toHaveLength(1));
    expect(vi.mocked(draw)).toHaveBeenCalledTimes(1);
  });
});
