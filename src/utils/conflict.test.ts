import { describe, it, expect } from "vitest";
import {
  conflictRegions,
  conflictsOnly,
  deletedSides,
  nextConflict,
  prevConflict,
  resolvedText,
  sideLabels,
  unresolved,
  type Choice,
  type ConflictRegion,
} from "./conflict";

// The three-way model, tested as three texts in and regions out. No mount and
// no repo: the alignment between base, ours and theirs is the part that can be
// wrong, and it is pure.

/** `from-to` per side, which is the whole assertion for most of these. */
const spans = (r: ConflictRegion) =>
  `base ${r.base.from}-${r.base.to} ours ${r.ours.from}-${r.ours.to} theirs ${r.theirs.from}-${r.theirs.to}`;

describe("naming the sides", () => {
  it("calls stage 2 yours under a merge", () => {
    const l = sideLabels("merge");
    expect(l.yours).toBe("ours");
    expect(l.ours).toMatch(/Yours/);
  });

  it("calls stage 3 yours under a rebase, on the same stages", () => {
    // The inversion this exists for: a rebase checks out the upstream and
    // replays your commits onto it, so the side git is "already on" is not
    // yours. Labelling it yours reads perfectly and points at the wrong work.
    const l = sideLabels("rebase");
    expect(l.yours).toBe("theirs");
    expect(l.theirs).toMatch(/Yours/);
    expect(l.ours).not.toMatch(/Yours/);
    // Same stages, opposite answers.
    expect(sideLabels("merge").yours).not.toBe(l.yours);
  });

  it("keeps the merge orientation for a cherry-pick, a revert, and a bare conflict", () => {
    // These replay a commit onto HEAD without moving HEAD, so stage 2 is still
    // where you are. `none` is where a conflicted `git stash apply` lands.
    for (const op of ["cherrypick", "revert", "none"] as const) {
      expect(sideLabels(op).yours).toBe("ours");
    }
    // They are still told apart in words: "Incoming" is a branch, and the
    // commit a cherry-pick is applying is not.
    expect(sideLabels("cherrypick").theirs).not.toBe(sideLabels("merge").theirs);
  });
});

