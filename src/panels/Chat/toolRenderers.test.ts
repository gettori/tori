import { describe, it, expect } from "vite-plus/test";
import events from "../../../dev/fixtures/chat/events.json";
import { parseChatEvent } from "../../utils/chatTypes";
import { applyEvent, initialChat, type ChatItem, type QuestionItem, type ToolItem } from "./chatStore";
import {
  foldEdits,
  formatDuration,
  groupRuns,
  isEditCall,
  runLabel,
  toolDigest,
  toolPaths,
  toolRenderer,
  toolSummaryText,
} from "./toolRenderers";

const card = (over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "tool1",
  toolUseId: "toolu_1",
  agentId: null,
  turnId: "t1",
  name: "Bash",
  title: null,
  toolKind: "execute",
  locations: [],
  input: { command: "git status" },
  state: "ok",
  outputTruncated: false,
  approval: null,
  output: null,
  summary: null,
  patch: [],
  files: [],
  durationMs: null,
  edits: [],
  ...over,
});

describe("toolRenderer", () => {
  // Nothing has answered yet, so the kind is the whole of what is known.
  it("picks a body from the kind while the call is still running", () => {
    expect(toolRenderer(card({ toolKind: "execute", summary: null }))).toBe("execute");
    expect(toolRenderer(card({ toolKind: "read", summary: null }))).toBe("read");
    expect(toolRenderer(card({ toolKind: "search", summary: null }))).toBe("search");
    expect(toolRenderer(card({ toolKind: "move", summary: null }))).toBe("edit");
  });

  // The whole reason dispatch moved off the tool name: `Grep` and `Glob` are
  // both `search` calls, and only the result says which body reads them.
  it("lets the result tell a hit list from a path list, with no tool name consulted", () => {
    const grepContent = card({
      name: "Glob",
      toolKind: "search",
      summary: { type: "search", hits: 12, files: 3 },
    });
    const glob = card({
      name: "Grep",
      toolKind: "search",
      summary: { type: "paths", count: 7 },
    });
    expect(toolRenderer(grepContent)).toBe("search");
    expect(toolRenderer(glob)).toBe("paths");
  });

  // The fallback is the common case, not the error case: a plugin, an MCP
  // server or a future release can name a tool we have never heard of, and a
  // card that threw on one would take the transcript down with it.
  it("falls back for a kind it has no body for rather than guessing or throwing", () => {
    expect(toolRenderer(card({ toolKind: "other", summary: null }))).toBe("generic");
    expect(toolRenderer(card({ toolKind: "think", summary: null }))).toBe("generic");
    expect(toolRenderer(card({ toolKind: "switchMode", summary: null }))).toBe("generic");
  });

  it("treats exactly the writing calls as having a diff worth fetching", () => {
    expect(isEditCall(card({ toolKind: "edit", summary: null }))).toBe(true);
    expect(isEditCall(card({ toolKind: "other", summary: { type: "edit", added: 4, removed: 2 } }))).toBe(true);
    expect(isEditCall(card({ toolKind: "read", summary: null }))).toBe(false);
    expect(isEditCall(card({ toolKind: "execute", summary: null }))).toBe(false);
  });
});

describe("toolSummaryText", () => {
  it("says what each kind of result did", () => {
    expect(toolSummaryText({ type: "search", hits: 12, files: 3 })).toBe("12 hits in 3 files");
    expect(toolSummaryText({ type: "paths", count: 7 })).toBe("7 files");
    expect(toolSummaryText({ type: "read", lines: 13, from: 1, total: 400 })).toBe("13 of 400 lines");
    expect(toolSummaryText({ type: "execute", exitCode: 1, lines: 118 })).toBe("exit 1, 118 lines");
    expect(toolSummaryText({ type: "edit", added: 4, removed: 2 })).toBe("+4 -2");
    expect(toolSummaryText({ type: "fetch", host: "example.com", status: 200, bytes: 559 })).toBe("200, 559 B");
  });

  // The absent halves are what actually ships: Claude reports no exit code at
  // all, and `Grep` in content mode reports no usable file count.
  it("says the half it has when the other is not reported", () => {
    expect(toolSummaryText({ type: "search", hits: 12, files: null })).toBe("12 hits");
    expect(toolSummaryText({ type: "read", lines: 40, from: 1, total: null })).toBe("40 lines");
    expect(toolSummaryText({ type: "execute", exitCode: null, lines: 118 })).toBe("118 lines");
    expect(toolSummaryText({ type: "fetch", host: "example.com", status: null, bytes: 4096 })).toBe("4.0 KB");
    expect(toolSummaryText({ type: "fetch", host: "example.com", status: null, bytes: null })).toBe("");
  });

  it("counts in the singular where the number is one", () => {
    expect(toolSummaryText({ type: "search", hits: 1, files: 1 })).toBe("1 hit in 1 file");
    expect(toolSummaryText({ type: "paths", count: 1 })).toBe("1 file");
  });

  // A command that printed nothing is a result, not a missing one.
  it("distinguishes a command that printed nothing from a call with no summary", () => {
    expect(toolSummaryText({ type: "execute", exitCode: 0, lines: 0 })).toBe("no output");
    expect(toolSummaryText(null)).toBe("");
  });
});

