import { describe, it, expect } from "vite-plus/test";
import { composeThreadAsk, threadWhere, REPLY_CAP } from "./threadAsk";
import { sanitizeForSend, type SessionTarget } from "./safeSend";
import type { ReviewComment, ReviewThread } from "./forgeTypes";

// The composed message, case by case, in a committed fixture.
//
// A golden rather than a set of `toContain` assertions because this text is a
// wire format: it is read by an agent, not by a person scanning for a keyword,
// and every word of it is a choice. Regenerate deliberately, never reflexively:
//   npx vitest run src/utils/threadAsk.test.ts -u
// A diff here means agents are being asked something different.

const ROOT = "/Users/dev/proj";

const TARGET: SessionTarget = {
  sessionId: "S1",
  agent: "claude",
  profile: null,
  folderPath: ROOT,
  sessionCwd: ROOT,
  sessionPath: `${ROOT}/.sessions/S1.jsonl`,
  sessionTitle: "wave-3",
  sessionFile: `${ROOT}/.sessions/S1.jsonl`,
};

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "C1",
  author: "reviewer",
  body: "this drops the error",
  createdAt: "2026-08-03T09:00:00Z",
  ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "PRRT_1",
  path: "src/utils/diff.ts",
  line: 12,
  startLine: null,
  diffHunk: "@@ -10,3 +10,4 @@\n fn main() {\n+    let x = 1;",
  isResolved: false,
  isOutdated: false,
  comments: [comment()],
  ...over,
});

/** Every shape the composer branches on, named by what makes it different. */
const CASES: Record<string, ReviewThread> = {
  "a single line": thread(),
  "a multi-line range": thread({ startLine: 9 }),
  "a range whose start equals its line": thread({ startLine: 12 }),
  "an outdated thread that still has a line": thread({ isOutdated: true, startLine: 9 }),
  "a thread whose line is gone": thread({ line: null, startLine: null, isOutdated: true }),
  "an already resolved thread": thread({ isResolved: true }),
  "a thread with replies": thread({
    comments: [
      comment(),
      comment({ id: "C2", author: "alice", body: "and it misses the null case" }),
      comment({ id: "C3", author: "skarif2", body: "will fix" }),
    ],
  }),
  "a thread with more replies than the cap": thread({
    comments: [
      comment(),
      ...Array.from({ length: REPLY_CAP + 2 }, (_, i) =>
        comment({ id: `C${i + 2}`, author: `dev${i}`, body: `point ${i}` }),
      ),
    ],
  }),
  "a body that wraps over several lines": thread({
    comments: [comment({ body: "this drops the error\n\nand the retry never fires\n" })],
  }),
  "a thread nobody has commented on": thread({ comments: [] }),
  "a body that tries to break out of the paste": thread({
    comments: [comment({ body: "looks fine\x1b[201~\x1b[31m to me" })],
  }),
};

describe("composing a review thread for the agent that owns the branch", () => {
  const composed = Object.fromEntries(
    Object.entries(CASES).map(([name, t]) => [name, composeThreadAsk(TARGET, ROOT, 12, t)]),
  );

  it("reproduces the committed golden exactly", async () => {
    await expect(`${JSON.stringify(composed, null, 2)}\n`).toMatchFileSnapshot("./__fixtures__/threadAsk.golden.json");
  });

  it("survives the send path unchanged", () => {
    // The claim the golden depends on. `sendWithProbeGate` writes
    // `sanitizeForSend`'s output, so anything the composer emits that sanitising
    // would rewrite is text the fixture records and the agent never receives.
    for (const [name, text] of Object.entries(composed)) {
      expect(sanitizeForSend(text), name).toBe(text);
    }
  });

  it("names the range Tori itself sent, not just its last line", () => {
    // A comment Tori wrote through Phase 11 can span lines, so reporting `line`
    // alone would narrow a range this very app had chosen.
    expect(threadWhere(thread({ startLine: 9 }))).toBe("lines 9-12");
    expect(threadWhere(thread())).toBe("line 12");
  });

  it("says when a line number counts against an older commit", () => {
    // The sharp case: outdated with a line still set. The number is real, but it
    // is a line of the file as it was, so an agent given the bare number would
    // edit the wrong place and be sure of it.
    expect(threadWhere(thread({ isOutdated: true }))).toBe("line 12 as the file then stood");
    expect(threadWhere(thread({ line: null }))).toBe("on lines that have changed since it was written");
  });

  it("quotes every reply up to the cap and counts the rest", () => {
    const text = composed["a thread with more replies than the cap"];
    expect(text).toContain(`point ${REPLY_CAP - 1}`);
    expect(text).not.toContain(`point ${REPLY_CAP}`);
    expect(text).toContain("(and 2 more replies)");
  });

  it("mentions the file the way a drag would, from wherever the session sits", () => {
    // The relativity rule every composer here follows. A session running in a
    // subfolder of the repo gets an absolute path, because the relative one
    // would resolve against its cwd and point at a file that is not there.
    const elsewhere = { ...TARGET, sessionCwd: `${ROOT}/docs` };
    expect(composeThreadAsk(elsewhere, ROOT, 12, thread())).toContain(`@${ROOT}/src/utils/diff.ts `);
  });

  it("resolves the path against the owning unit's folder, not the panel's", () => {
    // A worktree project's units each have their own checkout. Composing against
    // whichever directory the panel happens to show would mention a file in a
    // different worktree, which the agent can open and which is the wrong copy.
    const wt = `${ROOT}/.worktrees/feat`;
    const inWorktree = { ...TARGET, folderPath: wt, sessionCwd: wt };
    expect(composeThreadAsk(inWorktree, wt, 12, thread())).toContain("@src/utils/diff.ts ");
  });

  it("never truncates a body", () => {
    // A capped reply count loses the tail of an argument; a capped body loses
    // the point of it. Only one of those is recoverable by opening the PR.
    const long = "x".repeat(4000);
    expect(composeThreadAsk(TARGET, ROOT, 12, thread({ comments: [comment({ body: long })] }))).toContain(long);
  });
});
