import { describe, it, expect } from "vite-plus/test";
import { batchToMarkdown } from "./markdown";
import type { Pick } from "./pick";

const pick = (over: Partial<Pick> = {}): Pick => ({
  comment: "Make this bolder",
  kind: "element",
  url: "http://localhost:5173/settings?tab=a",
  route: "/settings?tab=a",
  selector: "main > button.primary",
  path: "html > body > div#app > main > button.primary",
  html: '<button class="primary">Save</button>',
  text: "Save",
  styles: { "font-weight": "400", color: "rgb(0, 0, 0)" },
  rect: { x: 120, y: 340, width: 200, height: 40 },
  viewport: { width: 1440, height: 900 },
  dpr: 2,
  theme: "dark",
  images: [],
  ...over,
});

describe("batchToMarkdown", () => {
  it("writes a heading, the facts, the markup, the text and the styles per pick", () => {
    expect(batchToMarkdown([pick()])).toBe(
      [
        "### 1. Make this bolder",
        "",
        "```",
        "url: http://localhost:5173/settings?tab=a",
        "selector: main > button.primary",
        "path: html > body > div#app > main > button.primary",
        "rect: 120,340 200x40",
        "viewport: 1440x900",
        "dpr: 2",
        "theme: dark",
        "```",
        "",
        "```html",
        '<button class="primary">Save</button>',
        "```",
        "",
        "```text",
        "Save",
        "```",
        "",
        "```css",
        "font-weight: 400;",
        "color: rgb(0, 0, 0);",
        "```",
      ].join("\n"),
    );
  });

  it("numbers picks in order and marks a selection", () => {
    const md = batchToMarkdown([pick(), pick({ comment: "Typo", kind: "selection" })]);
    expect(md).toContain("### 1. Make this bolder");
    expect(md).toContain("### 2. Typo\n\n```\nurl: http://localhost:5173/settings?tab=a\npicked: selection\n");
  });

  it("keeps the heading on one line and skips empty sections", () => {
    const md = batchToMarkdown([pick({ comment: "two\nlines", html: "", text: "", styles: {} })]);
    expect(md.startsWith("### 1. two lines\n")).toBe(true);
    expect(md).not.toContain("```html");
    expect(md).not.toContain("```text");
    expect(md).not.toContain("```css");
  });

  it("fences past backticks in the page", () => {
    const md = batchToMarkdown([pick({ text: "a ``` b", html: "", styles: {} })]);
    expect(md).toContain("````text\na ``` b\n````");
  });

  it("labels each pick's screenshots in attach order when they are sent", () => {
    const shot = (n: number) => [`7:${n}:viewport`, `7:${n}:element`];
    const picks = [pick({ images: shot(1) }), pick({ comment: "Typo" }), pick({ comment: "Gap", images: shot(3) })];
    const sent = batchToMarkdown(picks, true);
    expect(sent).toContain("theme: dark\nscreenshots: [Image 1] viewport, [Image 2] element\n```");
    expect(sent).toContain("### 3. Gap\n");
    expect(sent).toContain("screenshots: [Image 3] viewport, [Image 4] element");
    expect(sent.match(/screenshots:/g)).toHaveLength(2);
    expect(batchToMarkdown(picks)).not.toContain("screenshots:");
  });
});
