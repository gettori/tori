import { describe, it, expect, vi, beforeEach } from "vitest";
// Read as text, the way blame.test.ts and commands.test.ts do: this project
// ships no `@types/node`, so `?raw` is how a test inspects source.
import codeEditorSource from "../panels/Editor/CodeEditor.tsx?raw";

// The read behind the "session X, turn N" widget. Unlike blame, whose answer
// cannot change while HEAD stands still, this one changes whenever anything
// writes the file - so the cache has no key that notices, and the drop is the
// whole invalidation story.

let calls: { projectPath: string; file: string; sessions: string[] }[] = [];
let fails = false;

const TURN = { session_id: "sess-1", prompt_ts: 1700, ordinal: 3 };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "agent_lines") return Promise.resolve(null);
    calls.push({
      projectPath: String(args.projectPath),
      file: String(args.file),
      sessions: args.sessions as string[],
    });
    if (fails) return Promise.reject("no such session");
    return Promise.resolve({ lines: [-1, 0], turns: [TURN] });
  },
}));

const {
  agentLinesFor,
  dropAgentLines,
  clearAgentLinesCache,
  agentLabel,
  agentKey,
  turnIdAt,
  revealTarget,
  emptyAgentLines,
  NO_TURN,
} = await import("./agentLines");

const REPO = "/proj";
const SESSIONS = ["sess-1"];

beforeEach(() => {
  calls = [];
  fails = false;
  clearAgentLinesCache();
});

describe("reading who wrote a file's uncommitted lines", () => {
  it("reads a file once, however many times it is asked for", async () => {
    await agentLinesFor(REPO, "a.ts", SESSIONS);
    await agentLinesFor(REPO, "a.ts", SESSIONS);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ projectPath: REPO, file: "a.ts", sessions: SESSIONS });
  });

  it("asks for nothing when no chat is open in the worktree", async () => {
    // The walk is a diff per interval, and with no session there are no
    // intervals: the answer is known without a subprocess.
    const out = await agentLinesFor(REPO, "a.ts", []);

    expect(calls).toEqual([]);
    expect(out).toEqual(emptyAgentLines());
  });

  it("keeps files apart, and repos apart", async () => {
    await agentLinesFor(REPO, "a.ts", SESSIONS);
    await agentLinesFor(REPO, "b.ts", SESSIONS);
    await agentLinesFor("/other", "a.ts", SESSIONS);

    expect(calls.length).toBe(3);
    expect(agentKey(REPO, "a.ts")).not.toBe(agentKey("/other", "a.ts"));
  });

  it("answers empty instead of throwing at the file you opened", async () => {
    fails = true;
    const out = await agentLinesFor(REPO, "a.ts", SESSIONS);

    expect(out.lines).toEqual([]);
    expect(out.turns).toEqual([]);
  });

  it("does not cache a failure, so a transient one clears itself", async () => {
    fails = true;
    await agentLinesFor(REPO, "a.ts", SESSIONS);
    fails = false;
    const out = await agentLinesFor(REPO, "a.ts", SESSIONS);

    expect(calls.length).toBe(2);
    expect(out.turns).toEqual([TURN]);
  });

  it("re-reads a file once it has been written to", async () => {
    // The only thing that changes the answer, and the only thing that
    // invalidates it: there is no HEAD-shaped key here to notice on its own.
    await agentLinesFor(REPO, "a.ts", SESSIONS);
    await agentLinesFor(REPO, "b.ts", SESSIONS);

    dropAgentLines(REPO, "a.ts");

    await agentLinesFor(REPO, "b.ts", SESSIONS);
    // The file nobody wrote to is still cached.
    expect(calls.length).toBe(2);
    await agentLinesFor(REPO, "a.ts", SESSIONS);
    expect(calls.length).toBe(3);
  });

  it("stops growing past its bound", async () => {
    for (let i = 0; i < 60; i++) await agentLinesFor(REPO, `f${i}.ts`, SESSIONS);
    expect(calls.length).toBe(60);

    // The oldest is gone (re-reads), the newest is still there (does not).
    await agentLinesFor(REPO, "f0.ts", SESSIONS);
    expect(calls.length).toBe(61);
    await agentLinesFor(REPO, "f59.ts", SESSIONS);
    expect(calls.length).toBe(61);
  });
});

