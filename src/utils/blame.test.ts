import { describe, it, expect, vi, beforeEach } from "vitest";
// Read as text, the way commands.test.ts and revertGuard's test do: this
// project ships no `@types/node`, so `?raw` is how a test inspects source.
import codeEditorSource from "../panels/Editor/CodeEditor.tsx?raw";

// The cache is the whole point of this module: blame is a subprocess per file,
// and the rule for when it may run again is "HEAD moved", never "the buffer
// changed".

let calls: { projectPath: string; file: string }[] = [];
let fails = false;
let head = "h".repeat(40);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "git_blame") return Promise.resolve(null);
    calls.push({ projectPath: String(args.projectPath), file: String(args.file) });
    if (fails) return Promise.reject("fatal: not a git repository");
    return Promise.resolve({ head, lines: [0], commits: [{ sha: "a".repeat(40), short: "aaaaaaa", author: "Ada", time: 1, summary: "s" }] });
  },
}));

const { blameFor, dropBlame, clearBlameCache, canPlaceBlame, ageBucket, blameKey, UNCOMMITTED } =
  await import("./blame");

const REPO = "/proj";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

beforeEach(() => {
  calls = [];
  fails = false;
  head = HEAD_A;
  clearBlameCache();
});

describe("reading blame", () => {
  it("reads a file once per HEAD, however many times it is asked for", async () => {
    // What "no new blame invocation while typing" reduces to: the editor asks
    // again on every tab swap, and only a moved HEAD makes that cost anything.
    await blameFor(REPO, "a.ts", HEAD_A);
    await blameFor(REPO, "a.ts", HEAD_A);
    await blameFor(REPO, "a.ts", HEAD_A);

    expect(calls).toEqual([{ projectPath: REPO, file: "a.ts" }]);
  });

  it("reads it again once HEAD moves", async () => {
    await blameFor(REPO, "a.ts", HEAD_A);
    head = HEAD_B;
    await blameFor(REPO, "a.ts", HEAD_B);

    expect(calls.length).toBe(2);
  });

  it("keeps files apart, and repos apart", async () => {
    await blameFor(REPO, "a.ts", HEAD_A);
    await blameFor(REPO, "b.ts", HEAD_A);
    await blameFor("/other", "a.ts", HEAD_A);

    expect(calls.length).toBe(3);
    expect(blameKey(REPO, "a.ts", HEAD_A)).not.toBe(blameKey("/other", "a.ts", HEAD_A));
  });

  it("answers an empty blame instead of throwing at the file you opened", async () => {
    fails = true;
    const blame = await blameFor(REPO, "a.ts", HEAD_A);

    expect(blame.lines).toEqual([]);
    expect(blame.commits).toEqual([]);
  });

  it("does not cache a failure, so a transient one clears itself", async () => {
    // A cached failure would leave the file blameless until somebody happened
    // to commit, which is the wrong thing to make the recovery condition.
    fails = true;
    await blameFor(REPO, "a.ts", HEAD_A);
    fails = false;
    const blame = await blameFor(REPO, "a.ts", HEAD_A);

    expect(calls.length).toBe(2);
    expect(blame.commits.length).toBe(1);
  });

  it("stops growing past its bound", async () => {
    // The key carries HEAD, so a long session commits its way through keys that
    // will never be asked for again.
    for (let i = 0; i < 60; i++) await blameFor(REPO, "a.ts", `${i}`.padStart(40, "0"));
    expect(calls.length).toBe(60);

    // The oldest is gone (re-reads), the newest is still there (does not).
    await blameFor(REPO, "a.ts", "0".padStart(40, "0"));
    expect(calls.length).toBe(61);
    await blameFor(REPO, "a.ts", "59".padStart(40, "0"));
    expect(calls.length).toBe(61);
  });
});