describe("finding the regions", () => {
  it("finds nothing when neither side moved", () => {
    const same = "one\ntwo\nthree\n";
    expect(conflictRegions(same, same, same)).toEqual([]);
  });

  it("gives two conflicts their own regions, with the right lines on all three sides", () => {
    // Two spots both sides rewrote, far enough apart to stay separate, and an
    // insertion by ours in between so the line numbers really do diverge.
    const base = ["one", "two", "three", "four", "five", "six", "seven", ""].join("\n");
    const ours = ["one", "OURS-A", "three", "EXTRA", "four", "five", "OURS-B", "seven", ""].join("\n");
    const theirs = ["one", "THEIRS-A", "three", "four", "five", "THEIRS-B", "seven", ""].join("\n");

    const conflicts = conflictsOnly(conflictRegions(base, ours, theirs));

    expect(conflicts).toHaveLength(2);
    // Line 2 on every side: nothing before it has moved yet.
    expect(spans(conflicts[0])).toBe("base 2-3 ours 2-3 theirs 2-3");
    // Base line 6, which ours has pushed down one by its insertion and theirs
    // has not. Getting this wrong is how a resolution lands on the wrong line.
    expect(spans(conflicts[1])).toBe("base 6-7 ours 7-8 theirs 6-7");
  });

  it("does not call a change only one side made a conflict", () => {
    const base = ["one", "two", "three", ""].join("\n");
    const ours = ["one", "OURS", "three", ""].join("\n");

    const regions = conflictRegions(base, ours, base);

    // The region is still reported - it is a change to carry into the result -
    // but it needs no decision, so it is not a conflict.
    expect(regions).toHaveLength(1);
    expect(regions[0].both).toBe(false);
    expect(conflictsOnly(regions)).toEqual([]);
    // And the side that did nothing still gets the matching lines, so the panes
    // can line the region up rather than leaving one of them with no range.
    expect(spans(regions[0])).toBe("base 2-3 ours 2-3 theirs 2-3");
  });

  it("does not make a conflict out of two people making the same edit", () => {
    // git merges this without a word, and so should we: a choice between two
    // identical versions has no wrong answer and no right one, and putting it
    // in the walk means the reader stops at something they cannot decide.
    const base = ["one", "two", "three", ""].join("\n");
    const same = ["one", "SAME", "three", ""].join("\n");

    const regions = conflictRegions(base, same, same);

    // Still a region: the result needs the change, whichever side it is taken
    // from. Just not a decision.
    expect(regions).toHaveLength(1);
    expect(regions[0].both).toBe(false);
    expect(conflictsOnly(regions)).toEqual([]);
  });

  it("joins two changes with no unchanged line between them", () => {
    // git's own rule: with nothing to anchor them apart it writes them inside
    // one pair of markers, so they are one decision, not two.
    const base = ["one", "two", "three", "four", ""].join("\n");
    const ours = ["one", "OURS", "three", "four", ""].join("\n");
    const theirs = ["one", "two", "THEIRS", "four", ""].join("\n");

    const regions = conflictRegions(base, ours, theirs);

    expect(regions).toHaveLength(1);
    expect(regions[0].both).toBe(true);
    expect(regions[0].base).toEqual({ from: 2, to: 4 });
  });

  it("keeps two changes with a line between them apart", () => {
    // One unchanged line is all it takes, and it is the difference between one
    // decision and two.
    const base = ["one", "two", "three", "four", "five", ""].join("\n");
    const ours = ["OURS", "two", "three", "four", "five", ""].join("\n");
    const theirs = ["one", "two", "THEIRS", "four", "five", ""].join("\n");

    const regions = conflictRegions(base, ours, theirs);

    expect(regions).toHaveLength(2);
    expect(regions.every((r) => !r.both)).toBe(true);
  });

  it("makes two insertions at the same point one region rather than two of no width", () => {
    const base = ["one", "two", ""].join("\n");
    const ours = ["one", "OURS", "two", ""].join("\n");
    const theirs = ["one", "THEIRS", "two", ""].join("\n");

    const regions = conflictRegions(base, ours, theirs);

    expect(regions).toHaveLength(1);
    expect(regions[0].both).toBe(true);
    // Nothing of the base is involved, so its range is the point they were both
    // inserted at, and each side's range is the line it put there.
    expect(spans(regions[0])).toBe("base 2-2 ours 2-3 theirs 2-3");
  });

  it("treats a side that deleted the file as contributing no lines", () => {
    // What a delete/modify conflict looks like once the missing stage arrives
    // as an empty string: one region covering everything, needing a decision.
    const base = ["one", "two", ""].join("\n");
    const ours = ["one", "OURS", ""].join("\n");

    const regions = conflictRegions(base, ours, "");

    expect(regions).toHaveLength(1);
    expect(regions[0].both).toBe(true);
    expect(regions[0].theirs.from).toBe(regions[0].theirs.to);
  });

  it("treats a file both sides created as one conflict over the whole thing", () => {
    // An add/add conflict: no common ancestor, so every line of both is new.
    const regions = conflictRegions("", "ours\nlines\n", "theirs\n");

    expect(regions).toHaveLength(1);
    expect(regions[0].both).toBe(true);
    expect(regions[0].ours).toEqual({ from: 1, to: 3 });
    expect(regions[0].theirs).toEqual({ from: 1, to: 2 });
  });

  it("covers the last line of a file that does not end in a newline", () => {
    // The off-by-one at the end of the document: the range stops mid-line
    // rather than at a line start, so a plain `lineAt` would leave the line
    // everybody is arguing about outside the region.
    const regions = conflictRegions("one\ntwo", "one\nOURS", "one\nTHEIRS");

    expect(regions).toHaveLength(1);
    expect(regions[0].base).toEqual({ from: 2, to: 3 });
    expect(regions[0].ours).toEqual({ from: 2, to: 3 });
  });
});

