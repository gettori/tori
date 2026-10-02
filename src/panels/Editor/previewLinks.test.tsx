// The preview's links and images. A link is routed and never followed, since
// an anchor the webview follows takes the whole app off the SPA; a remote
// image still renders here, which is the one place it does.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DOC = `See [the site](https://x.dev/docs), [a sibling](guide.md), [up one](../CHANGELOG.md:12) and [top](#top).

![badge](https://x.dev/badge.svg)
`;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "fs_read_file" ? DOC : undefined)),
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import { invoke } from "@tauri-apps/api/core";
import MarkdownPreview from "./MarkdownPreview";

async function mounted() {
  const view = render(() => <MarkdownPreview path="/repo/docs/README.md" />);
  await waitFor(() => expect(view.container.querySelectorAll("a")).toHaveLength(4));
  return view;
}

function click(el: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe("links in the markdown preview", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("prevents the default on every anchor, whatever the href", async () => {
    const { container } = await mounted();
    for (const a of container.querySelectorAll("a")) expect(click(a).defaultPrevented).toBe(true);
  });

  it("hands a web link to the opener", async () => {
    const { getByText } = await mounted();
    click(getByText("the site"));
    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://x.dev/docs" });
  });

  it("opens a relative link in the editor, read against the file's own directory", async () => {
    const { getByText } = await mounted();
    const opened: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (e) => opened.push(e));
    click(getByText("a sibling"));
    click(getByText("up one"));
    off();
    expect(opened.map((o) => o.path)).toEqual(["/repo/docs/guide.md", "/repo/CHANGELOG.md"]);
    expect(invoke).not.toHaveBeenCalledWith("plugin:opener|open_url", expect.anything());
  });

  it("still renders a remote image", async () => {
    const { container } = await mounted();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://x.dev/badge.svg");
  });
});
