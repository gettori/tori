import { describe, it, expect } from "vitest";
import { MAX_REOPENABLE, rememberClosedTab, sweepClosed, takeClosedTab, type ClosedStore } from "./reopenStack";

const closeAll = (ws: string, ...paths: string[]): ClosedStore =>
  paths.reduce<ClosedStore>((s, p) => rememberClosedTab(s, ws, p), {});

describe("the reopen stack", () => {
  it("hands nothing back when nothing was closed", () => {
    expect(takeClosedTab({}, "/ws")).toEqual({ path: null, store: {} });
  });

  it("hands back the most recent close first", () => {
    const store = closeAll("/ws", "/ws/a.ts", "/ws/b.ts");
    const first = takeClosedTab(store, "/ws");
    expect(first.path).toBe("/ws/b.ts");
    const second = takeClosedTab(first.store, "/ws");
    expect(second.path).toBe("/ws/a.ts");
    expect(takeClosedTab(second.store, "/ws").path).toBeNull();
  });

  // Two entries for one file would make the second Cmd+Shift+T appear to do
  // nothing: it would reopen a tab that is already open.
  it("moves a re-closed file to the top rather than stacking it twice", () => {
    let store = closeAll("/ws", "/ws/a.ts", "/ws/b.ts");
    store = rememberClosedTab(store, "/ws", "/ws/a.ts");
    expect(store["/ws"]).toEqual(["/ws/b.ts", "/ws/a.ts"]);
  });

  it("drops the oldest close once it is over the cap", () => {
    let store: ClosedStore = {};
    for (let i = 1; i <= 4; i++) store = rememberClosedTab(store, "/ws", `/ws/f${i}.ts`, 2);
    expect(store["/ws"]).toEqual(["/ws/f3.ts", "/ws/f4.ts"]);
  });

  it("remembers a cap worth by default", () => {
    let store: ClosedStore = {};
    for (let i = 0; i < MAX_REOPENABLE + 5; i++) store = rememberClosedTab(store, "/ws", `/ws/f${i}.ts`);
    expect(store["/ws"]).toHaveLength(MAX_REOPENABLE);
  });

  it("keeps each workspace's closes to itself", () => {
    let store = closeAll("/ws/one", "/ws/one/a.ts");
    store = rememberClosedTab(store, "/ws/two", "/ws/two/b.ts");
    expect(takeClosedTab(store, "/ws/one").path).toBe("/ws/one/a.ts");
    expect(takeClosedTab(store, "/ws/two").path).toBe("/ws/two/b.ts");
  });
});

describe("following a file that moved or is gone", () => {
  it("repoints a renamed close", () => {
    const store = closeAll("/ws", "/ws/old.ts");
    const moved = sweepClosed(store, (p) => (p === "/ws/old.ts" ? "/ws/new.ts" : p));
    expect(takeClosedTab(moved, "/ws").path).toBe("/ws/new.ts");
  });

  it("drops a trashed close, so reopening cannot build a tab on nothing", () => {
    const store = closeAll("/ws", "/ws/keep.ts", "/ws/junk/x.ts");
    const swept = sweepClosed(store, (p) => (p.startsWith("/ws/junk/") ? null : p));
    expect(swept["/ws"]).toEqual(["/ws/keep.ts"]);
  });

  // A folder rename maps several closes onto one path; two entries for one file
  // is the same "second press does nothing" problem the dedup above avoids.
  it("collapses closes a folder rename mapped together, keeping the newest", () => {
    const store = closeAll("/ws", "/ws/a/x.ts", "/ws/b/x.ts");
    const swept = sweepClosed(store, () => "/ws/x.ts");
    expect(swept["/ws"]).toEqual(["/ws/x.ts"]);
  });

  it("hands the same store back when nothing matched", () => {
    const store = closeAll("/ws", "/ws/a.ts");
    expect(sweepClosed(store, (p) => p)).toBe(store);
  });
});
