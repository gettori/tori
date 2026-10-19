import { describe, it, expect } from "vite-plus/test";
import { batchToMarkdown } from "./markdown";
import type { LogEntry, Pick } from "./pick";

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
  at: 1_000_000,
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

  const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
    seq: 1,
    at: 1_002_300,
    kind: "error",
    text: "TypeError: x is undefined",
    count: 1,
    ...over,
  });

  it("leaves the page log out when there is none", () => {
    expect(batchToMarkdown([pick()], false, [])).not.toContain("Page log");
  });

  it("times the page log from the first pick, before it negative", () => {
    const md = batchToMarkdown([pick(), pick({ at: 1_009_000 })], false, [
      entry({ at: 996_600, kind: "warn", text: "Slow" }),
      entry({ count: 3 }),
    ]);
    expect(md).toContain("### 2. Make this bolder\n");
    expect(md.endsWith("### Page log\n\n```\n-3.4s warn: Slow\n+2.3s error: TypeError: x is undefined x3\n```")).toBe(
      true,
    );
  });

  it("times a log with no picks from its first entry and indents stack lines", () => {
    const md = batchToMarkdown([], false, [
      entry({ text: "TypeError: boom\n    at App (src/App.tsx:3:9)" }),
      entry({ seq: 2, at: 1_003_500, kind: "request", text: "GET /api/me?x=1 -> 500" }),
    ]);
    expect(md).toBe(
      [
        "### Page log",
        "",
        "```",
        "+0.0s error: TypeError: boom",
        "      at App (src/App.tsx:3:9)",
        "+1.2s request: GET /api/me?x=1 -> 500",
        "```",
      ].join("\n"),
    );
  });

  it("fences the page log past backticks in a message", () => {
    const md = batchToMarkdown([], false, [entry({ text: "bad ``` fence" })]);
    expect(md).toContain("````\n+0.0s error: bad ``` fence\n````");
  });
});
