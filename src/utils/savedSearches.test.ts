import { describe, it, expect } from "vite-plus/test";
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions } from "./searchOptions";
import {
  deleteSearch,
  nameTaken,
  parseSavedStore,
  renameSearch,
  saveSearch,
  savedFor,
  type SavedSearchStore,
} from "./savedSearches";

// A curated list, so what is pinned here is that it stays the list the user
// made: nothing reorders, nothing merges two entries into one, and a name is
// still a name after a round trip through storage.

const WS = "/proj";
const OTHER = "/other";
const opts = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  ...DEFAULT_SEARCH_OPTIONS,
  ...over,
});
const names = (s: SavedSearchStore, ws = WS) => savedFor(s, ws).map((x) => x.name);

/** Two saved searches, in the order they were added. */
const two = () => {
  const s = saveSearch({}, WS, "todos", "TODO", opts());
  return saveSearch(s, WS, "hooks", "use[A-Z]", opts({ regex: true }));
};

describe("saving", () => {
  it("appends, keeping the order they were added in", () => {
    expect(names(two())).toEqual(["todos", "hooks"]);
  });

  it("keeps the query and its toggles together", () => {
    expect(savedFor(two(), WS)[1]).toEqual({
      name: "hooks",
      query: "use[A-Z]",
      options: opts({ regex: true }),
    });
  });

  it("updates in place when the name is already there", () => {
    // Saving over a name you can see in the list is how you correct one, and
    // it must not shuffle the row you were aiming at somewhere else.
    const s = saveSearch(two(), WS, "todos", "TODO|FIXME", opts({ case: true }));
    expect(names(s)).toEqual(["todos", "hooks"]);
    expect(savedFor(s, WS)[0]).toEqual({
      name: "todos",
      query: "TODO|FIXME",
      options: opts({ case: true }),
    });
  });

  it("trims the name, so two rows cannot look identical", () => {
    const s = saveSearch(two(), WS, "  todos  ", "TODO", opts());
    expect(names(s)).toEqual(["todos", "hooks"]);
  });

  it("refuses a blank name or a blank query", () => {
    // A row with nothing to click on cannot be deleted either.
    expect(saveSearch({}, WS, "   ", "TODO", opts())).toEqual({});
    expect(saveSearch({}, WS, "todos", "", opts())).toEqual({});
  });

  it("holds each workspace's list apart", () => {
    const s = saveSearch(two(), OTHER, "todos", "TODO", opts());
    expect(names(s)).toEqual(["todos", "hooks"]);
    expect(names(s, OTHER)).toEqual(["todos"]);
  });

  it("copies the options in, so a later toggle does not rewrite what was saved", () => {
    const live = opts();
    const s = saveSearch({}, WS, "todos", "TODO", live);
    live.regex = true;
    expect(savedFor(s, WS)[0].options.regex).toBe(false);
  });

  it("reports a name as taken exactly when saving would overwrite", () => {
    expect(nameTaken(two(), WS, "todos")).toBe(true);
    expect(nameTaken(two(), WS, "  todos ")).toBe(true);
    expect(nameTaken(two(), WS, "TODOS")).toBe(false);
    expect(nameTaken(two(), OTHER, "todos")).toBe(false);
  });
});

describe("renaming", () => {
  it("keeps the entry where it was in the list", () => {
    const s = renameSearch(two(), WS, "todos", "chores");
    expect(names(s)).toEqual(["chores", "hooks"]);
    expect(savedFor(s, WS)[0].query).toBe("TODO");
  });

  it("refuses a name another entry already has", () => {
    // Merging two saved searches into one would destroy whichever the user
    // was not looking at, and there is no undo for a list like this.
    const s = renameSearch(two(), WS, "todos", "hooks");
    expect(names(s)).toEqual(["todos", "hooks"]);
    expect(savedFor(s, WS)[1].query).toBe("use[A-Z]");
  });

  it("refuses a blank name and shrugs at a rename to itself", () => {
    expect(names(renameSearch(two(), WS, "todos", "  "))).toEqual(["todos", "hooks"]);
    expect(names(renameSearch(two(), WS, "todos", "todos"))).toEqual(["todos", "hooks"]);
  });

  it("does nothing for a name that is not here", () => {
    expect(names(renameSearch(two(), WS, "nope", "chores"))).toEqual(["todos", "hooks"]);
  });
});

describe("deleting", () => {
  it("removes just that one", () => {
    expect(names(deleteSearch(two(), WS, "todos"))).toEqual(["hooks"]);
  });

  it("drops the workspace once its last search goes", () => {
    const s = deleteSearch(saveSearch({}, WS, "todos", "TODO", opts()), WS, "todos");
    expect(s).toEqual({});
  });

  it("returns the same store when there was nothing to delete", () => {
    const s = two();
    expect(deleteSearch(s, WS, "nope")).toBe(s);
  });
});

describe("reading a stored list back", () => {
  it("round-trips", () => {
    const s = two();
    expect(parseSavedStore(JSON.stringify(s))).toEqual(s);
  });

  it("survives anything that is not a saved list", () => {
    expect(parseSavedStore(null)).toEqual({});
    expect(parseSavedStore("not json")).toEqual({});
    expect(parseSavedStore('"a string"')).toEqual({});
    expect(parseSavedStore("[1,2]")).toEqual({});
    expect(parseSavedStore(JSON.stringify({ [WS]: 7 }))).toEqual({});
  });

  it("drops an entry missing a name or a query, and defaults unreadable options", () => {
    const raw = JSON.stringify({
      [WS]: [{ name: "x" }, { query: "TODO" }, { name: " ok ", query: "T", options: 7 }],
    });
    expect(savedFor(parseSavedStore(raw), WS)).toEqual([{ name: "ok", query: "T", options: DEFAULT_SEARCH_OPTIONS }]);
  });

  it("round-trips a member restriction and reads a pre-restriction entry as unrestricted", () => {
    const restricted = saveSearch({}, WS, "api todos", "TODO", opts(), ["/repos/api"]);
    expect(parseSavedStore(JSON.stringify(restricted))).toEqual(restricted);
    expect(savedFor(restricted, WS)[0].repos).toEqual(["/repos/api"]);

    // Every entry saved before Phase 2 looks exactly like this one.
    const old = JSON.stringify({ [WS]: [{ name: "todos", query: "TODO", options: opts() }] });
    expect(savedFor(parseSavedStore(old), WS)[0].repos).toBeUndefined();
  });

  it("keeps the first of a duplicated name, so delete cannot hit the wrong row", () => {
    const raw = JSON.stringify({
      [WS]: [
        { name: "todos", query: "TODO" },
        { name: "todos", query: "FIXME" },
      ],
    });
    expect(savedFor(parseSavedStore(raw), WS)).toEqual([
      { name: "todos", query: "TODO", options: DEFAULT_SEARCH_OPTIONS },
    ]);
  });
});