describe("identity that survives a resolution", () => {
  it("keeps a region's name when an earlier one is resolved", () => {
    // The property the id exists for, and the one Phase 12 will lean on:
    // resolving a conflict recomputes the model, and every region still to be
    // decided has to come back under the name it already had. An index
    // renumbers the survivors the moment one ahead of them disappears, so a
    // reference held across the resolution would silently point at a neighbour.
    // The first conflict is two lines on ours and one on theirs, so taking
    // theirs shortens ours and every line below it moves. That is exactly the
    // case an id built from a line number cannot survive.
    const base = ["one", "two", "three", "four", ""].join("\n");
    const ours = ["one", "OURS-A1", "OURS-A2", "three", "OURS-B", ""].join("\n");
    const theirs = ["one", "THEIRS-A", "three", "THEIRS-B", ""].join("\n");
    const before = conflictsOnly(conflictRegions(base, ours, theirs));
    expect(before).toHaveLength(2);

    // The first conflict taken as theirs: both sides now say the same thing
    // there, so it needs no decision and drops out of the list.
    const resolved = ["one", "THEIRS-A", "three", "OURS-B", ""].join("\n");
    const after = conflictsOnly(conflictRegions(base, resolved, theirs));

    expect(after).toHaveLength(1);
    // The second conflict sits a line higher on ours than it did, and is the
    // same conflict.
    expect(before[1].ours.from).not.toBe(after[0].ours.from);
    expect(after[0].id).toBe(before[1].id);
    expect(new Set(before.map((r) => r.id)).size).toBe(before.length);
  });
});

describe("building the resolved file", () => {
  // Two conflicts with an ours-only insertion between them, so the result has
  // to carry a change nobody was asked about and the line numbers on the two
  // sides really do differ.
  const base = ["one", "two", "three", "four", "five", "six", "seven", ""].join("\n");
  const ours = ["one", "OURS-A", "three", "EXTRA", "four", "five", "OURS-B", "seven", ""].join("\n");
  const theirs = ["one", "THEIRS-A", "three", "four", "five", "THEIRS-B", "seven", ""].join("\n");
  const stages = { base, ours, theirs, binary: false };
  const regions = conflictRegions(base, ours, theirs);
  const all = (choice: Choice): Record<string, Choice> =>
    Object.fromEntries(conflictsOnly(regions).map((r) => [r.id, choice]));

  it("reproduces a side exactly when every region is taken from it", () => {
    // The property the whole reconstruction rests on: the walk copies the base
    // between regions and the chosen side's own lines inside them, so choosing
    // one side everywhere has to give that side's file back byte for byte. Any
    // drift in the spans shows up here before it shows up in someone's repo.
    // Every region here is disputed, so nothing is carried across and the two
    // answers are the two files.
    const b = ["one", "two", "three", "four", "five", ""].join("\n");
    const o = ["one", "OURS-A", "three", "OURS-B", "five", ""].join("\n");
    const t = ["one", "THEIRS-A", "three", "THEIRS-B", "five", ""].join("\n");
    const rs = conflictRegions(b, o, t);
    const s = { base: b, ours: o, theirs: t, binary: false };

    expect(resolvedText(s, rs, all2(rs, "ours"))).toBe(o);
    expect(resolvedText(s, rs, all2(rs, "theirs"))).toBe(t);
  });

  it("carries a change only one side made, whichever side is chosen", () => {
    // `EXTRA` is nobody's decision: theirs never touched those lines, so taking
    // theirs at both conflicts must not drop it. Losing it is how a merge tool
    // silently reverts work that was never in dispute.
    const taken = resolvedText(stages, regions, all("theirs"))!;

    expect(taken).toContain("EXTRA");
    expect(taken).toBe(
      ["one", "THEIRS-A", "three", "EXTRA", "four", "five", "THEIRS-B", "seven", ""].join("\n"),
    );
  });

  it("keeps both versions in git's own order when both are accepted", () => {
    const taken = resolvedText(stages, regions, all("both"))!;

    expect(taken).toBe(
      // Ours then theirs, at each conflict: the order the markers had, so the
      // result reads the way the file already did.
      ["one", "OURS-A", "THEIRS-A", "three", "EXTRA", "four", "five", "OURS-B", "THEIRS-B", "seven", ""].join("\n"),
    );
  });

  it("resolves one conflict without touching the other", () => {
    const [first, second] = conflictsOnly(regions);

    const taken = resolvedText(stages, regions, { [first.id]: "theirs", [second.id]: "ours" })!;

    expect(taken).toBe(
      ["one", "THEIRS-A", "three", "EXTRA", "four", "five", "OURS-B", "seven", ""].join("\n"),
    );
  });

  it("refuses to build a file while a conflict is undecided", () => {
    // A half-resolved file that looks finished is worse than no file: it would
    // be staged as the answer, and the side that lost was never chosen.
    const [first] = conflictsOnly(regions);

    expect(unresolved(regions, {})).toHaveLength(2);
    expect(resolvedText(stages, regions, {})).toBeNull();
    expect(unresolved(regions, { [first.id]: "ours" })).toEqual([conflictsOnly(regions)[1]]);
    expect(resolvedText(stages, regions, { [first.id]: "ours" })).toBeNull();
  });

  it("needs no decision at all for a file only one side changed", () => {
    const oneSided = conflictRegions(base, ours, base);

    expect(unresolved(oneSided, {})).toEqual([]);
    expect(resolvedText({ base, ours, theirs: base, binary: false }, oneSided, {})).toBe(ours);
  });

  it("rebuilds a file both sides created from scratch", () => {
    // An add/add conflict has no base to walk between, so the whole file is one
    // region and the trailing empty line is all the walk has to work with.
    const addAdd = { base: null, ours: "ours\nlines\n", theirs: "theirs\n", binary: false };
    const rs = conflictRegions("", addAdd.ours, addAdd.theirs);

    expect(resolvedText(addAdd, rs, all2(rs, "ours"))).toBe("ours\nlines\n");
    expect(resolvedText(addAdd, rs, all2(rs, "theirs"))).toBe("theirs\n");
  });

  it("keeps a file that does not end in a newline ending that way", () => {
    const rs = conflictRegions("one\ntwo", "one\nOURS", "one\nTHEIRS");
    const s = { base: "one\ntwo", ours: "one\nOURS", theirs: "one\nTHEIRS", binary: false };

    expect(resolvedText(s, rs, all2(rs, "ours"))).toBe("one\nOURS");
  });
});

