import { describe, it, expect } from "vitest";
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions } from "./searchOptions";
import {
  DRAFT,
  MAX_HISTORY,
  historyFor,
  noteQuery,
  parseHistoryStore,
  recallAt,
  stepRecall,
  type SearchHistoryStore,
} from "./searchHistory";

// What is pinned here is the promise recall makes: the arrows hand back a
// search the user actually ran, toggles and all, in the order they last cared
// about it. The wording of the panel that renders it is not this file's
// business.

const WS = "/proj";
const OTHER = "/other";
const opts = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  ...DEFAULT_SEARCH_OPTIONS,
  ...over,
});

describe("recording a query", () => {
  it("keeps the newest first", () => {
    let s: SearchHistoryStore = {};
    s = noteQuery(s, WS, "one", opts());
    s = noteQuery(s, WS, "two", opts());
    expect(historyFor(s, WS).map((h) => h.query)).toEqual(["two", "one"]);
  });

  it("remembers the toggles the query was run with", () => {
    // The whole reason an entry is a pair and not a string: recalling "needle"
    // without its regex flag hands back a search nobody ran.
    const s = noteQuery({}, WS, "needle", opts({ regex: true, include: "src/**" }));
    expect(recallAt(historyFor(s, WS), 0)?.options).toEqual(
      opts({ regex: true, include: "src/**" }),
    );
  });

  it("moves a repeated query to the front instead of duplicating it", () => {
    let s: SearchHistoryStore = {};
    s = noteQuery(s, WS, "one", opts());
    s = noteQuery(s, WS, "two", opts());
    s = noteQuery(s, WS, "one", opts());
    expect(historyFor(s, WS).map((h) => h.query)).toEqual(["one", "two"]);
  });

  it("keeps one entry per query, carrying the options it was last run with", () => {
    // Not one entry per (query, options) pair: toggling case and searching the
    // same word again is a correction, and the pair-keyed version would leave
    // two rows a control showing only the text cannot tell apart.
    let s = noteQuery({}, WS, "needle", opts());
    s = noteQuery(s, WS, "needle", opts({ case: true }));
    expect(historyFor(s, WS)).toEqual([{ query: "needle", options: opts({ case: true }) }]);
  });

  it("holds each workspace's queries apart", () => {
    let s = noteQuery({}, WS, "here", opts());
    s = noteQuery(s, OTHER, "there", opts());
    expect(historyFor(s, WS).map((h) => h.query)).toEqual(["here"]);
    expect(historyFor(s, OTHER).map((h) => h.query)).toEqual(["there"]);
  });

  it("drops the oldest once the list is full", () => {
    let s: SearchHistoryStore = {};
    for (let i = 0; i < 5; i++) s = noteQuery(s, WS, `q${i}`, opts(), [], 3);
    expect(historyFor(s, WS).map((h) => h.query)).toEqual(["q4", "q3", "q2"]);
  });

  it("records nothing for an empty query or an empty workspace", () => {
    expect(noteQuery({}, WS, "", opts())).toEqual({});
    expect(noteQuery({}, "", "needle", opts())).toEqual({});
  });

  it("copies the options in, so a later toggle does not rewrite history", () => {
    const live = opts();
    const s = noteQuery({}, WS, "needle", live);
    live.regex = true;
    expect(recallAt(historyFor(s, WS), 0)?.options.regex).toBe(false);
  });
});