describe("what the widget says", () => {
  it("names the chat and the turn", () => {
    expect(agentLabel(TURN, "refactor the parser")).toBe("refactor the parser, turn 3");
  });

  it("falls back to a short session id when the chat has no name on screen", () => {
    // A session has an id long before it has a title, and "turn 3" alone does
    // not say *whose* turn 3.
    expect(agentLabel(TURN)).toBe("sess-1, turn 3");
    expect(agentLabel({ ...TURN, session_id: "0123456789abcdef" })).toBe("01234567, turn 3");
    expect(agentLabel(TURN, "   ")).toBe("sess-1, turn 3");
  });

  it("uses git's own -1 for a line no turn wrote", () => {
    expect(NO_TURN).toBe(-1);
  });
});

describe("finding the turn a checkpoint names", () => {
  // The two namings are recorded by different things: the backend knows the
  // prompt timestamp, the transcript is threaded by turn id, and only the tab
  // that ran the turn holds both.
  const STAMPS = { "turn-a": 1000, "turn-b": 2000, "turn-c": 3000 };

  it("answers the turn with that exact stamp", () => {
    expect(turnIdAt(STAMPS, 2000)).toBe("turn-b");
  });

  it("answers null for a turn this tab never ran, rather than the nearest one", () => {
    // A replayed transcript has no stamps. Landing on "the closest turn" would
    // point the reader at a turn that did not write the line.
    expect(turnIdAt(STAMPS, 2500)).toBeNull();
    expect(turnIdAt({}, 2000)).toBeNull();
  });
});

describe("what a chat tab does when a line points at one of its turns", () => {
  const STAMPS = { "turn-a": 1000, "turn-b": 2000 };

  it("ignores a request naming another session", () => {
    expect(revealTarget("mine", STAMPS, { sessionId: "theirs", promptTs: 2000 })).toBeNull();
  });

  it("names the turn to scroll to when this tab ran it", () => {
    expect(revealTarget("mine", STAMPS, { sessionId: "mine", promptTs: 2000 })).toEqual({
      turnId: "turn-b",
    });
  });

  it("still comes forward for a turn it has no stamp for", () => {
    // A replayed transcript has no stamps for turns it did not run. Coming
    // forward is most of what the reader asked for; scrolling to the nearest
    // turn instead would point them at one that did not write the line.
    expect(revealTarget("mine", STAMPS, { sessionId: "mine", promptTs: 1500 })).toEqual({
      turnId: null,
    });
  });
});

describe("keeping the read off the typing path", () => {
  // The same load-bearing rule blame has, and for a sharper reason: this read
  // is several `git diff` subprocesses, not one. A call added to an update
  // listener would put all of them behind every keystroke burst.
  const callsTo = (name: string) =>
    [...codeEditorSource.matchAll(new RegExp(`(?<!function )\\b${name}\\(\\)`, "g"))].length;

  it("reads attribution from exactly the places that may", () => {
    // `syncBlame` on a buffer swap and on the toggle, the clean-reload branch
    // when the buffer adopts a new file from disk, and a chat opening or being
    // renamed (which changes whose turns are covered, and what they are called).
    // Not on a HEAD move: committing does not change who wrote a line.
    expect(callsTo("refreshAgentLines")).toBe(3);
  });

  it("forgets a file every agent write reaches, open or not", () => {
    // The cache carries no version at all, not even the HEAD blame's, so the
    // drop is the whole invalidation story - and an agent writes files whether
    // or not a tab is showing them. The drop therefore has to sit *before* the
    // "does this path have a buffer" test, in the flush that sees every path.
    const flush = codeEditorSource.slice(
      codeEditorSource.indexOf("const flushAgentWrites"),
      codeEditorSource.indexOf("}, AGENT_WRITE_DEBOUNCE_MS)"),
    );
    expect(flush).toContain("dropAgentLines");
    expect(flush.indexOf("dropAgentLines")).toBeLessThan(flush.indexOf("buffers.has(p)"));
  });

  it("never mentions attribution inside an update listener", () => {
    const listeners = codeEditorSource.split("EditorView.updateListener.of(").slice(1);
    expect(listeners.length).toBeGreaterThan(0);
    for (const body of listeners) {
      const block = body.slice(0, body.indexOf("\n  "));
      expect(block.toLowerCase()).not.toContain("agent");
    }
  });
});
