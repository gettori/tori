import { describe, it, expect } from "vitest";
import {
  toStore,
  pruneStale,
  parseStore,
  mergeStore,
  restoreId,
  activeIndex,
  type TabStore,
  type OpenTabLike,
} from "./tabPersist";
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

  // Both, not one: the id is what this build restores by, and the index is what
  // a build older than this one reads, so a rollback still lands on the same tab.
  it("records the active tab as an id alongside the index", () => {
    const out = toStore([tab({ id: "1" }), tab({ id: "2" })], { "/w/a": "2" }, 100);
    expect(out["/w/a"].activeId).toBe("2");
    expect(out["/w/a"].active).toBe(1);
  });

  it("keeps each tab's own id, so a restored tab can come back as itself", () => {
    const out = toStore([tab({ id: "sh:1" }), tab({ id: "chat:2", kind: "chat" })], {}, 100);
    expect(out["/w/a"].tabs.map((t) => t.id)).toEqual(["sh:1", "chat:2"]);
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

  // A draft is the one tab whose whole content is unsent: no session to resume
  // and no transcript to replay, so what was typed and what it would run as are
  // the only things there are to bring back.
  it("keeps a draft's text and pick, and round-trips both", () => {
    const draft = tab({
      id: "1",
      kind: "chat",
      title: "draft",
      program: "codex",
      text: "half a thought",
      pick: { model: "gpt-5", mode: "plan", effort: null, optionValues: { web_search: true } },
    });
    const out = toStore([draft], {}, 100);

    expect(out["/w/a"].tabs[0].text).toBe("half a thought");
    expect(parseStore(JSON.stringify(out))["/w/a"].tabs[0].pick).toEqual({
      model: "gpt-5",
      mode: "plan",
      effort: null,
      optionValues: { web_search: true },
    });
  });

  // A flipped switch is a pick like any other, and a draft carrying only that
  // one would come back blank if the store counted the other three alone.
  it("keeps a draft whose only pick is one of the agent's own levers", () => {
    const draft = tab({
      id: "1",
      kind: "chat",
      pick: { model: null, mode: null, effort: null, optionValues: { collaboration_mode: "pair" } },
    });
    const out = parseStore(JSON.stringify(toStore([draft], {}, 100)));

    expect(out["/w/a"].tabs[0].pick?.optionValues).toEqual({ collaboration_mode: "pair" });
  });

  // Neither a value id nor a toggle state, so no switch could send it. Dropped
  // rather than restored, the same way a mistyped model field is.
  it("drops a stored option value that is not a shape a switch sends", () => {
    const raw = JSON.stringify({
      "/w/a": {
        savedAt: 100,
        active: 0,
        tabs: [
          {
            title: "draft",
            cwd: "/w/a",
            kind: "chat",
            program: "codex",
            args: [],
            pick: { model: null, mode: null, effort: null, optionValues: { depth: { deep: true }, web_search: false } },
          },
        ],
      },
    });

    expect(parseStore(raw)["/w/a"].tabs[0].pick?.optionValues).toEqual({ web_search: false });
  });

  // The text and the pick part company here. What was typed at a live chat has
  // somewhere to go - the composer sends it, and the transcript is the record.
  // What it is *running* has nowhere else at all: measured on claude 2.1.251, a
  // resumed session reports the model it had and comes back on the CLI's
  // default permission mode, with the effort level reported nowhere ever. So
  // the pick goes down and the text does not.
  it("keeps what a live chat is running, and not what was typed at it", () => {
    const out = toStore(
      [
        tab({
          id: "1",
          kind: "chat",
          sessionId: "c1",
          live: true,
          text: "typed",
          pick: { model: "sonnet", mode: "plan", effort: "high", optionValues: {} },
        }),
      ],
      {},
      100,
    );
    expect("text" in out["/w/a"].tabs[0]).toBe(false);
    expect(out["/w/a"].tabs[0].pick).toEqual({ model: "sonnet", mode: "plan", effort: "high", optionValues: {} });
  });

  // The test the line above used to make was "has a session id", which a
  // restored chat opened only to read also passes. Nothing is driving that
  // conversation, so what was typed at it has nowhere else to survive a quit -
  // exactly a draft's problem, and answered the same way.
  it("keeps what was typed at a chat that has a session but no child", () => {
    const out = toStore(
      [tab({ id: "1", kind: "chat", sessionId: "c1", live: false, text: "typed" })],
      {},
      100,
    );
    expect(out["/w/a"].tabs[0].text).toBe("typed");
    expect(out["/w/a"].tabs[0].sessionId).toBe("c1");
  });

  // One localStorage key holds every workspace's tabs, so an essay pasted into
  // one draft must not cost the rest their restore. Dropped whole rather than
  // truncated: half a message handed back would read as the whole of it.
  it("drops a draft's text past the size cap rather than truncating it", () => {
    const out = toStore([tab({ id: "1", kind: "chat", text: "x".repeat(16_001) })], {}, 100);
    expect("text" in out["/w/a"].tabs[0]).toBe(false);
  });

  it("stores no pick at all when nothing was picked", () => {
    const out = toStore(
      [tab({ id: "1", kind: "chat", pick: { model: null, mode: null, effort: null, optionValues: {} } })],
      {},
      100,
    );
    expect("pick" in out["/w/a"].tabs[0]).toBe(false);
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

describe("activeIndex", () => {
  const entry = (over: Partial<TabStore[string]>): TabStore[string] => ({
    tabs: [
      { id: "sh:1", title: "a", cwd: "/c", kind: "shell", program: "", args: [] },
      { id: "sh:2", title: "b", cwd: "/c", kind: "shell", program: "", args: [] },
    ],
    active: -1,
    savedAt: 1,
    ...over,
  });

  it("resolves by id when the store carries one", () => {
    expect(activeIndex(entry({ activeId: "sh:2", active: 1 }))).toBe(1);
  });

  // The id is authoritative: an order that changed since the index was written
  // must not focus whatever now sits in that slot.
  it("prefers the id over a disagreeing index", () => {
    expect(activeIndex(entry({ activeId: "sh:1", active: 1 }))).toBe(0);
  });

  // A store written by a build older than this one. It has no ids at all, so
  // the index is the only answer there is.
  it("falls back to the index for a store carrying no ids", () => {
    const old = entry({ active: 1, tabs: [{ title: "a", cwd: "/c", kind: "shell", program: "", args: [] }] });
    expect(activeIndex(old)).toBe(1);
  });

  it("reports none when the stored active id matches no tab", () => {
    expect(activeIndex(entry({ activeId: "sh:gone", active: 0 }))).toBe(-1);
  });
});

describe("restoreId", () => {
  const fresh = () => "fresh";

  it("reuses the stored id, so placement and the backend still recognise the tab", () => {
    expect(restoreId("sh:1", new Set(), fresh)).toBe("sh:1");
  });

  it("mints a fresh id when nothing was stored", () => {
    expect(restoreId(undefined, new Set(), fresh)).toBe("fresh");
  });

  // `pty_spawn` delivers a tab's `init` exactly once per id, so a second tab on
  // a live one would be seeded nothing and come back an empty shell.
  it("refuses an id a live tab already holds", () => {
    expect(restoreId("sh:1", new Set(["sh:1"]), fresh)).toBe("fresh");
  });

  it("gives two entries naming one id two distinct tabs", () => {
    const taken = new Set<string>();
    const first = restoreId("sh:1", taken, fresh);
    taken.add(first);
    const second = restoreId("sh:1", taken, () => "fresh-2");
    expect([first, second]).toEqual(["sh:1", "fresh-2"]);
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

  // The rule this reverses: a session-less chat tab used to be dropped, because
  // the only way back for a chat was to resume its id. A draft is the case that
  // has none and needs none, so an absent id now says which surface to restore
  // rather than that there is nothing to restore.
  it("keeps a chat tab stored without a session id, which is a draft", () => {
    const raw = JSON.stringify({
      w: {
        tabs: [
          { title: "draft", cwd: "/c", kind: "chat", program: "claude", args: [] },
          { title: "ok", cwd: "/c", kind: "chat", program: "claude", args: [], sessionId: "s" },
        ],
        active: 0,
        savedAt: 1,
      },
    });
    expect(parseStore(raw).w.tabs.map((t) => t.sessionId)).toEqual([undefined, "s"]);
  });

  // A hand-edited or half-written file reaches the composer and the palette
  // through these two, so each field is checked rather than trusted.
  it("normalises a draft's stored pick and refuses a text that is not one", () => {
    const raw = JSON.stringify({
      w: {
        tabs: [
          {
            title: "draft",
            cwd: "/c",
            kind: "chat",
            program: "claude",
            args: [],
            text: 42,
            pick: { model: "sonnet", effort: 7 },
          },
        ],
        active: 0,
        savedAt: 1,
      },
    });
    const back = parseStore(raw).w.tabs[0];
    expect(back.text).toBeUndefined();
    expect(back.pick).toEqual({ model: "sonnet", mode: null, effort: null, optionValues: {} });
  });

  it("round-trips tab ids and the active id together with the index", () => {
    const written = toStore([tab({ id: "sh:1" }), tab({ id: "sh:2" })], { "/w/a": "sh:2" }, 100);
    const back = parseStore(JSON.stringify(written));
    expect(back).toEqual(written);
    expect(back["/w/a"].tabs.map((t) => t.id)).toEqual(["sh:1", "sh:2"]);
    expect(back["/w/a"].activeId).toBe("sh:2");
    expect(back["/w/a"].active).toBe(1);
  });

  // A hand-edited file, or one from a build that wrote ids before this shape
  // settled. Dropped rather than carried: restore mints a fresh id, exactly as
  // it does for a store that has none.
  it("drops a stored id that is not a non-empty string", () => {
    const raw = JSON.stringify({
      w: {
        tabs: [
          { id: 42, title: "a", cwd: "/c", kind: "shell", program: "", args: [] },
          { id: "", title: "b", cwd: "/c", kind: "shell", program: "", args: [] },
        ],
        active: 0,
        savedAt: 1,
      },
    });
    expect(parseStore(raw).w.tabs.map((t) => t.id)).toEqual([undefined, undefined]);
  });

  it("drops an activeId that is not a non-empty string, keeping the index", () => {
    const raw = JSON.stringify({
      w: { tabs: [{ title: "a", cwd: "/c", kind: "shell", program: "", args: [] }], active: 0, activeId: 7, savedAt: 1 },
    });
    expect(parseStore(raw).w.activeId).toBeUndefined();
    expect(parseStore(raw).w.active).toBe(0);
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
