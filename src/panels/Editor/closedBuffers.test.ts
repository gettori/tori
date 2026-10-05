// The rule a closed tab is kept by, without an editor around it.
//
// Two decisions live here and both can be got wrong quietly: which entry a full
// store gives up, and whether a kept buffer may be handed back at all. The
// second is the one with teeth, since a wrong yes replays an undo history
// against a document that has moved underneath it.
import { describe, it, expect } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect, foldedRanges } from "@codemirror/language";
import { rememberClosed, reviveClosed, MAX_CLOSED_BUFFERS, SERIALIZED_FIELDS } from "./closedBuffers";

/** Stands in for a stored entry: this module only ever reads `savedText`, and
 *  is generic over whatever the pane chooses to keep beside it. */
const buf = (savedText: string) => ({ savedText });

/** Close `n` files named by index, oldest first. */
function fill(store: Map<string, { savedText: string }>, n: number, cap?: number) {
  for (let i = 0; i < n; i++) rememberClosed(store, `/f${i}`, buf(`${i}`), cap);
  return store;
}

describe("keeping a closed buffer", () => {
  it("holds on to what was closed", () => {
    const store = new Map();
    rememberClosed(store, "/a", buf("one"));
    expect(reviveClosed(store, "/a", "one")).toEqual({ savedText: "one" });
  });

  it("gives up the least recently closed once it is full", () => {
    const store = fill(new Map(), 3, 2);
    expect([...store.keys()]).toEqual(["/f1", "/f2"]);
  });

  it("counts a re-close as recent, so a file kept in use is not the one dropped", () => {
    // The trap in using a plain Map as an LRU: `set` on an existing key leaves
    // its original insertion position, so a file closed, reopened and closed
    // again would still be evicted as though nobody had touched it since.
    const store = fill(new Map(), 3, 3);
    rememberClosed(store, "/f0", buf("0 again"), 3);
    rememberClosed(store, "/f3", buf("3"), 3);

    expect([...store.keys()]).toEqual(["/f2", "/f0", "/f3"]);
  });

  it("comes back down to a cap that moved beneath it", () => {
    const store = fill(new Map(), 5, 5);
    rememberClosed(store, "/f5", buf("5"), 2);
    expect([...store.keys()]).toEqual(["/f4", "/f5"]);
  });

  it("keeps a sane number of documents by default", () => {
    // Not a magic number worth pinning to the digit, but these entries hold
    // whole documents plus their undo histories, so an unbounded store or a
    // tab-store-sized one (30) would be a leak in everything but name.
    expect(MAX_CLOSED_BUFFERS).toBeGreaterThan(1);
    expect(MAX_CLOSED_BUFFERS).toBeLessThan(20);
    expect(fill(new Map(), MAX_CLOSED_BUFFERS + 4).size).toBe(MAX_CLOSED_BUFFERS);
  });
});

describe("handing a closed buffer back", () => {
  it("refuses one whose file has moved on without it", () => {
    // The history is a chain of positions into the document as it was. Against
    // different content those positions describe the wrong places, so a fresh
    // read is the only honest answer.
    const store = new Map();
    rememberClosed(store, "/a", buf("one"));
    expect(reviveClosed(store, "/a", "one, edited elsewhere")).toBeUndefined();
  });

  it("drops a refused buffer rather than keeping it for a later try", () => {
    // A file only moves further away, so the answer is already known to be no.
    const store = new Map();
    rememberClosed(store, "/a", buf("one"));
    reviveClosed(store, "/a", "changed");
    expect(store.size).toBe(0);
  });

  it("does not hand the same entry back twice", () => {
    // Taken, not read. Once a tab has been given the entry it owns that history
    // and goes on adding to it; a copy left behind is a snapshot of the file as
    // it was two reopens ago, waiting to be handed to a later one.
    const store = new Map();
    rememberClosed(store, "/a", buf("one"));
    expect(reviveClosed(store, "/a", "one")).toBeDefined();
    expect(reviveClosed(store, "/a", "one")).toBeUndefined();
  });

  it("says nothing for a file it never saw", () => {
    expect(reviveClosed(new Map(), "/never", "")).toBeUndefined();
  });

  it("compares the whole text, not its length", () => {
    const store = new Map();
    rememberClosed(store, "/a", buf("abc"));
    expect(reviveClosed(store, "/a", "abd")).toBeUndefined();
  });
});

describe("what a kept buffer carries", () => {
  it("keeps its folds", () => {
    const doc = "function f() {\n  return 1;\n}\n";
    const folded = EditorState.create({ doc, extensions: codeFolding() }).update({
      effects: foldEffect.of({ from: 14, to: 27 }),
    }).state;
    const json = folded.toJSON(SERIALIZED_FIELDS);
    const reopened = EditorState.fromJSON(json, { extensions: codeFolding() }, SERIALIZED_FIELDS);
    const ranges: [number, number][] = [];
    foldedRanges(reopened).between(0, doc.length, (from, to) => void ranges.push([from, to]));
    expect(ranges).toEqual([[14, 27]]);
  });
});
