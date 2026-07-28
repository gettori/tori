import { describe, it, expect } from "vitest";
import { toStore, pruneStale, parseStore, mergeStore, type TabStore, type OpenTabLike } from "./tabPersist";
import { chatTabLabel } from "./chatConcurrency";

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

  it("keeps a rewound chat's marker, so the tab still says what the agent remembers", () => {
    // The gap a rewind opens - the agent remembering turns that are no longer
    // above it - lasts as long as the session, not as long as the app run, so
    // the notice has to survive a relaunch too.
    const out = toStore(
      [
        tab({ id: "1", kind: "chat", program: "claude", sessionId: "c1", rewindTo: 1700 }),
        tab({ id: "2", kind: "chat", program: "claude", sessionId: "c2" }),
      ],
      {},
      100,
    );
    expect(out["/w/a"].tabs[0].rewindTo).toBe(1700);
    // An ordinary chat carries no marker at all rather than a falsy one, or
    // every restored tab would have to know to disbelieve a zero.
    expect("rewindTo" in out["/w/a"].tabs[1]).toBe(false);
    expect(parseStore(JSON.stringify(out))["/w/a"].tabs[0].rewindTo).toBe(1700);
  });

  it("persists a chat tab alongside the agent, shell and command kinds", () => {
    const out = toStore(
      [
        tab({ id: "1", kind: "chat", title: "chat", program: "claude", sessionId: "c1" }),
        tab({ id: "2", kind: "agent", program: "claude", sessionId: "a1" }),
        tab({ id: "3" }),
        tab({ id: "4", kind: "command", title: "clone" }),
      ],
      {},
      100,
    );
    expect(out["/w/a"].tabs.map((t) => t.kind)).toEqual(["chat", "agent", "shell"]);
    expect(out["/w/a"].tabs[0].sessionId).toBe("c1");
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

  it("restores a chat tab, and existing kinds, unchanged", () => {
    const written = toStore(
      [
        tab({ id: "1", kind: "chat", title: "chat", program: "claude", sessionId: "c1" }),
        tab({ id: "2", kind: "agent", program: "claude", args: ["--resume", "a1"], sessionId: "a1" }),
        tab({ id: "3", kind: "shell" }),
      ],
      { "/w/a": "1" },
      100,
    );
    const back = parseStore(JSON.stringify(written));
    expect(back).toEqual(written);
    expect(back["/w/a"].tabs.map((t) => t.kind)).toEqual(["chat", "agent", "shell"]);
    expect(back["/w/a"].active).toBe(0);
  });

  it("round-trips three chats on one branch, each still distinguishable", () => {
    const written = toStore(
      [0, 1, 2].reduce<OpenTabLike[]>(
        (acc, n) => [
          ...acc,
          tab({
            id: `chat:${n}`,
            kind: "chat",
            title: chatTabLabel("sway", acc.map((t) => t.title)),
            program: "claude",
            sessionId: `s${n}`,
          }),
        ],
        [],
      ),
      { "/w/a": "chat:1" },
      100,
    );
    const back = parseStore(JSON.stringify(written));
    expect(back["/w/a"].tabs.map((t) => t.title)).toEqual(["sway chat", "sway chat 2", "sway chat 3"]);
    expect(back["/w/a"].tabs.map((t) => t.sessionId)).toEqual(["s0", "s1", "s2"]);
    expect(back["/w/a"].active).toBe(1);
  });

  it("drops a chat tab stored without a session id, which could never respawn", () => {
    const raw = JSON.stringify({
      w: {
        tabs: [
          { title: "chat", cwd: "/c", kind: "chat", program: "claude", args: [] },
          { title: "ok", cwd: "/c", kind: "chat", program: "claude", args: [], sessionId: "s" },
        ],
        active: 0,
        savedAt: 1,
      },
    });
    expect(parseStore(raw).w.tabs.map((t) => t.sessionId)).toEqual(["s"]);
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
