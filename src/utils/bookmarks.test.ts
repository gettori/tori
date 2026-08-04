import { describe, it, expect } from "vitest";
import {
  bookmarkRows,
  bookmarksFor,
  isBookmarked,
  labelBookmark,
  mapPaths,
  parseStore,
  setFileBookmarks,
  toggleBookmark,
  type BookmarkStore,
} from "./bookmarks";

// The marks themselves, without an editor. What is worth asserting here is the
// part that is a rule rather than a rendering: that a toggle is a toggle, that a
// label belongs to a mark and not to a line, and that a rename or a trash reaches
// every workspace's copy.

const WS = "/space/proj/main";
const OTHER = "/space/proj/feature";
const A = `${WS}/src/a.ts`;
const B = `${WS}/src/b.ts`;

const store = (): BookmarkStore => ({
  [WS]: { [A]: [{ line: 12 }, { line: 40, label: "the retry" }] },
});

describe("marking a line", () => {
  it("adds a mark that was not there", () => {
    const next = toggleBookmark({}, WS, A, 7);
    expect(bookmarksFor(next, WS, A)).toEqual([{ line: 7 }]);
  });

  it("takes away one that was, label and all", () => {
    // The label described that mark. A label with no mark is not something any
    // surface could show.
    const next = toggleBookmark(store(), WS, A, 40);
    expect(bookmarksFor(next, WS, A)).toEqual([{ line: 12 }]);
  });

  it("keeps a file's marks in line order however they were made", () => {
    let s = toggleBookmark({}, WS, A, 30);
    s = toggleBookmark(s, WS, A, 4);
    s = toggleBookmark(s, WS, A, 17);
    expect(bookmarksFor(s, WS, A).map((b) => b.line)).toEqual([4, 17, 30]);
  });

  it("forgets a file, and then a workspace, once the last mark is gone", () => {
    // Otherwise a workspace someone marked once and cleared would sit in storage
    // for the life of the install.
    const cleared = toggleBookmark(toggleBookmark(store(), WS, A, 12), WS, A, 40);
    expect(cleared).toEqual({});
  });

  it("keeps each workspace's marks to itself", () => {
    const s = toggleBookmark(store(), OTHER, `${OTHER}/src/a.ts`, 3);
    expect(bookmarksFor(s, WS, A)).toHaveLength(2);
    expect(bookmarksFor(s, OTHER, `${OTHER}/src/a.ts`)).toEqual([{ line: 3 }]);
  });

  it("answers whether a line is marked, which is what the gutter reads", () => {
    expect(isBookmarked(store(), WS, A, 12)).toBe(true);
    expect(isBookmarked(store(), WS, A, 13)).toBe(false);
    expect(isBookmarked(store(), WS, B, 12)).toBe(false);
  });

  it("hands back the same store when a replacement changes nothing", () => {
    // A caller holding this in a signal must not re-run its effects on a no-op,
    // and the buffer reports its marks after edits that did not move any.
    const s = store();
    expect(setFileBookmarks(s, WS, A, [{ line: 12 }, { line: 40, label: "the retry" }])).toBe(s);
  });
});

describe("naming a mark", () => {
  it("gives a mark a name", () => {
    const s = labelBookmark(store(), WS, A, 12, "  where it starts  ");
    expect(bookmarksFor(s, WS, A)[0]).toEqual({ line: 12, label: "where it starts" });
  });

  it("takes the name away again with an empty answer", () => {
    const s = labelBookmark(store(), WS, A, 40, "   ");
    expect(bookmarksFor(s, WS, A)[1]).toEqual({ line: 40 });
  });

  it("does not mark a line just because someone named it", () => {
    // A label is a property of a bookmark, not a second way to make one.
    expect(labelBookmark(store(), WS, A, 99, "nope")).toEqual(store());
  });
});

describe("the list the panel reads", () => {
  it("goes by path then by line, so the order does not move under you", () => {
    let s = store();
    s = toggleBookmark(s, WS, B, 5);
    s = toggleBookmark(s, WS, B, 1);
    expect(bookmarkRows(s, WS)).toEqual([
      { path: A, line: 12 },
      { path: A, line: 40, label: "the retry" },
      { path: B, line: 1 },
      { path: B, line: 5 },
    ]);
  });

  it("shows only the workspace asked for", () => {
    expect(bookmarkRows(store(), OTHER)).toEqual([]);
  });
});

describe("following the file", () => {
  it("keeps a renamed file's marks attached to it", () => {
    const moved = `${WS}/src/renamed.ts`;
    const s = mapPaths(store(), (p) => (p === A ? moved : p));
    expect(bookmarksFor(s, WS, A)).toEqual([]);
    expect(bookmarksFor(s, WS, moved)).toEqual([{ line: 12 }, { line: 40, label: "the retry" }]);
  });

  it("leaves nothing behind for a trashed file", () => {
    const s = mapPaths(store(), (p) => (p === A ? null : p));
    expect(bookmarkRows(s, WS)).toEqual([]);
  });

  it("reaches every workspace, not only the one on screen", () => {
    // A folder renamed on disk is renamed for all of them, and the lists off
    // screen are exactly the ones nobody would notice going stale.
    const s: BookmarkStore = { ...store(), [OTHER]: { [`${OTHER}/x.ts`]: [{ line: 2 }] } };
    const swept = mapPaths(s, () => null);
    expect(swept).toEqual({});
  });

  it("merges a rename onto a file that already had marks, keeping the labels", () => {
    // They are the same file now, and dropping either side would silently throw
    // away something a person put there by hand.
    const s: BookmarkStore = { [WS]: { [A]: [{ line: 12, label: "kept" }], [B]: [{ line: 12 }, { line: 3 }] } };
    const merged = mapPaths(s, (p) => (p === A ? B : p));
    expect(bookmarksFor(merged, WS, B)).toEqual([{ line: 3 }, { line: 12, label: "kept" }]);
  });

  it("does not write into the store it was given", () => {
    // The merge above fills in a missing label, and the marks it reads belong to
    // the caller: writing one would edit the very thing this returns a new
    // version of, and a signal holding it would never see the change.
    const s: BookmarkStore = { [WS]: { [A]: [{ line: 12, label: "kept" }], [B]: [{ line: 12 }] } };
    mapPaths(s, (p) => (p === A ? B : p));
    expect(s[WS][B]).toEqual([{ line: 12 }]);
  });

  it("hands back the same store when nothing matched", () => {
    const s = store();
    expect(mapPaths(s, (p) => p)).toBe(s);
  });
});

describe("reading what was stored", () => {
  it("survives a round trip", () => {
    expect(parseStore(JSON.stringify(store()))).toEqual(store());
  });

  it("reads junk as nothing marked rather than throwing on startup", () => {
    expect(parseStore(null)).toEqual({});
    expect(parseStore("not json")).toEqual({});
    expect(parseStore('"a string"')).toEqual({});
    expect(parseStore(JSON.stringify({ [WS]: 7 }))).toEqual({});
  });

  it("drops a mark that names no line an editor could scroll to", () => {
    const raw = JSON.stringify({ [WS]: { [A]: [{ line: 0 }, { line: -3 }, { line: 2.5 }, { line: 9 }] } });
    expect(bookmarksFor(parseStore(raw), WS, A)).toEqual([{ line: 9 }]);
  });

  it("collapses a line stored twice", () => {
    const raw = JSON.stringify({ [WS]: { [A]: [{ line: 4 }, { line: 4, label: "again" }] } });
    expect(bookmarksFor(parseStore(raw), WS, A)).toEqual([{ line: 4 }]);
  });
});
