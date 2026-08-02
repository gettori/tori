import { describe, it, expect } from "vitest";
import {
  isAnchored,
  newSideLines,
  oldSideLines,
  groupThreads,
  splitByRenderedLines,
  pendingComment,
  isPending,
  withComment,
  withoutComment,
  withResolved,
} from "./reviewThreads";
import { parseDiffHunks } from "./diffHunks";
import type { ReviewThread } from "./forgeTypes";

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "PRRT_kwDOABCD123",
  path: "src/a.rs",
  line: 12,
  diffHunk: "@@ -10,3 +10,4 @@\n fn main() {\n+    let x = 1;",
  isResolved: false,
  isOutdated: false,
  comments: [],
  ...over,
});

describe("isAnchored", () => {
  it("refuses a thread with no line", () => {
    // The obvious half. There is no number to place it at.
    expect(isAnchored(thread({ line: null }))).toBe(false);
  });

  it("refuses an outdated thread that still carries a line", () => {
    // The half that matters. GitHub reports both, and they disagree on purpose:
    // the line describes a version of the file that has since changed, so
    // placing it puts an old remark beside whatever occupies that line now.
    // Silently wrong beats visibly missing, which is why this is the expensive
    // mistake of the two.
    expect(isAnchored(thread({ line: 12, isOutdated: true }))).toBe(false);
    expect(isAnchored(thread({ line: 12, isOutdated: false }))).toBe(true);
  });

  it("keeps a resolved thread anchored", () => {
    // Resolved is about the conversation, not about where it sits. Folding it
    // into the outdated group would move every settled remark off its line.
    expect(isAnchored(thread({ isResolved: true }))).toBe(true);
  });
});

describe("newSideLines", () => {
  it("numbers only the lines that exist in the head file", () => {
    // A deletion is not in the head file, so it has no head-file line, and
    // counting it would shift every line after it in the hunk.
    const [hunk] = parseDiffHunks(
      ["@@ -10,3 +10,3 @@", " ten", "-eleven", "+eleven edited", " twelve"].join("\n"),
    );
    expect(newSideLines(hunk)).toEqual([10, null, 11, 12]);
  });

  it("skips the no-newline marker without spending a number on it", () => {
    const [hunk] = parseDiffHunks(
      ["@@ -1,2 +1,2 @@", " one", "+two", "\\ No newline at end of file"].join("\n"),
    );
    expect(newSideLines(hunk)).toEqual([1, 2, null]);
  });

  it("stays index-aligned with the rows a hunk renders", () => {
    // The whole basis for placing a thread: row i and line i are the same line.
    // `buildRows` re-emits one row per input line in order, which holds because
    // a unified diff already groups a change block's removals before its
    // additions.
    const [hunk] = parseDiffHunks(
      ["@@ -5,4 +5,4 @@", " five", "-six", "-seven", "+six edited", "+seven edited"].join("\n"),
    );
    expect(newSideLines(hunk)).toHaveLength(hunk.lines.length);
    expect(newSideLines(hunk)).toEqual([5, null, null, 6, 7]);
  });
});

describe("oldSideLines", () => {
  it("numbers only the lines that exist in the base file", () => {
    // The mirror of `newSideLines`. An addition is not in the base file, so it
    // has no base-file line, and counting it would shift everything after it.
    const [hunk] = parseDiffHunks(
      ["@@ -10,4 +10,4 @@", " ten", "-eleven", "+eleven edited", " twelve", " thirteen"].join("\n"),
    );
    expect(oldSideLines(hunk)).toEqual([10, 11, null, 12, 13]);
    expect(newSideLines(hunk)).toEqual([10, null, 11, 12, 13]);
  });

  it("disagrees with the head numbering as soon as a line is added", () => {
    // The whole reason both exist. Line 12 of one is not line 12 of the other.
    const [hunk] = parseDiffHunks(["@@ -10,2 +10,3 @@", " ten", "+inserted", " eleven"].join("\n"));
    expect(oldSideLines(hunk)).toEqual([10, null, 11]);
    expect(newSideLines(hunk)).toEqual([10, 11, 12]);
  });
});

