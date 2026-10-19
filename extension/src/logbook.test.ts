import { describe, it, expect } from "vite-plus/test";
import { fillDirectives, Logbook, restates } from "./logbook";

describe("fillDirectives", () => {
  it("fills directives in order and drops styling", () => {
    expect(fillDirectives(["Warning: %s in %s%c", "key", "List", "color: red"])).toBe("Warning: key in List");
  });

  it("keeps a directive with nothing left to fill it and a literal percent", () => {
    expect(fillDirectives(["100%% of %s and %d", "it"])).toBe("100% of it and %d");
  });

  it("joins arguments past the directives, objects as JSON and errors as their stack", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at App (src/App.tsx:3:9)\n    at render (react.js:1:1)";
    expect(fillDirectives(["%s:", "Failed", { id: 1 }, error])).toBe(
      'Failed: {"id":1} Error: boom\n    at App (src/App.tsx:3:9)\n    at render (react.js:1:1)',
    );
  });
});

describe("restates", () => {
  it("matches a console error the overlay already holds, whatever the spacing", () => {
    const overlay = "Build Error\n./app/page.jsx\nError: x Unexpected token `=`. Expected yield";
    expect(restates(overlay, "./app/page.jsx\nError:   x Unexpected token `=`.")).toBe(true);
    expect(restates(overlay, "TypeError: something else entirely")).toBe(false);
  });

  it("never matches with no overlay or a message too short to tell", () => {
    expect(restates(null, "./app/page.jsx Error: x Unexpected token")).toBe(false);
    expect(restates("Error: x", "Error")).toBe(false);
  });
});

describe("Logbook", () => {
  it("collapses a repeat in a row into a count, not across another entry", () => {
    const book = new Logbook();
    book.add("error", "same", 1);
    book.add("error", "same", 2);
    book.add("warn", "other", 3);
    book.add("error", "same", 4);
    expect(book.unsent().map((e) => [e.text, e.count])).toEqual([
      ["same", 2],
      ["other", 1],
      ["same", 1],
    ]);
  });

  it("keeps the first 50 errors and the last 50 warnings and requests", () => {
    const book = new Logbook();
    book.add("error", "root cause");
    for (let i = 0; i < 60; i++) book.add("rejection", `r${i}`);
    for (let i = 0; i < 60; i++) book.add("warn", `w${i}`);
    for (let i = 0; i < 60; i++) book.add("request", `GET /x?n=${i} -> 404`);
    const log = book.unsent();
    expect(log.filter((e) => e.kind === "rejection")).toHaveLength(49);
    expect(log[0].text).toBe("root cause");
    expect(log.filter((e) => e.kind === "warn").map((e) => e.text)[0]).toBe("w10");
    expect(log.filter((e) => e.kind === "request")).toHaveLength(50);
  });

  it("still takes a build error once 50 errors are in", () => {
    const book = new Logbook();
    for (let i = 0; i < 50; i++) book.add("error", `e${i}`);
    expect(book.overlay("[plugin:vite] Unexpected token")).toBe(true);
    const log = book.unsent();
    expect(log[log.length - 1].kind).toBe("overlay");
  });

  it("sends only what came after the mark, and a repeat of a sent entry is new", () => {
    const book = new Logbook();
    book.add("error", "same");
    const [sent] = book.unsent();
    book.mark(sent.seq);
    expect(book.unsent()).toEqual([]);
    book.add("error", "same");
    expect(book.unsent().map((e) => [e.text, e.count])).toEqual([["same", 1]]);
  });

  it("caps a message at 500 characters", () => {
    const book = new Logbook();
    book.add("error", "x".repeat(600));
    expect(book.unsent()[0].text).toBe(`${"x".repeat(500)}...`);
  });

  it("keeps an overlay as one entry until it goes away, and counts it coming back", () => {
    const book = new Logbook();
    expect(book.overlay("Build Error x")).toBe(true);
    expect(book.overlay("Build Error x")).toBe(false);
    book.overlay(null);
    expect(book.overlay("Build Error x")).toBe(true);
    expect(book.unsent().map((e) => [e.kind, e.count])).toEqual([["overlay", 2]]);
  });

  it("drops a console error the overlay restates, before or after it opens", () => {
    const build = "./app/page.jsx\nError: x Unexpected token `=`. Expected yield";
    const book = new Logbook();
    book.add("error", build);
    book.add("error", "TypeError: unrelated runtime failure");
    book.overlay(`Build Error\n${build}`);
    book.add("error", build);
    expect(book.unsent().map((e) => e.kind)).toEqual(["error", "overlay"]);
    expect(book.unsent()[0].text).toBe("TypeError: unrelated runtime failure");
  });
});
