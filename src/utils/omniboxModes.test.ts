import { describe, it, expect } from "vite-plus/test";
import { MODES, parseLine, parseQuery, specOf } from "./omniboxModes";

describe("which mode a query selects", () => {
  it("reads a query with no prefix as what the opening key asked for", () => {
    expect(parseQuery("", "file")).toEqual({ mode: "file", term: "" });
    expect(parseQuery("index.ts", "file")).toEqual({ mode: "file", term: "index.ts" });
    expect(parseQuery("", "all")).toEqual({ mode: "all", term: "" });
    expect(parseQuery("tori", "all")).toEqual({ mode: "all", term: "tori" });
  });

  it("reaches files with / from either home", () => {
    expect(parseQuery("/index.ts", "all")).toEqual({ mode: "file", term: "index.ts" });
    expect(parseQuery("/index.ts", "file")).toEqual({ mode: "file", term: "index.ts" });
  });

  it("routes each prefix to its mode, whichever key opened the box", () => {
    for (const home of ["all", "file"] as const) {
      expect(parseQuery(">save", home).mode).toBe("command");
      expect(parseQuery("@Thing", home).mode).toBe("doc");
      expect(parseQuery("#Thing", home).mode).toBe("workspace");
      expect(parseQuery(":120", home).mode).toBe("line");
      expect(parseQuery("?", home).mode).toBe("help");
    }
  });

  it("strips the prefix and the space after it", () => {
    // The prefix is typed, then the query is thought about, so the space is
    // almost always there.
    expect(parseQuery("> save file", "file").term).toBe("save file");
    expect(parseQuery(">save", "file").term).toBe("save");
  });

  it("reads the prefix only at the start", () => {
    // A `#` inside a filename is part of the filename.
    expect(parseQuery("src/a#b.ts", "file")).toEqual({ mode: "file", term: "src/a#b.ts" });
    expect(parseQuery("notes@work.md", "file").mode).toBe("file");
  });

  it("treats a bare prefix as the mode being entered", () => {
    expect(parseQuery(">", "all")).toEqual({ mode: "command", term: "" });
    expect(parseQuery(":", "file")).toEqual({ mode: "line", term: "" });
    expect(parseQuery("/", "all")).toEqual({ mode: "file", term: "" });
  });

  it("gives every mode a spec, so nothing renders without a placeholder", () => {
    for (const m of MODES) {
      expect(specOf(m.mode)).toBe(m);
      expect(m.label, m.mode).toBeTruthy();
      expect(m.placeholder, m.mode).toBeTruthy();
    }
  });

  it("gives each mode a prefix of its own, and only the all mode none", () => {
    // Two modes on one character would make the second unreachable, and the
    // router takes the first match.
    const prefixes = MODES.map((m) => m.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(MODES.filter((m) => m.prefix === "").map((m) => m.mode)).toEqual(["all"]);
  });
});

describe("the line a : query names", () => {
  it("takes a plain line number", () => {
    expect(parseLine("120")).toBe(120);
  });

  it("refuses what is not a destination", () => {
    // Nothing typed yet is the mode being entered, not a request; the rest are
    // typos, and landing somewhere anyway is worse than saying so.
    for (const term of ["", "0", "-3", "12a", "1.5", " ", "1e3"]) {
      expect(parseLine(term), term).toBeNull();
    }
  });
});