describe("toolDigest", () => {
  it("picks the argument that distinguishes one call from another", () => {
    expect(toolDigest(card())).toBe("git status");
    expect(toolDigest(card({ name: "Read", input: { file_path: "/a.rs" } }))).toBe("/a.rs");
    expect(toolDigest(card({ name: "Grep", input: { pattern: "fn main" } }))).toBe("fn main");
    expect(toolDigest(card({ name: "Task", input: { description: "find it" } }))).toBe("find it");
  });

  it("renders as just the tool name when nothing identifies the call", () => {
    expect(toolDigest(card({ input: null }))).toBe("");
    expect(toolDigest(card({ input: { unknown: 1 } }))).toBe("");
    expect(toolDigest(card({ input: 42 }))).toBe("");
  });
});

describe("toolPaths", () => {
  it("collects the paths a call declared and the ones it turned out to write", () => {
    const c = card({
      name: "Edit",
      input: { file_path: "/a.rs" },
      edits: [{ path: "/b.rs", kind: "modified", beforeBlob: null }],
      files: ["/c.rs"],
    });
    expect(toolPaths(c)).toEqual(["/a.rs", "/b.rs", "/c.rs"]);
  });

  it("does not repeat a path that appears in more than one place", () => {
    const c = card({
      name: "Edit",
      input: { file_path: "/a.rs" },
      edits: [{ path: "/a.rs", kind: "modified", beforeBlob: null }],
      files: ["/a.rs"],
    });
    expect(toolPaths(c)).toEqual(["/a.rs"]);
  });

  // A Grep pattern looks path-shaped and is not one. Linking it would offer to
  // open a file that does not exist.
  it("never mistakes a search pattern for a path", () => {
    expect(toolPaths(card({ name: "Grep", input: { pattern: "src/.*\\.ts" } }))).toEqual([]);
  });

  // ACP publishes locations and no arguments Tori can read, so without these a
  // codex card knows the file it read and cannot offer to open it.
  it("lists the locations an agent declared for a call with no path in its arguments", () => {
    const c = card({
      name: "read",
      input: null,
      locations: [
        { path: "/a.rs", line: 12 },
        { path: "/b.rs", line: null },
      ],
    });
    expect(toolPaths(c)).toEqual(["/a.rs", "/b.rs"]);
  });
});

describe("foldEdits", () => {
  const write = (id: string, path: string, over: Partial<ToolItem> = {}): ToolItem =>
    card({ id, toolUseId: id, name: "Edit", toolKind: "edit", input: { file_path: path }, state: "ok", ...over });

  it("folds a run of writes to one file onto the first of them", () => {
    const { followers, hidden } = foldEdits([write("a", "/x.ts"), write("b", "/x.ts"), write("c", "/x.ts")]);
    expect(followers.get("a")?.map((c) => c.id)).toEqual(["b", "c"]);
    expect([...hidden]).toEqual(["b", "c"]);
  });

  it("keeps writes to different files apart", () => {
    const { followers, hidden } = foldEdits([write("a", "/x.ts"), write("b", "/y.ts")]);
    expect(followers.size).toBe(0);
    expect(hidden.size).toBe(0);
  });

  // The run has to be adjacent, or a card would fold into one it does not sit
  // beside and the transcript would stop reading in order.
  it("ends a run at anything that is not a write to the same file", () => {
    const between = card({ id: "r", toolUseId: "r", name: "Read", toolKind: "read" });
    const { followers, hidden } = foldEdits([write("a", "/x.ts"), between, write("b", "/x.ts")]);
    expect(followers.size).toBe(0);
    expect(hidden.size).toBe(0);
  });

  // Approving is per call, and so is failing: neither may be hidden behind
  // another card.
  it("never folds a call that is still waiting, or one that did not succeed", () => {
    const blocked = write("b", "/x.ts", { state: "awaitingApproval", approval: null });
    const failed = write("c", "/x.ts", { state: "error" });
    const { hidden } = foldEdits([write("a", "/x.ts"), blocked, failed]);
    expect(hidden.size).toBe(0);
  });

  it("leaves a transcript with no writes in it completely alone", () => {
    const { followers, hidden } = foldEdits([card({ id: "x", toolUseId: "x" })]);
    expect(followers.size).toBe(0);
    expect(hidden.size).toBe(0);
  });
});

