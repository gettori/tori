// The hot-exit store's rules, without an editor or a backend.
//
// Three of them can lose somebody's unsaved work if they are wrong, so each is
// tested for the losing case rather than only the happy one: what a prune
// throws away, what a malformed file does to a launch, and what a *second*
// quit writes when the first quit's entries have not all been claimed yet.
import { describe, it, expect, beforeEach, vi } from "vite-plus/test";

/** What the backend answers. `null` means it refuses, which is its own case. */
const backend: { stash: unknown } = { stash: null };
const saved: unknown[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (backend.stash === null) return Promise.reject("no backend here");
    if (cmd === "hot_exit_save") {
      saved.push(args.stash);
      return Promise.resolve(null);
    }
    return Promise.resolve(backend.stash);
  },
}));

const {
  pruneStash,
  parseStash,
  stashToWrite,
  loadStash,
  saveStash,
  loadPendingStash,
  pendingStashPaths,
  takeStashEntry,
  dropStashEntry,
  clearPendingStash,
} = await import("./hotExit");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const entry = (savedText: string, savedAt = NOW) => ({
  savedText,
  state: { doc: `${savedText} plus edits` },
  savedAt,
});

beforeEach(() => {
  clearPendingStash();
  backend.stash = null;
  saved.length = 0;
});

describe("pruning the stash", () => {
  it("keeps what is recent", () => {
    const store = { "/a": entry("a", NOW - DAY) };
    expect(Object.keys(pruneStash(store, NOW))).toEqual(["/a"]);
  });

  it("drops what has been sitting there for a month", () => {
    // Unsaved work nobody has come back to in thirty days is abandoned work,
    // and it is the same cutoff the tab store uses for the same reason.
    const store = { "/old": entry("o", NOW - 31 * DAY), "/new": entry("n", NOW - DAY) };
    expect(Object.keys(pruneStash(store, NOW))).toEqual(["/new"]);
  });

  it("keeps the newest when there are too many", () => {
    const store = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`/f${i}`, entry(`${i}`, NOW - i * DAY)]),
    );
    expect(Object.keys(pruneStash(store, NOW, 30 * DAY, 2)).sort()).toEqual(["/f0", "/f1"]);
  });

  it("is stable when every entry carries the same stamp", () => {
    // The ordinary case, not an exotic one: one quit writes one timestamp
    // across every buffer it stashed, so the cap is deciding between ties on
    // nearly every run. It has to decide the same way twice.
    const store = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`/f${i}`, entry(`${i}`)]));
    const once = Object.keys(pruneStash(store, NOW, 30 * DAY, 3));
    expect(Object.keys(pruneStash(store, NOW, 30 * DAY, 3))).toEqual(once);
    expect(once).toHaveLength(3);
  });

  it("leaves an empty stash empty", () => {
    expect(pruneStash({}, NOW)).toEqual({});
  });
});

describe("reading what was on disk", () => {
  it("takes a well-formed entry", () => {
    const raw = { "/a": { savedText: "one", state: { doc: "two" }, savedAt: NOW } };
    expect(parseStash(raw)).toEqual(raw);
  });

  it("treats anything that is not an object as nothing stored", () => {
    // This runs at launch. The only thing worse than losing an unsaved buffer
    // is losing it and not starting.
    for (const raw of [null, undefined, "text", 7, [1, 2]]) {
      expect(parseStash(raw)).toEqual({});
    }
  });

  it("skips an entry missing any of the three things a restore needs", () => {
    const raw = {
      "/no-text": { state: {}, savedAt: NOW },
      "/no-state": { savedText: "x", savedAt: NOW },
      "/no-stamp": { savedText: "x", state: {} },
      "/state-not-an-object": { savedText: "x", state: "nope", savedAt: NOW },
      "/good": { savedText: "x", state: {}, savedAt: NOW },
    };
    expect(Object.keys(parseStash(raw))).toEqual(["/good"]);
  });

  it("drops an entry filed under an empty path", () => {
    expect(parseStash({ "": { savedText: "x", state: {}, savedAt: NOW } })).toEqual({});
  });
});

