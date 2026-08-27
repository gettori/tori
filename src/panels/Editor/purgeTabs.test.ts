import { describe, it, expect } from "vitest";
import { purgeTabsUnder, type TabMaps } from "./purgeTabs";
import { syntheticId } from "../../utils/syntheticTabs";

const t = (path: string) => ({ path, name: path.split("/").pop()! });

const maps = (): TabMaps<{ path: string; name: string }> => ({
  tabs: {
    "/space/one/main": [t("/space/one/main/a.ts"), t("/space/one/main/b.ts")],
    "/space/one/feat": [t("/space/one/feat/c.ts")],
    "/space/two/main": [t("/space/two/main/d.ts")],
  },
  active: {
    "/space/one/main": "/space/one/main/b.ts",
    "/space/one/feat": "/space/one/feat/c.ts",
    "/space/two/main": "/space/two/main/d.ts",
  },
});

describe("purgeTabsUnder", () => {
  it("sweeps every workspace under the deleted root, not only one", () => {
    // A space holds several branch-units; tabs in the ones currently off screen
    // would otherwise survive as tabs addressing a folder that is gone.
    const out = purgeTabsUnder(maps(), "/space/one");
    expect(out.tabs["/space/one/main"]).toEqual([]);
    expect(out.tabs["/space/one/feat"]).toEqual([]);
    expect(out.tabs["/space/two/main"]).toHaveLength(1);
  });

  it("leaves workspaces outside the deleted root untouched", () => {
    const out = purgeTabsUnder(maps(), "/space/one");
    expect(out.active["/space/two/main"]).toBe("/space/two/main/d.ts");
  });

  it("reports every removed path so the caller can clear path-keyed state", () => {
    const out = purgeTabsUnder(maps(), "/space/one");
    expect(out.removed.sort()).toEqual([
      "/space/one/feat/c.ts",
      "/space/one/main/a.ts",
      "/space/one/main/b.ts",
    ]);
  });

  it("clears the active tab of a workspace that lost everything", () => {
    const out = purgeTabsUnder(maps(), "/space/one");
    expect(out.active["/space/one/main"]).toBeNull();
    expect(out.active["/space/one/feat"]).toBeNull();
  });

  it("falls back to the last survivor when only the active tab went", () => {
    const out = purgeTabsUnder(maps(), "/space/one/main/b.ts");
    expect(out.tabs["/space/one/main"].map((x) => x.path)).toEqual(["/space/one/main/a.ts"]);
    expect(out.active["/space/one/main"]).toBe("/space/one/main/a.ts");
  });

  it("keeps an active tab that survived", () => {
    const out = purgeTabsUnder(maps(), "/space/one/main/a.ts");
    expect(out.active["/space/one/main"]).toBe("/space/one/main/b.ts");
  });

  it("returns the input maps untouched when nothing matches", () => {
    const input = maps();
    const out = purgeTabsUnder(input, "/space/three");
    expect(out.removed).toEqual([]);
    expect(out.tabs).toBe(input.tabs);
    expect(out.active).toBe(input.active);
  });

  it("does not treat a sibling with a shared prefix as being under the root", () => {
    // `/space/one-old` is not inside `/space/one`, and a plain prefix test would
    // say otherwise.
    const input: TabMaps<{ path: string; name: string }> = {
      tabs: { "/space/one-old": [t("/space/one-old/a.ts")] },
      active: { "/space/one-old": "/space/one-old/a.ts" },
    };
    const out = purgeTabsUnder(input, "/space/one");
    expect(out.removed).toEqual([]);
  });

  it("takes a synthetic tab with the workspace its id names", () => {
    const log = syntheticId("log", "/space/one/main");
    const input: TabMaps<{ path: string; name: string }> = {
      tabs: {
        "/space/one/main": [t("/space/one/main/a.ts"), { path: log, name: "Commit log" }],
        "/space/two/main": [t("/space/two/main/d.ts")],
      },
      active: { "/space/one/main": log, "/space/two/main": "/space/two/main/d.ts" },
    };
    const out = purgeTabsUnder(input, "/space/one");
    expect(out.tabs["/space/one/main"]).toEqual([]);
    expect(out.removed).toContain(log);
    expect(out.active["/space/one/main"]).toBeNull();
    // A log tab in another workspace is untouched.
    expect(out.tabs["/space/two/main"]).toHaveLength(1);
  });

  it("leaves a synthetic tab whose workspace is not under the deleted root", () => {
    const log = syntheticId("log", "/space/two/main");
    const input: TabMaps<{ path: string; name: string }> = {
      tabs: { "/space/two/main": [{ path: log, name: "Commit log" }] },
      active: { "/space/two/main": log },
    };
    const out = purgeTabsUnder(input, "/space/one");
    expect(out.removed).toEqual([]);
  });
});

// A results buffer spans a Feature's members, and its id carries the workspace
// key, which is not a folder at all. So the only thing that knows which repos
// the tab reaches into is the document, and the sweep has to ask.
describe("a results buffer's own roots", () => {
  const search = syntheticId("search", "feature:f1", "needle");
  const covers = (roots: string[]) => (id: string) => (id === search ? roots : null);
  const input = (): TabMaps<{ path: string; name: string }> => ({
    tabs: { "feature:f1": [{ path: search, name: "Search: needle" }] },
    active: { "feature:f1": search },
  });

  it("takes the tab when any one of its members is deleted", () => {
    // Dropped rather than trimmed: the line map is fixed at build time, so a
    // half-invalidated document cannot be repaired into an honest one.
    const out = purgeTabsUnder(input(), "/space/one", covers(["/space/one/api", "/space/two/web"]));
    expect(out.removed).toEqual([search]);
    expect(out.active["feature:f1"]).toBeNull();
  });

  it("leaves it alone when the deleted folder is none of them", () => {
    const out = purgeTabsUnder(input(), "/space/three", covers(["/space/one/api", "/space/two/web"]));
    expect(out.removed).toEqual([]);
    expect(out.tabs["feature:f1"]).toHaveLength(1);
  });

  it("falls back to the id's own workspace for a buffer that is gone", () => {
    // Evicted from the store, or never opened here. Scoping it to the id keeps
    // the branch-unit case working and errs towards keeping the tab, which is
    // the safe direction for a purge that skips the dirty prompt.
    const log = syntheticId("log", "/space/one/main");
    const maps: TabMaps<{ path: string; name: string }> = {
      tabs: { "/space/one/main": [{ path: log, name: "Commit log" }] },
      active: { "/space/one/main": log },
    };
    expect(purgeTabsUnder(maps, "/space/one", () => null).removed).toEqual([log]);
  });
});
