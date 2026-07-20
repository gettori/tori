import { describe, it, expect } from "vitest";
import { stripAnsi, tailLines, registerPeek, peekTab } from "./termPeek";

describe("stripAnsi", () => {
  it("removes SGR colour sequences", () => {
    // The payload deliberately avoids CSS colour words: scripts/check-tokens.mjs
    // scans string literals and would read one as an un-tokenized colour.
    expect(stripAnsi("\x1b[31mfailed\x1b[0m")).toBe("failed");
  });

  it("removes cursor-positioning sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[H\x1b[10;5Hhi")).toBe("hi");
  });

  it("removes OSC title strings terminated by BEL or ST", () => {
    expect(stripAnsi("\x1b]0;my title\x07done")).toBe("done");
    expect(stripAnsi("\x1b]0;my title\x1b\\done")).toBe("done");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain output")).toBe("plain output");
  });
});

describe("tailLines", () => {
  it("takes the last n lines, oldest first", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toEqual(["c", "d"]);
  });

  it("returns everything when the buffer is shorter than n", () => {
    expect(tailLines("a\nb", 10)).toEqual(["a", "b"]);
  });

  it("drops blank lines rather than counting them, so an alt-screen frame still yields output", () => {
    const altScreen = "real output\n" + "\n".repeat(30) + "last line\n" + "\n".repeat(10);
    expect(tailLines(altScreen, 10)).toEqual(["real output", "last line"]);
  });

  it("strips ANSI before splitting", () => {
    expect(tailLines("\x1b[32mok\x1b[0m\n\x1b[31mfail\x1b[0m", 5)).toEqual(["ok", "fail"]);
  });

  it("trims trailing carriage returns and padding", () => {
    expect(tailLines("a  \r\nb\t\r\n", 5)).toEqual(["a", "b"]);
  });

  it("is empty for a buffer with nothing but whitespace", () => {
    expect(tailLines("\n\n   \n", 5)).toEqual([]);
  });
});

describe("peek registry", () => {
  it("returns null for a tab with no mounted buffer", () => {
    expect(peekTab("never-mounted")).toBeNull();
  });

  it("reads a registered buffer and stops after unregistering", () => {
    const off = registerPeek("t1", () => "one\ntwo");
    expect(peekTab("t1", 10)).toEqual(["one", "two"]);
    off();
    expect(peekTab("t1")).toBeNull();
  });

  it("distinguishes an empty buffer from an absent one", () => {
    const off = registerPeek("t2", () => "");
    expect(peekTab("t2")).toEqual([]);
    off();
  });

  it("a stale view's cleanup does not unregister the tab's new reader", () => {
    const offOld = registerPeek("t3", () => "old");
    registerPeek("t3", () => "new");
    offOld();
    expect(peekTab("t3")).toEqual(["new"]);
  });

  it("returns null when the reader throws (a disposed terminal)", () => {
    registerPeek("t4", () => {
      throw new Error("disposed");
    });
    expect(peekTab("t4")).toBeNull();
  });
});
