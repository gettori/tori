import { describe, it, expect } from "vitest";

import {
  addWatch,
  loadWatches,
  moveWatch,
  parseWatchStore,
  removeWatch,
  saveWatches,
  watchesFor,
  MAX_WATCHES,
  type WatchStore,
} from "./watches";

// The rules about a watch list, with no debug run anywhere near them. The
// evaluating half is `debugWatch.ts` and is tested against a fake adapter.

const A = "/space/proj/main";
const B = "/space/proj/feature";

describe("adding", () => {
  it("appends in the order they were written", () => {
    let store: WatchStore = {};
    store = addWatch(store, A, "count");
    store = addWatch(store, A, "user.name");

    expect(watchesFor(store, A)).toEqual(["count", "user.name"]);
  });

  it("trims, and refuses a blank", () => {
    let store: WatchStore = {};
    store = addWatch(store, A, "  total  ");
    const before = store;
    store = addWatch(store, A, "   ");

    expect(watchesFor(store, A)).toEqual(["total"]);
    // The same object, so a caller holding it in a signal does not re-render.
    expect(store).toBe(before);
  });

  it("refuses a duplicate rather than adding a second row", () => {
    let store: WatchStore = addWatch({}, A, "count");
    const before = store;
    store = addWatch(store, A, "count");

    // Two identical expressions answer identically forever, so the second is
    // only a request per stop and a row to scroll past.
    expect(watchesFor(store, A)).toEqual(["count"]);
    expect(store).toBe(before);
  });

  it("stops at the cap", () => {
    let store: WatchStore = {};
    for (let i = 0; i < MAX_WATCHES + 5; i++) store = addWatch(store, A, `e${i}`);

    // Every watch is re-read on every stop, and a stop happens on every step.
    expect(watchesFor(store, A)).toHaveLength(MAX_WATCHES);
  });

  it("keeps workspaces apart", () => {
    let store: WatchStore = addWatch({}, A, "count");
    store = addWatch(store, B, "other");

    expect(watchesFor(store, A)).toEqual(["count"]);
    expect(watchesFor(store, B)).toEqual(["other"]);
  });
});

describe("removing", () => {
  it("drops the one named and keeps the rest in order", () => {
    let store: WatchStore = addWatch(addWatch(addWatch({}, A, "a"), A, "b"), A, "c");
    store = removeWatch(store, A, 1);

    expect(watchesFor(store, A)).toEqual(["a", "c"]);
  });

  it("drops a workspace left with none rather than keeping an empty record", () => {
    let store: WatchStore = addWatch({}, A, "a");
    store = removeWatch(store, A, 0);

    expect(store).toEqual({});
  });

  it("is a no-op out of range", () => {
    const store: WatchStore = addWatch({}, A, "a");
    expect(removeWatch(store, A, 4)).toBe(store);
    expect(removeWatch(store, A, -1)).toBe(store);
  });
});

describe("reordering", () => {
  const three = () => addWatch(addWatch(addWatch({}, A, "a"), A, "b"), A, "c");

  it("moves a row up", () => {
    expect(watchesFor(moveWatch(three(), A, 2, 0), A)).toEqual(["c", "a", "b"]);
  });

  it("moves a row down", () => {
    expect(watchesFor(moveWatch(three(), A, 0, 2), A)).toEqual(["b", "c", "a"]);
  });

  it("is a no-op for a stale or out-of-range index", () => {
    const store = three();
    // A row cannot be reordered off the list by an index the pane held from
    // before a removal.
    expect(moveWatch(store, A, 0, 3)).toBe(store);
    expect(moveWatch(store, A, 5, 0)).toBe(store);
    expect(moveWatch(store, A, 1, 1)).toBe(store);
  });
});

describe("what survives a reload", () => {
  it("survives storage being unavailable", () => {
    // Node has no `localStorage`, which is the same shape as private mode: the
    // reader answers "nothing set" and the writer swallows, rather than either
    // one throwing on startup.
    expect(loadWatches()).toEqual({});
    expect(() => saveWatches(addWatch({}, A, "count"))).not.toThrow();
  });

  it("drops anything that is not a list of strings", () => {
    // This outlives the version that wrote it, so nothing in it is trusted.
    expect(parseWatchStore('{"/w": ["ok", 3, null, "  ", "fine"]}')).toEqual({
      "/w": ["ok", "fine"],
    });
    expect(parseWatchStore('{"/w": "not a list"}')).toEqual({});
    expect(parseWatchStore("[1,2,3]")).toEqual({});
    expect(parseWatchStore("not json")).toEqual({});
    expect(parseWatchStore(null)).toEqual({});
  });

  it("de-duplicates and caps what it read", () => {
    const raw = JSON.stringify({ "/w": ["a", "a", "b"] });
    expect(parseWatchStore(raw)).toEqual({ "/w": ["a", "b"] });
  });
});
