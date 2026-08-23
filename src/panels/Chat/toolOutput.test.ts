import { describe, it, expect } from "vitest";
import { BODY_ROWS, hitRows, pathRows, prettyJson, readLines, stripAnsi } from "./toolOutput";

const ESC = "\u001B";

describe("stripAnsi", () => {
  it("removes what a program wrote for a terminal that is not here", () => {
    expect(stripAnsi(`${ESC}[31mfailed${ESC}[0m`)).toBe("failed");
    expect(stripAnsi(`${ESC}[1;32m ok ${ESC}[m rest`)).toBe(" ok  rest");
    expect(stripAnsi(`${ESC}]0;a title\u0007done`)).toBe("done");
  });

  it("leaves output that carries no escapes exactly as it was", () => {
    const plain = "  indented\n\ttabbed\nplain [31m not an escape";
    expect(stripAnsi(plain)).toBe(plain);
  });
});

describe("prettyJson", () => {
  // The measured shape of opencode's answer to an execute call: the whole
  // `rawOutput` object, on one line.
  it("opens up an ACP raw output rather than leaving it on one line", () => {
    const raw = '{"output":"hi\\n","metadata":{"exit":1,"truncated":false}}';
    const pretty = prettyJson(raw);
    expect(pretty).not.toBeNull();
    expect(pretty!.split("\n").length).toBeGreaterThan(4);
    expect(JSON.parse(pretty!)).toEqual({ output: "hi\n", metadata: { exit: 1, truncated: false } });
  });

  it("leaves anything that is not an object or an array alone", () => {
    expect(prettyJson("total 24\ndrwxr-xr-x  5 me  staff")).toBeNull();
    expect(prettyJson("42")).toBeNull();
    expect(prettyJson('"a string"')).toBeNull();
    expect(prettyJson("")).toBeNull();
    // Starts like JSON and is not.
    expect(prettyJson("{ not json at all")).toBeNull();
  });
});

describe("readLines", () => {
  it("takes the file's own line numbers out of the gutter", () => {
    const rows = readLines("     1\tfirst\n     2\tsecond\n     3\tthird\n", 1);
    expect(rows).toEqual([
      { line: 1, text: "first" },
      { line: 2, text: "second" },
      { line: 3, text: "third" },
    ]);
  });

  it("keeps the numbers a slice actually starts at", () => {
    const rows = readLines("    50\tfifty\n    51\tfifty one\n", 1);
    expect(rows.map((r) => r.line)).toEqual([50, 51]);
  });

  // The trap: only the first tab belongs to the gutter, so a file whose own
  // content is tab separated must come back whole.
  it("leaves a file whose own content has leading digits and tabs unmangled", () => {
    const rows = readLines("     1\t12\thello\n     2\t99\tworld\n", 1);
    expect(rows).toEqual([
      { line: 1, text: "12\thello" },
      { line: 2, text: "99\tworld" },
    ]);
  });

  // A file that is itself a numbered list reads exactly like a gutter, one
  // line at a time. Only the run being consecutive tells them apart.
  it("does not mistake the file's own content for a gutter", () => {
    const rows = readLines("     1\tone\n    99\tninety nine\n", 7);
    expect(rows).toEqual([
      { line: 7, text: "     1\tone" },
      { line: 8, text: "    99\tninety nine" },
    ]);
  });

  it("numbers a file that arrived with no gutter from where the summary says", () => {
    const rows = readLines("fn main() {\n}\n", 20);
    expect(rows).toEqual([
      { line: 20, text: "fn main() {" },
      { line: 21, text: "}" },
    ]);
  });

  it("has nothing to render for an empty output", () => {
    expect(readLines("", 1)).toEqual([]);
  });
});

describe("hitRows", () => {
  it("splits a hit into the file, the line and the match", () => {
    expect(hitRows("src/a.rs:12:  fn main() {\n")).toEqual([{ path: "src/a.rs", line: 12, text: "  fn main() {" }]);
  });

  // The separator is the first `:digits:`, so a colon inside the matched text
  // cannot be mistaken for one.
  it("does not let a colon in the match itself split the row", () => {
    expect(hitRows("src/a.rs:12:let x = a ? 1 : 2;")).toEqual([
      { path: "src/a.rs", line: 12, text: "let x = a ? 1 : 2;" },
    ]);
  });

  it("renders a line that names no file as plain text", () => {
    expect(hitRows("just a line")).toEqual([{ path: null, line: null, text: "just a line" }]);
  });
});

describe("pathRows", () => {
  it("is one entry per path, without the trailing blank", () => {
    expect(pathRows("/a.rs\n/b.rs\n")).toEqual(["/a.rs", "/b.rs"]);
    expect(pathRows("")).toEqual([]);
  });
});

describe("the row cap", () => {
  // A `Grep` can answer with thousands and a transcript is not a results pane.
  it("is well under what a large search answers with", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `src/a.rs:${i + 1}:hit`).join("\n");
    expect(hitRows(huge)).toHaveLength(5000);
    expect(BODY_ROWS).toBeLessThan(5000);
  });
});