describe("groupThreads", () => {
  it("routes an unplaceable thread to the outdated group, never to a line", () => {
    const current = thread({ id: "A", line: 12 });
    const noLine = thread({ id: "B", line: null });
    const stale = thread({ id: "C", line: 12, isOutdated: true });

    const { byLine, outdated } = groupThreads([current, noLine, stale]);
    expect(outdated.map((t) => t.id)).toEqual(["B", "C"]);
    // And neither of them landed on line 12 alongside the current one.
    expect(byLine.get("src/a.rs")!.get(12)!.map((t) => t.id)).toEqual(["A"]);
  });

  it("keeps several threads on one line, in the order the server sent them", () => {
    const { byLine } = groupThreads([
      thread({ id: "A", line: 12 }),
      thread({ id: "B", line: 12 }),
    ]);
    expect(byLine.get("src/a.rs")!.get(12)!.map((t) => t.id)).toEqual(["A", "B"]);
  });

  it("keeps two files' threads apart even on the same line number", () => {
    // Line 12 of one file is not line 12 of another, and a flat line-keyed map
    // is exactly how they would merge.
    const { byLine } = groupThreads([
      thread({ id: "A", path: "src/a.rs", line: 12 }),
      thread({ id: "B", path: "src/b.rs", line: 12 }),
    ]);
    expect(byLine.get("src/a.rs")!.get(12)!.map((t) => t.id)).toEqual(["A"]);
    expect(byLine.get("src/b.rs")!.get(12)!.map((t) => t.id)).toEqual(["B"]);
  });
});

describe("an optimistic reply", () => {
  const stored = (id: string, body: string) => ({
    id,
    author: "skarif2",
    body,
    createdAt: "2026-08-03T09:00:00Z",
  });
  const two = () => [
    thread({ id: "T1", comments: [stored("C1", "first")] }),
    thread({ id: "T2", comments: [] }),
  ];

  it("shows itself as unsent, not as a comment the server has", () => {
    // If a pending reply looked like a stored one, a post that failed would
    // leave a comment on screen that nobody else can see, forever.
    const p = pendingComment("on it", 1);
    expect(isPending(p)).toBe(true);
    expect(isPending(stored("C1", "first"))).toBe(false);
    expect(p.author).toBe("you");
  });

  it("appends to its own thread and leaves the others alone", () => {
    const next = withComment(two(), "T2", pendingComment("on it", 1));
    expect(next[1].comments.map((c) => c.body)).toEqual(["on it"]);
    expect(next[0].comments.map((c) => c.body)).toEqual(["first"]);
  });

  it("reconciles in place rather than appending a second time", () => {
    // The failure this shape exists to prevent: reconciling by pushing shows
    // the reply twice, and reconciling by drop-then-append reorders the thread
    // whenever two replies are in flight.
    const pending = pendingComment("on it", 1);
    const shown = withComment(two(), "T1", pending);
    const reconciled = withComment(shown, "T1", stored("C2", "on it"), pending.id);

    expect(reconciled[0].comments.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(reconciled[0].comments.some(isPending)).toBe(false);
  });

  it("keeps the earlier of two in-flight replies first", () => {
    const a = pendingComment("first reply", 1);
    const b = pendingComment("second reply", 2);
    let list = withComment(withComment(two(), "T1", a), "T1", b);
    // The second one answers first, which is exactly when order goes wrong.
    list = withComment(list, "T1", stored("Cb", "second reply"), b.id);
    list = withComment(list, "T1", stored("Ca", "first reply"), a.id);
    expect(list[0].comments.map((c) => c.body)).toEqual([
      "first",
      "first reply",
      "second reply",
    ]);
  });

  it("takes itself back out when the server refuses it", () => {
    const pending = pendingComment("on it", 1);
    const shown = withComment(two(), "T1", pending);
    expect(withoutComment(shown, "T1", pending.id)[0].comments.map((c) => c.id)).toEqual(["C1"]);
  });

  it("does not mutate the list it was given", () => {
    // The list is a signal's value; mutating it in place means Solid never sees
    // the change and the thread silently stops updating.
    const before = two();
    withComment(before, "T1", pendingComment("on it", 1));
    withResolved(before, "T1", true);
    expect(before[0].comments).toHaveLength(1);
    expect(before[0].isResolved).toBe(false);
  });
});

describe("withResolved", () => {
  it("flips one thread and only that thread", () => {
    const next = withResolved([thread({ id: "T1" }), thread({ id: "T2" })], "T2", true);
    expect(next.map((t) => t.isResolved)).toEqual([false, true]);
  });
});

describe("splitByRenderedLines", () => {
  it("holds back a thread whose line no rendered row carries", () => {
    // Current, correct, and still on no row: its line sits in a stretch of the
    // file the patch does not cover. Dropping it silently is how a conversation
    // vanishes from a file that visibly has one.
    const { byLine } = groupThreads([thread({ id: "A", line: 11 }), thread({ id: "B", line: 400 })]);
    const { shown, offDiff } = splitByRenderedLines(byLine.get("src/a.rs"), [10, null, 11, 12]);
    expect([...shown.keys()]).toEqual([11]);
    expect(offDiff.map((t) => t.id)).toEqual(["B"]);
  });

  it("answers empty for a file with no threads at all", () => {
    const { shown, offDiff } = splitByRenderedLines(undefined, [1, 2, 3]);
    expect(shown.size).toBe(0);
    expect(offDiff).toEqual([]);
  });
});
