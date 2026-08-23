import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expectNoAxeViolations } from "../../test/axe";
import Markdown from "./Markdown";

vi.mock("../../utils/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("./highlight", () => ({ cappedHtml: vi.fn(() => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
import { copyText } from "../../utils/clipboard";
import { cappedHtml } from "./highlight";
import { invoke } from "@tauri-apps/api/core";
import { onWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "../../utils/events";

const FENCED = "intro paragraph\n\n```ts\nconst x = 1;\n```\n\noutro paragraph";

beforeEach(() => {
  vi.mocked(copyText).mockClear();
  vi.mocked(cappedHtml).mockReset();
  vi.mocked(cappedHtml).mockReturnValue(null);
});

describe("Markdown block splitting", () => {
  it("renders prose as markdown and a fence as a code block with its label", () => {
    const { container, getByText } = render(() => <Markdown text={FENCED} cwd="/repo" />);
    const paras = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(paras).toEqual(["intro paragraph", "outro paragraph"]);
    expect(container.querySelector("pre")?.textContent).toBe("const x = 1;");
    getByText("ts");
  });

  it("keeps prose formatting working across the split", () => {
    const { container } = render(() => <Markdown text={"some **bold** text\n\n```\nplain\n```"} cwd="/repo" />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("leaves the corner empty for a bare fence, which still gets its copy button", () => {
    const { container, queryByText, getByLabelText } = render(() => <Markdown text={"```\nno lang here\n```"} cwd="/repo" />);
    expect(container.querySelector("pre")?.textContent).toBe("no lang here");
    expect(queryByText("no lang here", { selector: "span" })).toBeNull();
    getByLabelText("Copy code");
  });

  it("does not re-create earlier blocks when a streaming delta grows the tail", () => {
    const [text, setText] = createSignal(FENCED);
    const { container } = render(() => <Markdown text={text()} cwd="/repo" />);
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
    const { container } = render(() => <Markdown text={FENCED} cwd="/repo" />);
    await expectNoAxeViolations(container);
  });
});

describe("code block highlighting", () => {
  it("paints shiki's spans when the highlighter answers", () => {
    vi.mocked(cappedHtml).mockReturnValue('<span style="color:var(--syntax-keyword)">const</span> x = 1;');
    const { container } = render(() => <Markdown text={FENCED} cwd="/repo" />);
    expect(cappedHtml).toHaveBeenCalledWith("const x = 1;", "ts");
    expect(container.querySelector("pre code span")?.textContent).toBe("const");
  });

  it("falls back to plain text while the highlighter has no answer", () => {
    const { container } = render(() => <Markdown text={FENCED} cwd="/repo" />);
    expect(container.querySelector("pre code span")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
  });
});

describe("code block controls", () => {
  it("copies the fence's raw text", async () => {
    const { getByLabelText } = render(() => <Markdown text={FENCED} cwd="/repo" />);
    fireEvent.click(getByLabelText("Copy code"));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("const x = 1;"));
  });

  it("offers a preview only on a markdown fence, and toggles it", () => {
    const { container, getByLabelText, queryByLabelText } = render(
      () => <Markdown text={"```md\n# A heading\n```"} cwd="/repo" />,
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
    const { queryByLabelText } = render(() => <Markdown text={FENCED} cwd="/repo" />);
    expect(queryByLabelText("Preview markdown")).toBeNull();
  });

  it("treats mdx and mkd fences as markdown too", () => {
    for (const lang of ["mdx", "mkd", "markdown"]) {
      const { getByLabelText, unmount } = render(() => <Markdown text={"```" + lang + "\n# Hi\n```"} cwd="/repo" />);
      getByLabelText("Preview markdown");
      unmount();
    }
  });

  it("drops YAML front matter from the preview, and only from the preview", () => {
    const doc = "---\ntitle: Notes\n---\n# The heading";
    const { container, getByLabelText } = render(() => <Markdown text={"```md\n" + doc + "\n```"} cwd="/repo" />);
    expect(container.querySelector("pre")?.textContent).toBe(doc);
    fireEvent.click(getByLabelText("Preview markdown"));
    // Rendered, the front matter's fences would be an hr straight through the
    // corner controls, with the metadata line left dangling above the title.
    expect(container.querySelector("hr")).toBeNull();
    expect(container.textContent).not.toContain("title: Notes");
    expect(container.querySelector("h1")?.textContent).toBe("The heading");
  });
});

describe("links in prose are routed, never followed", () => {
  // The regression: an anchor the webview follows navigates off the SPA, which
  // reads as the app crashing and takes the session with it.
  it("prevents the default on every anchor, whatever the href", () => {
    const { container } = render(() => (
      <Markdown text={"See [temp.md](temp.md), [docs](https://x.dev) and [top](#top)."} cwd="/repo" />
    ));
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors).toHaveLength(3);
    for (const a of anchors) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
  });

  it("opens a workspace file in the editor at its line", () => {
    const seen: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => seen.push(d));
    const { getByText } = render(() => <Markdown text={"[a.ts](src/a.ts:12)"} cwd="/repo" />);
    fireEvent.click(getByText("a.ts"));
    off();
    expect(seen).toEqual([{ path: "/repo/src/a.ts", line: 12 }]);
  });

  it("says so rather than opening a tab on a file outside the workspace", () => {
    const opens: OpenInEditor[] = [];
    const toasts: ToastEvent[] = [];
    const offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opens.push(d));
    const offToast = onWith<ToastEvent>(TOAST, (d) => toasts.push(d));
    const { getByText } = render(() => <Markdown text={"[hosts](/etc/hosts)"} cwd="/repo" />);
    fireEvent.click(getByText("hosts"));
    offOpen();
    offToast();
    expect(opens).toEqual([]);
    expect(toasts[0]?.message).toContain("/etc/hosts");
  });

  it("hands a real URL to the opener instead of the editor", () => {
    const opens: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opens.push(d));
    const { getByText } = render(() => <Markdown text={"[docs](https://example.com/a)"} cwd="/repo" />);
    fireEvent.click(getByText("docs"));
    off();
    expect(opens).toEqual([]);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://example.com/a" });
  });
});
