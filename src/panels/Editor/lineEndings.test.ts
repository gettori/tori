// Detection and normalization, with no editor in the way.
//
// The mounted half (`lineEndings.test.tsx`) proves the buffer round-trips a
// file; this half is about the decisions the round trip rests on: which ending
// wins when a file uses both, and that the three values `fromDisk` returns
// really are three views of one answer rather than three chances to disagree.
import { describe, it, expect } from "vitest";
import { detectEol, fromDisk } from "./lineEndings";

/** Every source file in this folder, as text. Vite's own glob rather than
 *  `node:fs`, so no `@types/node` is needed and the same import works whichever
 *  environment the file is run in. */
const PANEL_SOURCES = import.meta.glob<string>("./*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("detecting a file's ending", () => {
  it("reads a file written entirely one way", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
  });

  it("falls back to LF for a file with no break in it at all", () => {
    // A one-line file with no trailing newline says nothing about its own
    // ending, and the platform this app is written on is the tiebreaker.
    expect(detectEol("")).toBe("\n");
    expect(detectEol("just the one line")).toBe("\n");
  });

  it("takes the ending most of the file uses, not the first one it finds", () => {
    // Counting rather than sampling: one stray ending at the top of a file
    // would otherwise decide how the other thousand get written back.
    expect(detectEol("a\nb\r\nc\r\nd\r\n")).toBe("\r\n");
    expect(detectEol("a\r\nb\nc\nd\n")).toBe("\n");
  });

  it("does not read the CR of a CRLF as a second break", () => {
    // The trap in the naive count: scan for "\r" and for "\n" separately and
    // every CRLF file looks perfectly mixed, so CRLF never wins.
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
  });

  it("treats a lone CR as a break, but never as a candidate ending", () => {
    // Pre-OS X Mac files still split into the right lines; they are simply
    // written back as LF rather than getting a third case of their own.
    expect(detectEol("a\rb\rc")).toBe("\n");
    expect(fromDisk("a\rb\rc").lines).toEqual(["a", "b", "c"]);
  });
});

describe("the ban on the other way of reading a document", () => {
  it("finds no raw `toString` on a document left in the editor panel", () => {
    // `Text.toString()` joins with "\n" whatever the buffer's separator is, so
    // one surviving call is one surface that disagrees with all the others -
    // which is the entire shape of #43. A rule nothing checks is a comment, and
    // this repo has no linter to hang a `no-restricted-syntax` on, so the check
    // lives here. `sliceDoc()` is the replacement and reads identically on a
    // buffer that happens to be LF, which is why this is easy to regress.
    //
    // Matched by pattern rather than by substring on purpose: an escaped regex
    // source does not contain the call it matches, so this file does not flag
    // itself for holding the very thing it is looking for.
    const BANNED = /\.doc\.toString\(\)/;
    // A pattern that matched nothing, or a glob that found nothing, would both
    // pass this on an empty promise. So each is shown to have teeth first: the
    // sample is assembled from pieces so that writing it here does not trip the
    // very scan below.
    expect(BANNED.test(["view.state", "doc", "toString()"].join("."))).toBe(true);
    const files = Object.entries(PANEL_SOURCES);
    expect(files.map(([path]) => path)).toContain("./CodeEditor.tsx");
    expect(files.filter(([, src]) => BANNED.test(src)).map(([path]) => path)).toEqual([]);
  });
});

describe("what a file becomes in a buffer", () => {
  it("hands back lines with no ending left inside them", () => {
    expect(fromDisk("one\r\ntwo\r\n").lines).toEqual(["one", "two", ""]);
    expect(fromDisk("one\ntwo\n").lines).toEqual(["one", "two", ""]);
  });

  it("gives back exactly the bytes it was given, for a file written one way", () => {
    // The whole of the round trip: what the buffer reads back has to equal
    // what was on disk, or every comparison against the disk text is a
    // comparison of two different questions.
    for (const raw of ["one\r\ntwo\r\n", "one\ntwo\n", "", "no trailing break"]) {
      expect(fromDisk(raw).text).toBe(raw);
    }
  });

  it("settles a mixed file onto its dominant ending", () => {
    const mixed = fromDisk("one\r\ntwo\nthree\r\n");
    expect(mixed.eol).toBe("\r\n");
    expect(mixed.text).toBe("one\r\ntwo\r\nthree\r\n");
  });

  it("is idempotent, which is what lets a stashed conflict stay a plain string", () => {
    // `handleExternalChange` stashes the normalized text and `reloadConflict`
    // runs it back through here. If that second pass could change the answer,
    // "take disk" would adopt something other than what was compared.
    for (const raw of ["one\r\ntwo\nthree\r\n", "a\rb\rc", "one\ntwo\n"]) {
      const once = fromDisk(raw);
      const twice = fromDisk(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.eol).toBe(once.eol);
    }
  });

  it("keeps its three answers consistent with each other", () => {
    for (const raw of ["one\r\ntwo\r\n", "one\ntwo\nthree", "one\r\ntwo\nthree\r\n", ""]) {
      const { eol, lines, text } = fromDisk(raw);
      expect(lines.join(eol)).toBe(text);
      expect(detectEol(text)).toBe(eol);
    }
  });
});
