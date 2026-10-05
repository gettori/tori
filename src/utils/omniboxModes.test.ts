import { describe, it, expect } from "vite-plus/test";
import { MODES, parseLine, parseQuery, specOf } from "./omniboxModes";

describe("which mode a query selects", () => {
  it("looks at files when nothing says otherwise", () => {
    expect(parseQuery("")).toEqual({ mode: "file", term: "" });
    expect(parseQuery("index.ts")).toEqual({ mode: "file", term: "index.ts" });
  });

  it("routes each prefix to its mode", () => {
    expect(parseQuery(">save").mode).toBe("command");
    expect(parseQuery("@Thing").mode).toBe("doc");
    expect(parseQuery("#Thing").mode).toBe("workspace");
    expect(parseQuery(":120").mode).toBe("line");
    expect(parseQuery("?").mode).toBe("help");
  });

  it("strips the prefix and the space after it", () => {
    // The prefix is typed, then the query is thought about, so the space is
    // almost always there.
    expect(parseQuery("> save file").term).toBe("save file");
    expect(parseQuery(">save").term).toBe("save");
  });

  it("reads the prefix only at the start", () => {
    // A `#` inside a filename is part of the filename.
    expect(parseQuery("src/a#b.ts")).toEqual({ mode: "file", term: "src/a#b.ts" });
    expect(parseQuery("notes@work.md").mode).toBe("file");
  });

  it("treats a bare prefix as the mode being entered", () => {
    expect(parseQuery(">")).toEqual({ mode: "command", term: "" });
    expect(parseQuery(":")).toEqual({ mode: "line", term: "" });
  });

  it("gives every mode a spec, so nothing renders without a placeholder", () => {
    for (const m of MODES) {
      expect(specOf(m.mode)).toBe(m);
      expect(m.label, m.mode).toBeTruthy();
      expect(m.placeholder, m.mode).toBeTruthy();
    }
  });

  it("gives each mode a prefix of its own, and only one mode no prefix", () => {
    // Two modes on one character would make the second unreachable, and the
    // router takes the first match.
    const prefixes = MODES.map((m) => m.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.filter((p) => p === "")).toEqual([""]);
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
