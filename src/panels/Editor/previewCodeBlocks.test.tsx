// The preview's fences: rendered markdown is the side you read from, so it is
// the side that owes you the text back, and a `mermaid` fence is a picture here
// rather than its own arrow syntax.
//
// The mermaid engine is mocked because the real one measures text through
// `getBBox`, which jsdom does not implement. `Diagram.test.tsx` covers what the
// component does with each answer; this file only asks whether the preview
// wires a fence to it at all, and what happens to every other fence.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DOC = `# Title

Some prose with \`inline code\` in it.

\`\`\`ts
const x = 1;
\`\`\`

\`\`\`mermaid
flowchart TD
  a --> b
\`\`\`

Closing prose.
`;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => DOC),
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));
vi.mock("../../utils/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("../../utils/mermaidEngine", () => ({
  configure: vi.fn(),
  render: vi.fn(async () => '<svg role="img" aria-label="a flowchart"><g></g></svg>'),
}));

// The mocked engine's own SVG, told apart from the lucide glyph in the copy
// button, which is an `svg` too.
const DRAWN = 'svg[aria-label="a flowchart"]';

import MarkdownPreview from "./MarkdownPreview";
import { copyText } from "../../utils/clipboard";
import { render as draw } from "../../utils/mermaidEngine";

beforeEach(() => {
  vi.mocked(copyText).mockClear();
  vi.mocked(draw).mockClear();
});

/** Mount the preview on a path and wait for the document to be on screen, to
 *  its last block: a large one fills in over several frames. */
async function showPreview(path = "/repo/doc.md") {
  const view = render(() => <MarkdownPreview path={path} />);
  await waitFor(() => expect(view.container.textContent).toContain("Closing prose."));
  return view;
}

describe("code blocks in the markdown preview", () => {
  it("gives every fence its own copy button", async () => {
    const { getAllByLabelText } = await showPreview();
    // Two fences, two buttons: the diagram's source is as copyable as the
    // code, which is the whole reason the button hangs off the wrapper.
    expect(getAllByLabelText("Copy code")).toHaveLength(2);
  });

  it("copies the fence's own text, not the whole document", async () => {
    const { getAllByLabelText } = await showPreview();

    fireEvent.click(getAllByLabelText("Copy code")[0]);

    await waitFor(() => expect(copyText).toHaveBeenCalledWith("const x = 1;"));
  });

  it("copies a diagram's source rather than its picture", async () => {
    const { getAllByLabelText } = await showPreview();

    fireEvent.click(getAllByLabelText("Copy code")[1]);

    await waitFor(() => expect(copyText).toHaveBeenCalledWith("flowchart TD\n  a --> b"));
  });

  it("draws a mermaid fence and leaves every other fence as text", async () => {
    const { container } = await showPreview();

    await waitFor(() => expect(container.querySelector(DRAWN)).not.toBeNull());
    // One `pre`, not two: the diagram replaced its own source, and the `ts`
    // fence kept it.
    const pres = [...container.querySelectorAll("pre")].map((p) => p.textContent);
    expect(pres).toEqual(["const x = 1;"]);
    expect(vi.mocked(draw).mock.calls[0][0]).toBe("flowchart TD\n  a --> b");
  });

  it("still renders the prose around the fences", async () => {
    // Splitting the document into blocks is what buys the buttons, and it is
    // also the thing that could quietly drop the text between them.
    const { container } = await showPreview();
    const paras = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(paras).toEqual(["Some prose with inline code in it.", "Closing prose."]);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
  });

  it("has no axe violations", async () => {
    const { container } = await showPreview();
    await waitFor(() => expect(container.querySelector(DRAWN)).not.toBeNull());
    await expectNoAxeViolations(container);
  });
});
