import { describe, it, expect, vi } from "vite-plus/test";
import { render } from "@solidjs/testing-library";
import Markdown from "./Markdown";
import { CODE_SKIPPED, speakableBlocks } from "./speakable";

vi.mock("../../utils/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("./highlight", () => ({ createHighlight: () => ({ html: () => null, lines: () => null }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const REPLY = [
  "First paragraph with `inline code` and a [link](https://example.com/page).",
  "",
  "- tight one",
  "- tight two",
  "  - nested child",
  "",
  "- loose one",
  "",
  "- loose two",
  "",
  "> quoted line",
  "",
  "| Name | Size |",
  "| ---- | ---- |",
  "| a.ts | 3 KB |",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "Last paragraph.",
].join("\n");

const blocks = (text: string) => {
  const { container } = render(() => (
    <div>
      <Markdown text={text} cwd="/repo" />
    </div>
  ));
  return speakableBlocks(container.firstElementChild!);
};

describe("speakableBlocks", () => {
  it("reads every block once, in order, with code skipped and links as their text", () => {
    expect(blocks(REPLY).map((b) => b.text)).toEqual([
      "First paragraph with inline code and a link.",
      "tight one",
      "tight two",
      "nested child",
      "loose one",
      "loose two",
      "quoted line",
      "Name, Size",
      "a.ts, 3 KB",
      CODE_SKIPPED,
      "Last paragraph.",
    ]);
  });

  it("gives a heading and a list item a pause, and says a task's state", () => {
    const got = blocks(["## Next steps", "", "- [ ] write docs", "- [x] add tests", "", "Then ship."].join("\n"));
    expect(got.map((b) => [b.text, b.pause])).toEqual([
      ["Next steps", 500],
      ["to do, write docs", 250],
      ["done, add tests", 250],
      ["Then ship.", 0],
    ]);
  });
});