describe("walking the history", () => {
  const three: SearchHistoryStore = ["a", "b", "c"].reduce<SearchHistoryStore>(
    (s, q) => noteQuery(s, WS, q, opts()),
    {},
  );
  const h = () => historyFor(three, WS); // ["c", "b", "a"]

  it("starts on the draft and goes back one at a time", () => {
    expect(stepRecall(h(), DRAFT, 1)).toBe(0);
    expect(stepRecall(h(), 0, 1)).toBe(1);
  });

  it("stops at the oldest rather than wrapping round to the draft", () => {
    // Wrapping would put the text you were typing back under your cursor on a
    // key you pressed to go *further* back, which reads as having lost it.
    expect(stepRecall(h(), 2, 1)).toBe(2);
  });

  it("comes forward to the draft and stops there", () => {
    expect(stepRecall(h(), 1, -1)).toBe(0);
    expect(stepRecall(h(), 0, -1)).toBe(DRAFT);
    expect(stepRecall(h(), DRAFT, -1)).toBe(DRAFT);
  });

  it("has nowhere to go when nothing has been searched here yet", () => {
    expect(stepRecall([], DRAFT, 1)).toBe(DRAFT);
    expect(recallAt([], DRAFT)).toBeNull();
  });

  it("reads the draft position as no entry at all", () => {
    expect(recallAt(h(), DRAFT)).toBeNull();
    expect(recallAt(h(), 99)).toBeNull();
    expect(recallAt(h(), 0)?.query).toBe("c");
  });
});

describe("reading a stored history back", () => {
  it("round-trips", () => {
    const s = noteQuery({}, WS, "needle", opts({ regex: true, exclude: "**/*.test.ts" }));
    expect(parseHistoryStore(JSON.stringify(s))).toEqual(s);
  });

  it("survives anything that is not a history", () => {
    expect(parseHistoryStore(null)).toEqual({});
    expect(parseHistoryStore("not json")).toEqual({});
    expect(parseHistoryStore('"a string"')).toEqual({});
    expect(parseHistoryStore("[1,2]")).toEqual({});
    expect(parseHistoryStore(JSON.stringify({ [WS]: 7 }))).toEqual({});
  });

  it("drops entries with no query and defaults options it cannot read", () => {
    // Last session's schema is the optimistic reading of what is in storage;
    // a `regex: "yes"` reaching `grep_project` would fail at the backend
    // boundary, which is a long way from where it could be explained.
    const raw = JSON.stringify({
      [WS]: [{ query: 7 }, { options: opts() }, { query: "ok", options: { regex: "yes" } }],
    });
    expect(historyFor(parseHistoryStore(raw), WS)).toEqual([
      { query: "ok", options: DEFAULT_SEARCH_OPTIONS },
    ]);
  });

  it("keeps the first of a duplicated query, so recall cannot show it twice", () => {
    const raw = JSON.stringify({ [WS]: [{ query: "a" }, { query: "a" }, { query: "b" }] });
    expect(historyFor(parseHistoryStore(raw), WS).map((h) => h.query)).toEqual(["a", "b"]);
  });

  it("round-trips a member restriction and reads a pre-restriction entry as unrestricted", () => {
    const restricted = noteQuery({}, WS, "needle", opts(), ["/repos/api", "/repos/web"]);
    expect(parseHistoryStore(JSON.stringify(restricted))).toEqual(restricted);
    expect(historyFor(restricted, WS)[0].repos).toEqual(["/repos/api", "/repos/web"]);

    // Every entry written before Phase 2 looks exactly like this one.
    const old = JSON.stringify({ [WS]: [{ query: "needle", options: opts() }] });
    expect(historyFor(parseHistoryStore(old), WS)[0].repos).toBeUndefined();
  });

  it("reads a restriction that is not a list of paths as no restriction at all", () => {
    // "Restricted to nothing" is a state that would search no member and report
    // no matches, so nothing in storage is allowed to spell it.
    const raw = JSON.stringify({
      [WS]: [{ query: "a", repos: [] }, { query: "b", repos: "/repos/api" }, { query: "c", repos: [7, ""] }],
    });
    expect(historyFor(parseHistoryStore(raw), WS).map((h) => h.repos)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("caps a file that grew past the limit", () => {
    const entries = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({ query: `q${i}` }));
    expect(historyFor(parseHistoryStore(JSON.stringify({ [WS]: entries })), WS).length).toBe(
      MAX_HISTORY,
    );
  });
});