/** Every conflict in `rs` decided the same way. */
function all2(rs: ConflictRegion[], choice: Choice): Record<string, Choice> {
  return Object.fromEntries(conflictsOnly(rs).map((r) => [r.id, choice]));
}

describe("a conflict about whether the file exists", () => {
  it("names the side that deleted it", () => {
    // The stage is absent, not empty: "accept theirs" here means the file is
    // gone, and offering it as a way to produce an empty file would resolve the
    // merge into something neither side asked for.
    expect(deletedSides({ base: "one\n", ours: "OURS\n", theirs: null, binary: false })).toEqual([
      "theirs",
    ]);
    expect(deletedSides({ base: "one\n", ours: null, theirs: "THEIRS\n", binary: false })).toEqual([
      "ours",
    ]);
    // Both deleted it, differently enough that git could not say so itself.
    expect(deletedSides({ base: "one\n", ours: null, theirs: null, binary: false })).toEqual([
      "ours",
      "theirs",
    ]);
  });

  it("is not what an add/add conflict is", () => {
    // No base, but both sides have a version: this one really is about lines.
    expect(deletedSides({ base: null, ours: "a\n", theirs: "b\n", binary: false })).toEqual([]);
  });
});

describe("walking the conflicts", () => {
  const base = ["a", "b", "c", "d", "e", "f", "g", ""].join("\n");
  const ours = ["a", "O1", "c", "ONLY-OURS", "e", "O2", "g", ""].join("\n");
  const theirs = ["a", "T1", "c", "d", "e", "T2", "g", ""].join("\n");
  const regions = conflictRegions(base, ours, theirs);

  it("hits every conflict once, in order, and then stops", () => {
    expect(conflictsOnly(regions)).toHaveLength(2);

    const seen: string[] = [];
    let at: string | null = null;
    for (;;) {
      const n: ConflictRegion | null = nextConflict(regions, at);
      if (!n) break;
      seen.push(n.id);
      at = n.id;
    }

    expect(seen).toEqual(conflictsOnly(regions).map((r) => r.id));
    // Not a loop: "there is another one" and "you have seen them all" have to
    // be different answers, or walking the file tells you nothing.
    expect(nextConflict(regions, seen[seen.length - 1])).toBeNull();
  });

  it("skips the change only one side made", () => {
    // It is in the region list, because the result needs it, but it is not a
    // stop on the walk: there is nothing to decide.
    const oneSided = regions.filter((r) => !r.both);
    expect(oneSided.length).toBeGreaterThan(0);
    const walked = [nextConflict(regions, null)!.id, nextConflict(regions, conflictsOnly(regions)[0].id)!.id];
    expect(walked).not.toContain(oneSided[0].id);
  });

  it("walks back the same way", () => {
    const [first, second] = conflictsOnly(regions);
    expect(prevConflict(regions, second.id)?.id).toBe(first.id);
    expect(prevConflict(regions, first.id)).toBeNull();
    expect(prevConflict(regions, null)).toBeNull();
  });
});
