import { describe, it, expect } from "vitest";
import {
  toStore,
  capTabs,
  mergeStore,
  pruneStale,
  restoreFor,
  parseStore,
  type FileTabStore,
  type OpenFileTabLike,
} from "./editorTabPersist";
import { syntheticId } from "./syntheticTabs";

const tab = (path: string, workspace = "/w/a"): OpenFileTabLike => ({ path, workspace });

describe("toStore", () => {
  it("groups paths by workspace, preserving strip order", () => {
    const out = toStore([tab("/w/a/one.ts"), tab("/w/a/two.ts"), tab("/w/b/x.ts", "/w/b")], {}, 100);
    expect(out["/w/a"].paths).toEqual(["/w/a/one.ts", "/w/a/two.ts"]);
    expect(out["/w/b"].paths).toEqual(["/w/b/x.ts"]);
  });

  it("records the active tab as a path, per workspace", () => {
    const out = toStore(
      [tab("/w/a/one.ts"), tab("/w/a/two.ts"), tab("/w/b/x.ts", "/w/b")],
      { "/w/a": "/w/a/two.ts", "/w/b": "/w/b/x.ts" },
      100,
    );
    expect(out["/w/a"].active).toBe("/w/a/two.ts");
    expect(out["/w/b"].active).toBe("/w/b/x.ts");
  });

  it("leaves active null when the workspace has no recorded active tab", () => {
    const out = toStore([tab("/w/a/one.ts")], {}, 100);
    expect(out["/w/a"].active).toBeNull();
  });

  it("never writes an entry under an empty key", () => {
    // Tabs opened before a selection resolved belong to no workspace, and a key
    // nothing can be selected as is a key nothing can restore from.
    const out = toStore([tab("/orphan.ts", ""), tab("/w/a/one.ts")], {}, 100);
    expect(Object.keys(out)).toEqual(["/w/a"]);
  });

  it("never stores a synthetic view, nor records one as the active tab", () => {
    // A relaunch restores files; a commit log is opened on request, and every
    // stored path is probed for existence, which a `sway://` id can never pass.
    const log = syntheticId("log", "/w/a");
    const out = toStore([tab(log), tab("/w/a/one.ts")], { "/w/a": log }, 100);
    expect(out["/w/a"].paths).toEqual(["/w/a/one.ts"]);
    expect(out["/w/a"].active).toBeNull();
  });

  it("writes no entry for a workspace holding only a synthetic view", () => {
    expect(toStore([tab(syntheticId("log", "/w/a"))], {}, 100)).toEqual({});
  });
});

describe("capTabs", () => {
  const many = (n: number, active: string | null = null) => ({
    paths: Array.from({ length: n }, (_, i) => `/w/a/f${i}.ts`),
    active,
    savedAt: 100,
  });

  it("keeps 30 of 45 and drops the oldest", () => {
    const out = capTabs(many(45));
    expect(out.paths).toHaveLength(30);
    expect(out.paths[0]).toBe("/w/a/f15.ts");
    expect(out.paths[29]).toBe("/w/a/f44.ts");
  });

  it("leaves a workspace under the cap untouched", () => {
    const out = capTabs(many(4));
    expect(out.paths).toHaveLength(4);
  });

  it("keeps the active tab even when it falls outside the newest 30", () => {
    // A restore lands on the active tab, so dropping it would restore a strip
    // focused on something the user never chose.
    const out = capTabs(many(45, "/w/a/f0.ts"));
    expect(out.paths).toHaveLength(30);
    expect(out.paths).toContain("/w/a/f0.ts");
  });

  it("caps through toStore, not only when called directly", () => {
    const open = Array.from({ length: 45 }, (_, i) => tab(`/w/a/f${i}.ts`));
    expect(toStore(open, {}, 100)["/w/a"].paths).toHaveLength(30);
  });
});