describe("groupRuns", () => {
  const tool = (id: string, over: Partial<ToolItem> = {}): ToolItem => card({ id, toolUseId: id, ...over });
  const text = (id: string): ChatItem => ({ kind: "text", id, turnId: "t1", text: "reply", agentId: null });
  const thinking = (id: string): ChatItem => ({
    kind: "thinking",
    id,
    turnId: "t1",
    text: "hm",
    startedAt: 0,
    endedAt: 0,
    agentId: null,
  });
  const hook = (id: string): ChatItem => ({
    kind: "hook",
    id,
    hookId: id,
    name: "Stop",
    event: "Stop",
    phase: "finished",
    toriOwned: false,
    outcome: null,
    exitCode: 1,
    output: null,
    stderr: null,
  });
  const question = (id: string, over: Partial<QuestionItem> = {}): QuestionItem => ({
    kind: "question",
    id,
    toolUseId: id,
    turnId: "t1",
    requestId: null,
    agentId: null,
    questions: [],
    submitted: null,
    result: "answered",
    ...over,
  });
  const shape = (items: ChatItem[], cache = new Map()) => {
    const { rows, members } = groupRuns(items, cache);
    return rows.map((r) => (r.kind === "run" ? members.get(r)?.map((m) => m.id) : r.id));
  };

  it("gathers thinking, calls, hooks and settled questions between two replies into one run", () => {
    expect(shape([text("a"), thinking("b"), tool("c"), hook("d"), question("e"), text("f")])).toEqual([
      "a",
      ["b", "c", "d", "e"],
      "f",
    ]);
  });

  it("ends a run at a prompt, a reply, a command's output and a notice", () => {
    const breakers: ChatItem[] = [
      { kind: "user", id: "u", blocks: [], steer: false },
      text("x"),
      { kind: "command", id: "c", turnId: "t1", command: null, output: "" },
      { kind: "notice", id: "n", text: "", level: "info" },
    ];
    for (const b of breakers) {
      expect(shape([tool("a"), b, tool("z")]), b.kind).toEqual([["a"], b.id, ["z"]]);
    }
  });

  // A prompt hidden behind a card is a session that looks hung.
  it("keeps a row the session is stopped on out of any run", () => {
    const waiting = tool("p", { state: "awaitingApproval" });
    expect(shape([tool("a"), waiting, tool("z")])).toEqual([["a"], "p", ["z"]]);
    const asked = question("q", { requestId: "r1", result: null });
    expect(shape([tool("a"), asked, tool("z")])).toEqual([["a"], "q", ["z"]]);
  });

  it("hands back the same run as it grows, loses its head, and absorbs the run after it", () => {
    const cache = new Map();
    const [a, b, c] = [tool("a"), tool("b"), tool("c")];
    const first = groupRuns([a, b], cache).rows[0];

    expect(groupRuns([a, b, c], cache).rows[0]).toBe(first);
    expect(groupRuns([b, c], cache).rows[0]).toBe(first);

    const waiting = tool("p", { state: "awaitingApproval" });
    const split = groupRuns([b, c, waiting, tool("z")], cache).rows;
    expect(split[0]).toBe(first);
    expect(split[2]).not.toBe(first);

    const merged = groupRuns([b, c, { ...waiting, state: "ok" }, tool("z")], cache).rows;
    expect(merged).toEqual([first]);
    expect(merged[0]).toBe(first);
  });

  it("gives the second half its own run when a call in the middle starts waiting", () => {
    const cache = new Map();
    const [a, p, z] = [tool("a"), tool("p"), tool("z")];
    const whole = groupRuns([a, p, z], cache).rows[0];
    const split = groupRuns([a, { ...p, state: "awaitingApproval" }, z], cache).rows;
    expect(split[0]).toBe(whole);
    expect(split[2]).not.toBe(whole);
  });
});

