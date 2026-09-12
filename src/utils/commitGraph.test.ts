import { describe, it, expect } from "vitest";

import { authorInitials, buildGraph, refPill } from "./commitGraph";
import type { LogEntry } from "../panels/Editor/CommitLog";

/** A log entry with only the fields the layout reads. */
const c = (sha: string, parents: string[] = [], unpushed = false): LogEntry => ({
  sha,
  short: sha.slice(0, 7),
  subject: sha,
  author: "Sk Arif",
  relative_date: "now",
  refs: [],
  parents,
  unpushed,
});

describe("lane layout", () => {
  it("keeps a straight history in one lane", () => {
    const { rows, width } = buildGraph([c("a", ["b"]), c("b", ["d"]), c("d", [])]);

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(width).toBe(1);
    // Every row's line runs straight down: nothing bends, so the drawing is a
    // single vertical.
    expect(rows.every((r) => r.edges.every((e) => e.from === e.to))).toBe(true);
  });

  it("gives a merge's second parent its own lane", () => {
    // m merges b into a's line. b then has to be somewhere other than lane 0.
    const { rows, width } = buildGraph([c("m", ["a", "b"]), c("a", ["base"]), c("b", ["base"])]);

    expect(rows[0].lane).toBe(0);
    expect(rows[0].merge).toBe(true);
    expect(rows[1].lane).toBe(0);
    // The second parent took a lane of its own rather than overwriting the
    // first parent's, which is the bug this test exists for.
    expect(rows[2].lane).toBe(1);
    expect(width).toBe(2);
  });

  it("draws a merge's fork as a bend, not two straight lines", () => {
    const { rows } = buildGraph([c("m", ["a", "b"]), c("a", ["base"]), c("b", ["base"])]);

    // The merge row sends a line out to lane 1, so one of its edges moves
    // sideways. Without it the second parent's line would start in mid-air.
    expect(rows[0].edges.some((e) => e.from !== e.to)).toBe(true);
  });

  it("brings two lanes back together at a shared ancestor", () => {
    const rows = buildGraph([
      c("m", ["a", "b"]),
      c("a", ["base"]),
      c("b", ["base"]),
      c("base", []),
    ]).rows;

    // base is the last row, and both lines end there: a merge of two branches
    // off one ancestor must not leave a lane hanging.
    expect(rows[3].lane).toBe(0);
    expect(rows[3].edges.some((e) => e.from === 1 && e.to === 0)).toBe(true);
  });

  it("starts a new lane for a commit nothing above it points at", () => {
    // Two unrelated tips on one page, which is what a page spanning branches
    // looks like.
    const { rows, width } = buildGraph([c("a", ["a2"]), c("b", ["b2"])]);

    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
    expect(width).toBe(2);
  });

  it("frees a lane once its line ends, so the next tip reuses it", () => {
    // a's line ends at root; b is a separate tip below it.
    const { rows, width } = buildGraph([c("a", ["root"]), c("root", []), c("b", [])]);

    expect(rows[2].lane).toBe(0);
    expect(width).toBe(1);
  });

  it("carries a parent below the page as a line off the bottom edge", () => {
    // A page is a window. `x`'s parent is never reached, and the lane it left
    // occupied is what tells the drawing to keep going past the last row.
    const { rows } = buildGraph([c("x", ["never-loaded"])]);

    expect(rows[0].edges).toEqual([{ from: 0, to: 0 }]);
  });

  it("marks a root commit but leaves no lane waiting for it", () => {
    const { rows, width } = buildGraph([c("only", [])]);

    expect(rows[0].merge).toBe(false);
    expect(width).toBe(1);
  });

  it("carries the unpushed flag through untouched", () => {
    const { rows } = buildGraph([c("a", ["b"], true), c("b", [])]);

    expect(rows.map((r) => r.entry.unpushed)).toEqual([true, false]);
  });
});

describe("ref pills", () => {
  it("tells the four kinds apart by what git spells inside the name", () => {
    expect(refPill("HEAD -> main")).toEqual({ label: "main", kind: "head" });
    expect(refPill("HEAD")).toEqual({ label: "HEAD", kind: "head" });
    expect(refPill("tag: v1.2")).toEqual({ label: "v1.2", kind: "tag" });
    expect(refPill("origin/main")).toEqual({ label: "origin/main", kind: "remote" });
    expect(refPill("wave-2")).toEqual({ label: "wave-2", kind: "branch" });
  });

  it("keeps a slash-bearing local branch readable", () => {
    // `feat/thing` reads as a remote by the slash test, which is wrong but
    // harmless: the label is the full name either way, so only the colour
    // differs. Pinned here so the trade is visible rather than discovered.
    expect(refPill("feat/thing").label).toBe("feat/thing");
  });
});

describe("author initials", () => {
  it("takes the first and last words", () => {
    expect(authorInitials("Sk Arif")).toBe("SA");
    expect(authorInitials("Fazlul Haque Arif")).toBe("FA");
  });

  it("takes one letter from a single word", () => {
    expect(authorInitials("arif")).toBe("A");
  });

  it("answers for an empty name rather than rendering a blank circle", () => {
    expect(authorInitials("   ")).toBe("?");
  });
});