describe("forgetting a file's blame", () => {
  it("drops it at every HEAD it was read for, and leaves other files alone", async () => {
    // A write to the file changes which of its lines are uncommitted, and HEAD
    // does not move for that - so the key alone cannot notice, and something
    // has to say so.
    await blameFor(REPO, "a.ts", HEAD_A);
    await blameFor(REPO, "a.ts", HEAD_B);
    await blameFor(REPO, "b.ts", HEAD_A);
    expect(calls.length).toBe(3);

    dropBlame(REPO, "a.ts");

    // The file nobody wrote to is still cached.
    await blameFor(REPO, "b.ts", HEAD_A);
    expect(calls.length).toBe(3);
    await blameFor(REPO, "a.ts", HEAD_A);
    await blameFor(REPO, "a.ts", HEAD_B);
    expect(calls.length).toBe(5);
  });

  it("does not drop a file whose name merely starts the same way", async () => {
    await blameFor(REPO, "a.ts", HEAD_A);
    await blameFor(REPO, "a.ts.bak", HEAD_A);

    dropBlame(REPO, "a.ts");

    await blameFor(REPO, "a.ts.bak", HEAD_A);
    expect(calls.length).toBe(2);
  });
});

describe("laying a blame onto a buffer", () => {
  // The rule the whole position story rests on. `Blame.lines` is indexed by the
  // file's line numbering on disk, and a buffer only shares that numbering
  // while it is clean.
  it("refuses a buffer that has moved on from the file that was blamed", () => {
    expect(canPlaceBlame("one\ntwo\n", "one\ntwo\n")).toBe(true);
    // Three lines typed at the top: every marker would land three lines out,
    // and the ones already on screen have been mapped correctly by CM6.
    expect(canPlaceBlame("new\nnew\nnew\none\ntwo\n", "one\ntwo\n")).toBe(false);
    // Same length, different text: still not the file that was blamed.
    expect(canPlaceBlame("one\nTWO\n", "one\ntwo\n")).toBe(false);
  });

  it("allows it when there is no buffer record to compare against", () => {
    // Not evidence of drift, and refusing would mean never showing blame there.
    expect(canPlaceBlame("anything", undefined)).toBe(true);
  });
});

describe("keeping blame off the typing path", () => {
  // Load-bearing, not stylistic. A `git blame` is a subprocess, and the whole
  // design of this module is that edits never need one: the markers follow the
  // text through CM6's change mapping instead. A call added to an update
  // listener would put a subprocess behind every keystroke burst and nothing
  // else in the suite would notice.
  const callsTo = (name: string) =>
    // Call expressions only, so the declaration itself is not counted.
    [...codeEditorSource.matchAll(new RegExp(`(?<!function )\\b${name}\\(\\)`, "g"))].length;

  it("reads blame from exactly the places that may", () => {
    // `syncBlame` on a buffer swap and on the blame toggle; `refreshBlame` from
    // `syncBlame`, when HEAD moves, and when the buffer adopts a new file from
    // disk. Adding a call site should be a deliberate act, so it fails here
    // until this count is updated with a reason.
    expect(callsTo("syncBlame")).toBe(2);
    expect(callsTo("refreshBlame")).toBe(3);
  });

  it("never mentions blame inside an update listener", () => {
    // The update listeners are the typing path: they run on every transaction.
    const listeners = codeEditorSource.split("EditorView.updateListener.of(").slice(1);
    expect(listeners.length).toBeGreaterThan(0);
    for (const body of listeners) {
      // Up to the next top-level construct, which is as far as a listener ever
      // reaches in this file.
      const block = body.slice(0, body.indexOf("\n  "));
      expect(block.toLowerCase()).not.toContain("blame");
    }
  });
});

describe("how old a line reads as", () => {
  const NOW = 1_800_000_000;
  const days = (n: number) => NOW - n * 86_400;

  it("buckets by absolute age, not against the file's own oldest line", () => {
    // A file nobody has touched in years must not look as fresh as one written
    // this morning, which is what normalising per file would do.
    expect(ageBucket(days(0), NOW)).toBe(0);
    expect(ageBucket(days(3), NOW)).toBe(1);
    expect(ageBucket(days(20), NOW)).toBe(2);
    expect(ageBucket(days(90), NOW)).toBe(3);
    expect(ageBucket(days(200), NOW)).toBe(4);
    expect(ageBucket(days(4000), NOW)).toBe(5);
  });

  it("treats a commit dated in the future as brand new rather than going negative", () => {
    expect(ageBucket(NOW + 86_400, NOW)).toBe(0);
  });

  it("names the uncommitted sha the way git does", () => {
    expect(UNCOMMITTED).toBe("0".repeat(40));
    expect(UNCOMMITTED.length).toBe(40);
  });
});