describe("runLabel", () => {
  const tool = (id: string, over: Partial<ToolItem> = {}): ToolItem => card({ id, toolUseId: id, ...over });
  const thinking = (id: string, ms: number): ChatItem => ({
    kind: "thinking",
    id,
    turnId: "t1",
    text: "hm",
    startedAt: 0,
    endedAt: ms,
    agentId: null,
  });
  const hook = (id: string, hookId: string, exitCode: number | null): ChatItem => ({
    kind: "hook",
    id,
    hookId,
    name: "Stop",
    event: "Stop",
    phase: exitCode === null ? "started" : "finished",
    toriOwned: false,
    outcome: null,
    exitCode,
    output: null,
    stderr: null,
  });
  const question: QuestionItem = {
    kind: "question",
    id: "q",
    toolUseId: "q",
    turnId: "t1",
    requestId: null,
    agentId: null,
    questions: [],
    submitted: null,
    result: "answered",
  };

  it("counts what a settled run holds", () => {
    expect(runLabel([thinking("a", 500), tool("b"), tool("c"), question], false).text).toBe("2 tool calls, 1 question");
    expect(runLabel([tool("b")], false).text).toBe("1 tool call");
  });

  // Two frames per execution, so counting rows would say a hook ran twice.
  it("counts a hook once however many frames it sent", () => {
    const label = runLabel([hook("a", "h1", null), hook("b", "h1", 0), tool("c")], false);
    expect(label.text).toBe("1 tool call, 1 hook");
    expect(label.failed).toBe(0);
  });

  // A hook on a session event sits between a reply and the next prompt with
  // no call beside it, and by default only a failed one is shown at all.
  it("names a run that is only a hook as a hook", () => {
    expect(runLabel([hook("a", "h1", 2)], false)).toEqual({ text: "1 hook", failed: 1, live: false });
  });

  it("says how long a run of thinking alone took, across its blocks", () => {
    expect(runLabel([thinking("a", 5000), thinking("b", 7000)], false).text).toBe("Thought for 12s");
  });

  it("counts a call that errored and a hook that exited non-zero as failed", () => {
    const label = runLabel([tool("a", { state: "error" }), tool("b"), hook("c", "h1", 1)], false);
    expect(label.failed).toBe(2);
  });

  it("names the last member while the run is the live tail, whatever state it is in", () => {
    expect(runLabel([tool("a"), tool("b", { state: "running" })], true).text).toBe("Bash git status");
    expect(runLabel([tool("a"), tool("b", { state: "ok" })], true).text).toBe("Bash git status");
    expect(runLabel([tool("a", { title: "Run the tests", input: {} })], true).text).toBe("Run the tests");
    expect(runLabel([tool("a"), thinking("b", 0)], true)).toEqual({ text: "Thinking", failed: 0, live: true });
    expect(runLabel([tool("a"), hook("b", "h1", null)], true).text).toBe("Stop");
  });

  it("falls back to the count for a live tail that is a settled question", () => {
    expect(runLabel([tool("a"), question], true)).toEqual({ text: "1 tool call, 1 question", failed: 0, live: false });
  });
});

describe("formatDuration", () => {
  it("says nothing about a call too fast to be worth mentioning", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(400)).toBe("");
  });

  it("scales the unit to the magnitude", () => {
    expect(formatDuration(2500)).toBe("2.5s");
    expect(formatDuration(120_000)).toBe("2m");
  });
});

// The same file the Rust round-trip test writes. Every tool call the fixture
// contains has to reach a renderer, so a tool named in the contract cannot
// silently have no way to render.
describe("the recorded fixture", () => {
  it("gives every tool call in it a renderer and a card", () => {
    const s = initialChat("s1");
    for (const raw of events as unknown[]) {
      const ev = parseChatEvent(raw);
      if (ev) applyEvent(s, ev);
    }
    const cards = s.items.filter((i): i is ToolItem => i.kind === "tool");
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(() => toolRenderer(c)).not.toThrow();
      expect(() => toolDigest(c)).not.toThrow();
      expect(() => toolPaths(c)).not.toThrow();
    }
  });
});