describe("what a quit writes", () => {
  it("writes the live buffers when nothing is left over", () => {
    const live = { "/a": entry("a") };
    expect(stashToWrite(live)).toEqual(live);
  });

  it("omits a file that was saved before quitting", () => {
    // Which is the whole of "clear a stash entry once its buffer is saved": a
    // saved buffer is not dirty, so it is not in `live`, and the write replaces
    // the file rather than merging into it.
    expect(stashToWrite({})).toEqual({});
  });

  it("carries over an entry whose tab was never clicked", async () => {
    // The one that loses work if it is wrong. Restoring is lazy: quit with
    // three stashed files, click one, quit again, and a write of only what the
    // editor currently holds would take the other two down with it.
    backend.stash = { "/a": entry("a"), "/b": entry("b"), "/c": entry("c") };
    await loadPendingStash(NOW);
    takeStashEntry("/a"); // the one tab that got clicked

    const written = stashToWrite({ "/a": entry("a, edited further") });

    expect(Object.keys(written).sort()).toEqual(["/a", "/b", "/c"]);
    expect(written["/a"].savedText).toBe("a, edited further");
  });

  it("lets a live buffer outrank the entry it was restored from", async () => {
    // Belt and braces: `takeStashEntry` should already have removed it, but a
    // stale copy winning over what the user has since typed is the one way
    // this merge could quietly undo an edit.
    backend.stash = { "/a": entry("old") };
    await loadPendingStash(NOW);

    expect(stashToWrite({ "/a": entry("new") })["/a"].savedText).toBe("new");
  });
});

describe("holding the stash for this run", () => {
  it("lists what is waiting, so a tab can wear a dirty dot before it is built", async () => {
    backend.stash = { "/a": entry("a"), "/b": entry("b") };
    await loadPendingStash(NOW);
    expect(pendingStashPaths().sort()).toEqual(["/a", "/b"]);
  });

  it("hands an entry over once, not twice", async () => {
    // A file closed and reopened in one run must get the file, not a second
    // copy of last run's text, which by then is older than what is on screen.
    backend.stash = { "/a": entry("a") };
    await loadPendingStash(NOW);

    expect(takeStashEntry("/a")).toBeDefined();
    expect(takeStashEntry("/a")).toBeUndefined();
    expect(pendingStashPaths()).toEqual([]);
  });

  it("forgets an entry that was discarded rather than restored", async () => {
    // Closing a stashed tab on the "the edits in this tab will be lost" confirm
    // never goes near `takeStashEntry`, because no buffer was ever built for
    // it. Left pending, the merge below would carry the discarded work through
    // the next quit and hand it back on the launch after that.
    backend.stash = { "/a": entry("a"), "/b": entry("b") };
    await loadPendingStash(NOW);

    dropStashEntry("/a");

    expect(pendingStashPaths()).toEqual(["/b"]);
    expect(Object.keys(stashToWrite({}))).toEqual(["/b"]);
  });

  it("prunes on the way in, not only on the way out", async () => {
    backend.stash = { "/old": entry("o", NOW - 31 * DAY), "/new": entry("n") };
    await loadPendingStash(NOW);
    expect(pendingStashPaths()).toEqual(["/new"]);
  });
});

describe("the backend refusing to answer", () => {
  it("loads nothing rather than throwing", async () => {
    // `invoke` is mocked to reject. A launch must survive a backend that
    // cannot read the stash, with no restore rather than no editor.
    await expect(loadStash(NOW)).resolves.toEqual({});
  });

  it("reports a failed save as false, not as an exception", async () => {
    // The quit path reads this boolean to decide whether it may skip the
    // "unsaved edits will be lost" prompt. A throw here would skip the prompt
    // by crashing past it.
    await expect(saveStash({ "/a": entry("a") })).resolves.toBe(false);
  });
});
