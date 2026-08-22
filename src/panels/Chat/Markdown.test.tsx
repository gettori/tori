import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expectNoAxeViolations } from "../../test/axe";
import Markdown from "./Markdown";

vi.mock("../../utils/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("./highlight", () => ({ highlightedHtml: vi.fn(() => null) }));
import { copyText } from "../../utils/clipboard";
import { highlightedHtml } from "./highlight";

const FENCED = "intro paragraph\n\n```ts\nconst x = 1;\n```\n\noutro paragraph";

beforeEach(() => {
  vi.mocked(copyText).mockClear();
  vi.mocked(highlightedHtml).mockReset();
  vi.mocked(highlightedHtml).mockReturnValue(null);
});

describe("Markdown block splitting", () => {
  it("renders prose as markdown and a fence as a code block with its label", () => {
    const { container, getByText } = render(() => <Markdown text={FENCED} />);
    const paras = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(paras).toEqual(["intro paragraph", "outro paragraph"]);
    expect(container.querySelector("pre")?.textContent).toBe("const x = 1;");
    getByText("ts");
  });

  it("keeps prose formatting working across the split", () => {
    const { container } = render(() => <Markdown text={"some **bold** text\n\n```\nplain\n```"} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("leaves the corner empty for a bare fence, which still gets its copy button", () => {
    const { container, queryByText, getByLabelText } = render(() => <Markdown text={"```\nno lang here\n```"} />);
    expect(container.querySelector("pre")?.textContent).toBe("no lang here");
    expect(queryByText("no lang here", { selector: "span" })).toBeNull();
    getByLabelText("Copy code");
  });

  it("does not re-create earlier blocks when a streaming delta grows the tail", () => {
    const [text, setText] = createSignal(FENCED);
    const { container } = render(() => <Markdown text={text()} />);
    const intro = container.querySelector("p");
    const pre = container.querySelector("pre");
    setText(FENCED + " that keeps growing");
    const paras = container.querySelectorAll("p");
    // The tail paragraph re-rendered with the delta; everything above it is
    // the same DOM, which is the point of splitting by block.
    expect(paras[paras.length - 1].textContent).toBe("outro paragraph that keeps growing");
    expect(container.querySelector("p")).toBe(intro);
    expect(container.querySelector("pre")).toBe(pre);
  });

  it("has no axe violations", async () => {
    const { container } = render(() => <Markdown text={FENCED} />);
    await expectNoAxeViolations(container);
  });
});

describe("code block highlighting", () => {
  it("paints shiki's spans when the highlighter answers", () => {
    vi.mocked(highlightedHtml).mockReturnValue('<span style="color:var(--syntax-keyword)">const</span> x = 1;');
    const { container } = render(() => <Markdown text={FENCED} />);
    expect(highlightedHtml).toHaveBeenCalledWith("const x = 1;", "ts");
    expect(container.querySelector("pre code span")?.textContent).toBe("const");
  });

  it("falls back to plain text while the highlighter has no answer", () => {
    const { container } = render(() => <Markdown text={FENCED} />);
    expect(container.querySelector("pre code span")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
  });
});

describe("code block controls", () => {
  it("copies the fence's raw text", async () => {
    const { getByLabelText } = render(() => <Markdown text={FENCED} />);
    fireEvent.click(getByLabelText("Copy code"));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("const x = 1;"));
  });

  it("offers a preview only on a markdown fence, and toggles it", () => {
    const { container, getByLabelText, queryByLabelText } = render(
      () => <Markdown text={"```md\n# A heading\n```"} />,
    );
    expect(container.querySelector("h1")).toBeNull();
    fireEvent.click(getByLabelText("Preview markdown"));
    expect(container.querySelector("h1")?.textContent).toBe("A heading");
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(getByLabelText("Show markdown source"));
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("# A heading");
    expect(queryByLabelText("Preview markdown")).not.toBeNull();
  });

  it("gives an ordinary fence no preview control", () => {
    const { queryByLabelText } = render(() => <Markdown text={FENCED} />);
    expect(queryByLabelText("Preview markdown")).toBeNull();
  });

  it("treats mdx and mkd fences as markdown too", () => {
    for (const lang of ["mdx", "mkd", "markdown"]) {
      const { getByLabelText, unmount } = render(() => <Markdown text={"```" + lang + "\n# Hi\n```"} />);
      getByLabelText("Preview markdown");
      unmount();
    }
  });

  it("drops YAML front matter from the preview, and only from the preview", () => {
    const doc = "---\ntitle: Notes\n---\n# The heading";
    const { container, getByLabelText } = render(() => <Markdown text={"```md\n" + doc + "\n```"} />);
    expect(container.querySelector("pre")?.textContent).toBe(doc);
    fireEvent.click(getByLabelText("Preview markdown"));
    // Rendered, the front matter's fences would be an hr straight through the
    // corner controls, with the metadata line left dangling above the title.
    expect(container.querySelector("hr")).toBeNull();
    expect(container.textContent).not.toContain("title: Notes");
    expect(container.querySelector("h1")?.textContent).toBe("The heading");
  });
});
