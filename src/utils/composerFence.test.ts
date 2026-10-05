import { describe, it, expect } from "vite-plus/test";
import { insideFence } from "./composerFence";

const end = (text: string) => insideFence(text, text.length);

describe("insideFence", () => {
  it("is inside once a fence has opened and not yet closed", () => {
    expect(end("look:\n```ts\nconst a = 1;")).toBe(true);
    expect(end("~~~\nsome text")).toBe(true);
  });

  // The line that opens the fence counts as inside: Enter typed right after
  // the backticks must start the block, not send it.
  it("is inside at the end of the opening line itself", () => {
    expect(end("```")).toBe(true);
    expect(end("```python")).toBe(true);
  });

  it("is outside again once the fence is closed", () => {
    expect(end("```\ncode\n```")).toBe(false);
    expect(end("```\ncode\n```\nand then prose")).toBe(false);
    expect(end("~~~\ncode\n~~~")).toBe(false);
  });

  it("is outside for a caret that sits before the fence", () => {
    const text = "prose\n```\ncode";
    expect(insideFence(text, 0)).toBe(false);
    expect(insideFence(text, "prose".length)).toBe(false);
    expect(insideFence(text, text.length)).toBe(true);
  });

  it("does not close four backticks with three, nor a backtick fence with tildes", () => {
    expect(end("````\ncode\n```")).toBe(true);
    expect(end("````\ncode\n````")).toBe(false);
    expect(end("```\ncode\n~~~")).toBe(true);
    // A longer run still closes a shorter opener.
    expect(end("```\ncode\n`````")).toBe(false);
  });

  it("treats up to three leading spaces as a fence and four as code", () => {
    expect(end("   ```\ncode")).toBe(true);
    expect(end("    ```\ncode")).toBe(false);
    expect(end("```\ncode\n   ```")).toBe(false);
  });

  // A closing fence has nothing after it. A line that starts with backticks
  // and carries words is an opener of a nested-looking block, which stays open.
  it("does not take a run followed by text as the closing fence", () => {
    expect(end("```\ncode\n``` not closed")).toBe(true);
  });

  it("ignores inline backticks and runs that do not start the line", () => {
    expect(end("use `x` here")).toBe(false);
    expect(end("see ``` mid-line")).toBe(false);
    expect(end("a ``b`` c")).toBe(false);
  });

  it("clamps a caret outside the text", () => {
    expect(insideFence("```\ncode", 99)).toBe(true);
    expect(insideFence("```\ncode", -5)).toBe(false);
  });
});
