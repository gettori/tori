import { describe, it, expect } from "vitest";
import { toStore, pruneStale, parseStore, mergeStore, type TabStore, type OpenTabLike } from "./tabPersist";

const tab = (over: Partial<OpenTabLike> = {}): OpenTabLike => ({
  id: "t1",
  title: "shell",
  cwd: "/w/a",
  workspace: "/w/a",
  kind: "shell",
  program: "",
  args: [],
  ...over,
});

describe("toStore", () => {
  it("groups tabs by workspace, preserving order", () => {
    const out = toStore(
      [tab({ id: "1", title: "one" }), tab({ id: "2", title: "two" }), tab({ id: "3", workspace: "/w/b" })],
      {},
      100,
    );
    expect(out["/w/a"].tabs.map((t) => t.title)).toEqual(["one", "two"]);
    expect(out["/w/b"].tabs).toHaveLength(1);
  });

  it("records the active tab as an index into the stored order", () => {
    const out = toStore([tab({ id: "1" }), tab({ id: "2" })], { "/w/a": "2" }, 100);
    expect(out["/w/a"].active).toBe(1);
  });

  it("uses -1 when the workspace has no recorded active tab", () => {
    expect(toStore([tab()], {}, 100)["/w/a"].active).toBe(-1);
  });

  it("excludes command tabs, which must never be re-run on restore", () => {
    const out = toStore([tab({ id: "1" }), tab({ id: "2", kind: "command", title: "clone" })], {}, 100);
    expect(out["/w/a"].tabs.map((t) => t.title)).toEqual(["shell"]);
  });

  it("keeps an agent tab's sessionId and omits the key when absent", () => {
    const out = toStore([tab({ kind: "agent", program: "claude", sessionId: "abc" }), tab({ id: "2" })], {}, 100);
    expect(out["/w/a"].tabs[0].sessionId).toBe("abc");
    expect("sessionId" in out["/w/a"].tabs[1]).toBe(false);
  });

  it("indexes the active tab against the filtered list, not the raw open set", () => {
    // A command tab ahead of the active one would shift the index if the filter
    // and the index were computed against different lists.
    const out = toStore([tab({ id: "c", kind: "command" }), tab({ id: "1" }), tab({ id: "2" })], { "/w/a": "2" }, 100);
    expect(out["/w/a"].tabs).toHaveLength(2);
    expect(out["/w/a"].active).toBe(1);
  });
});

describe("mergeStore", () => {
  const stored: TabStore = {
    "/w/a": { tabs: [{ title: "a", cwd: "/w/a", kind: "shell", program: "", args: [] }], active: 0, savedAt: 1 },
    "/w/b": { tabs: [{ title: "b", cwd: "/w/b", kind: "shell", program: "", args: [] }], active: 0, savedAt: 1 },
  };

  it("carries untouched workspaces through, so an empty startup save erases nothing", () => {
    expect(mergeStore(stored, {}, new Set())).toEqual(stored);
  });

  it("erases a workspace this run opened and then emptied", () => {
    expect(Object.keys(mergeStore(stored, {}, new Set(["/w/a"])))).toEqual(["/w/b"]);
  });

  it("live entries win over stored ones for the same workspace", () => {
    const live = toStore([tab({ title: "fresh" })], {}, 500);
    const out = mergeStore(stored, live, new Set(["/w/a"]));
    expect(out["/w/a"].tabs.map((t) => t.title)).toEqual(["fresh"]);
    expect(out["/w/b"].tabs.map((t) => t.title)).toEqual(["b"]);
  });
});

describe("pruneStale", () => {
  const store: TabStore = {
    fresh: { tabs: [], active: -1, savedAt: 1000 },
    old: { tabs: [], active: -1, savedAt: 0 },
  };

  it("drops workspaces past the age cutoff and keeps the rest", () => {
    expect(Object.keys(pruneStale(store, 1500, 1000))).toEqual(["fresh"]);
  });

  it("keeps everything when nothing has aged out", () => {
    expect(Object.keys(pruneStale(store, 1000, 10_000)).sort()).toEqual(["fresh", "old"]);
  });
});

describe("parseStore", () => {
  it("returns empty for null, junk, and non-objects", () => {
    expect(parseStore(null)).toEqual({});
    expect(parseStore("not json")).toEqual({});
    expect(parseStore("[1,2]")).toEqual({});
  });

  it("round-trips a store written by toStore", () => {
    const written = toStore([tab({ kind: "agent", program: "claude", sessionId: "s" })], { "/w/a": "t1" }, 100);
    expect(parseStore(JSON.stringify(written))).toEqual(written);
  });

  it("drops entries whose tabs are malformed, keeping valid siblings", () => {
    const raw = JSON.stringify({
      good: { tabs: [{ title: "t", cwd: "/c", kind: "shell", program: "", args: [] }], active: 0, savedAt: 1 },
      bad: { tabs: [{ title: "t", kind: "nonsense" }], active: 0, savedAt: 1 },
      noStamp: { tabs: [{ title: "t", cwd: "/c", kind: "shell", program: "", args: [] }], active: 0 },
    });
    expect(Object.keys(parseStore(raw))).toEqual(["good"]);
  });
});