describe("mergeStore", () => {
  const prev: FileTabStore = {
    "/w/a": { paths: ["/w/a/one.ts"], active: null, savedAt: 1 },
    "/w/b": { paths: ["/w/b/x.ts"], active: null, savedAt: 1 },
  };

  it("carries untouched workspaces through, so an empty startup save erases nothing", () => {
    expect(mergeStore(prev, {}, new Set())).toEqual(prev);
  });

  it("erases a workspace this run opened and then emptied", () => {
    const out = mergeStore(prev, {}, new Set(["/w/a"]));
    expect(out["/w/a"]).toBeUndefined();
    expect(out["/w/b"]).toEqual(prev["/w/b"]);
  });

  it("lets live entries win over stored ones for the same workspace", () => {
    const live: FileTabStore = { "/w/a": { paths: ["/w/a/new.ts"], active: null, savedAt: 2 } };
    expect(mergeStore(prev, live, new Set(["/w/a"]))["/w/a"].paths).toEqual(["/w/a/new.ts"]);
  });
});

describe("pruneStale", () => {
  it("drops workspaces past the age cutoff and keeps the rest", () => {
    const store: FileTabStore = {
      "/w/old": { paths: ["/w/old/a.ts"], active: null, savedAt: 0 },
      "/w/new": { paths: ["/w/new/a.ts"], active: null, savedAt: 900 },
    };
    const out = pruneStale(store, 1000, 500);
    expect(Object.keys(out)).toEqual(["/w/new"]);
  });
});

describe("restoreFor", () => {
  const entry = { paths: ["/a.ts", "/b.ts", "/c.ts"], active: "/b.ts", savedAt: 1 };

  it("returns descriptors only, reading nothing", () => {
    const out = restoreFor(entry, new Set(["/a.ts", "/b.ts", "/c.ts"]));
    expect(out).toEqual({ paths: ["/a.ts", "/b.ts", "/c.ts"], active: "/b.ts" });
  });

  it("prunes paths that no longer exist on disk", () => {
    // A file deleted between runs must not come back as a tab whose buffer can
    // only ever say it failed to open.
    const out = restoreFor(entry, new Set(["/a.ts", "/c.ts"]));
    expect(out.paths).toEqual(["/a.ts", "/c.ts"]);
  });

  it("falls back to the last surviving tab when the active one is gone", () => {
    const out = restoreFor(entry, new Set(["/a.ts", "/c.ts"]));
    expect(out.active).toBe("/c.ts");
  });

  it("restores nothing when every path is gone", () => {
    expect(restoreFor(entry, new Set())).toEqual({ paths: [], active: null });
  });

  it("restores nothing for a workspace with no stored entry", () => {
    expect(restoreFor(undefined, new Set(["/a.ts"]))).toEqual({ paths: [], active: null });
  });
});

describe("parseStore", () => {
  it("treats absent, malformed and non-object storage as nothing stored", () => {
    expect(parseStore(null)).toEqual({});
    expect(parseStore("not json")).toEqual({});
    expect(parseStore("[1,2,3]")).toEqual({});
  });

  it("skips entries missing paths or savedAt", () => {
    const raw = JSON.stringify({
      "/w/a": { paths: ["/w/a/one.ts"], active: null, savedAt: 5 },
      "/w/b": { active: null, savedAt: 5 },
      "/w/c": { paths: ["/w/c/x.ts"], active: null },
    });
    expect(Object.keys(parseStore(raw))).toEqual(["/w/a"]);
  });

  it("drops non-string and empty paths, and the entry if nothing survives", () => {
    const raw = JSON.stringify({
      "/w/a": { paths: ["/w/a/one.ts", 42, ""], active: null, savedAt: 5 },
      "/w/b": { paths: [null, ""], active: null, savedAt: 5 },
    });
    const out = parseStore(raw);
    expect(out["/w/a"].paths).toEqual(["/w/a/one.ts"]);
    expect(out["/w/b"]).toBeUndefined();
  });

  it("clears an active path that is not among the stored paths", () => {
    const raw = JSON.stringify({ "/w/a": { paths: ["/w/a/one.ts"], active: "/gone.ts", savedAt: 5 } });
    expect(parseStore(raw)["/w/a"].active).toBeNull();
  });

  it("skips an entry stored under an empty key", () => {
    const raw = JSON.stringify({ "": { paths: ["/orphan.ts"], active: null, savedAt: 5 } });
    expect(parseStore(raw)).toEqual({});
  });
});
