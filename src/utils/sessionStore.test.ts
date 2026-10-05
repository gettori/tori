import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

// The store's contract is what it asks the backend for and what it keeps, so
// the mock records every `list_sessions` folder and can be told to fail one.
const bridge = vi.hoisted(() => ({
  listed: [] as string[],
  lists: {} as Record<string, { id: string }[]>,
  fail: new Set<string>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { folder?: string }) => {
    if (cmd === "list_sessions") {
      const folder = args!.folder!;
      bridge.listed.push(folder);
      if (bridge.fail.has(folder)) return Promise.reject(new Error("nope"));
      return Promise.resolve(bridge.lists[folder] ?? []);
    }
    return Promise.resolve(null);
  },
}));

const { sessions, trackFolders, refreshSessions, onFolderScan, findSession, resetSessionStoreForTests } =
  await import("./sessionStore");

const meta = (id: string) => ({ id }) as never;

describe("the session store", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    bridge.listed = [];
    bridge.lists = {};
    bridge.fail = new Set();
  });

  it("lists a folder it has never seen and leaves the ones it holds to a refresh", async () => {
    bridge.lists["/a"] = [meta("s1")];
    await trackFolders(["/a", "/b"]);
    expect(bridge.listed.sort()).toEqual(["/a", "/b"]);
    expect(Object.keys(sessions()).sort()).toEqual(["/a", "/b"]);

    // Asking again is free: a known folder is refreshSessions' job, so a store
    // driven by a reactive folder list does not re-list on every recomputation.
    bridge.listed = [];
    await trackFolders(["/a", "/b"]);
    expect(bridge.listed).toEqual([]);
  });

  // The whole reason the map is a store rather than a signal scoped to the tree.
  // A tab outlives the space it was opened in, so a folder that leaves the
  // active space must keep its listing: the needs-you pipeline joins live tabs
  // against exactly this map, and a dropped folder starves it silently.
  it("keeps a folder that a later round no longer asks about", async () => {
    bridge.lists["/space-a/repo"] = [meta("running-here")];
    await trackFolders(["/space-a/repo"]);
    await trackFolders(["/space-b/other"]);

    expect(Object.keys(sessions()).sort()).toEqual(["/space-a/repo", "/space-b/other"]);
    expect(findSession("running-here")?.folder).toBe("/space-a/repo");
  });

  it("rescans every folder it holds, and keeps a failed one's last listing", async () => {
    bridge.lists["/a"] = [meta("s1")];
    bridge.lists["/b"] = [meta("s2")];
    await trackFolders(["/a", "/b"]);

    // /a rescans to empty (its session really is gone); /b's scan fails, which
    // is not the same answer and must not be read as "these sessions are gone".
    bridge.lists["/a"] = [];
    bridge.fail.add("/b");
    await refreshSessions();

    expect(sessions()["/a"]).toEqual([]);
    expect(sessions()["/b"]).toEqual([meta("s2")]);
  });

  // Both observers need per-folder lists rather than "something changed", and
  // one of them persists to localStorage, so a scan of N folders is announced
  // once rather than N times.
  it("announces a whole round of scans as one batch", async () => {
    bridge.lists["/a"] = [meta("s1")];
    const rounds: string[][] = [];
    const off = onFolderScan((scans) => rounds.push(scans.map((s) => s.folder).sort()));

    await trackFolders(["/a", "/b"]);
    expect(rounds).toEqual([["/a", "/b"]]);

    off();
    await refreshSessions();
    expect(rounds).toEqual([["/a", "/b"]]);
  });

  // The heartbeat case: a session streaming in one folder raises
  // `sessions://changed` about once a second, and re-listing every folder the
  // tree covers on each one is what phase 6 is removing.
  it("re-lists only the folders an event named", async () => {
    await trackFolders(["/a", "/b", "/c"]);
    bridge.listed = [];

    await refreshSessions(["/b"]);
    expect(bridge.listed).toEqual(["/b"]);

    // A folder nobody covers has no row to refresh, so it is dropped rather
    // than listed: `trackFolders` is what brings a new folder in.
    bridge.listed = [];
    await refreshSessions(["/b", "/never-tracked"]);
    expect(bridge.listed).toEqual(["/b"]);

    // No names (the backend could not attribute the change) still means all.
    bridge.listed = [];
    await refreshSessions();
    expect(bridge.listed.sort()).toEqual(["/a", "/b", "/c"]);
  });
});
