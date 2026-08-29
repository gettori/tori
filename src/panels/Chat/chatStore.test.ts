import { describe, it, expect, vi, afterEach } from "vitest";
import events from "../../../dev/fixtures/chat/events.json";
import { parseChatEvent, type ChatEvent, type ToolSummary } from "../../utils/chatTypes";
import { BLOCKED_REASON, sendWithProbeGate } from "../../utils/safeSend";
import {
  answerable,
  applyEvent,
  beginReconnect,
  chatStatus,
  clearAwaitingTurn,
  connectionHealth,
  discardQueue,
  effortPending,
  enqueue,
  filesWritten,
  hasEarlier,
  initialChat,
  isRunning,
  modePending,
  modelPending,
  pendingApprovals,
  pendingSwitchNotice,
  pendingFlush,
  promptsSent,
  replayFold,
  parseQuestions,
  pushQuestionAnswers,
  pushSteer,
  pushUserTurn,
  toolCallsSeen,
  reasoningFor,
  sendCapable,
  releaseQueue,
  removeQueued,
  resolveApproval,
  revertEffortPick,
  revertModelPick,
  seedEffort,
  selectEffort,
  selectMode,
  selectModel,
  settleBackfill,
  shownEffort,
  shownMode,
  shownModelValue,
  steerable,
  steerProbe,
  takeForSend,
  visibleItems,
  windowed,
  type ChatItem,
  type QuestionItem,
  type ChatState,
  type ThinkingItem,
  type ToolItem,
  type UserItem,
} from "./chatStore";

// The same file the Rust round-trip test writes, so a renamed field on either
// side fails here rather than surviving as two halves that disagree.
const FIXTURE: ChatEvent[] = (events as unknown[]).map((e) => {
  const ev = parseChatEvent(e);
  if (!ev) throw new Error(`fixture event did not parse: ${JSON.stringify(e)}`);
  return ev;
});

function replay(evs: readonly ChatEvent[], sessionId = "s1"): ChatState {
  const s = initialChat(sessionId);
  for (const e of evs) applyEvent(s, e);
  return s;
}

const kinds = (s: ChatState) => s.items.map((i) => i.kind);
const tool = (s: ChatState, toolUseId: string): ToolItem => s.items[s.toolIndex[toolUseId]] as ToolItem;

// Minimal well-typed event builders, so a test says only what it is about.
const turnStarted = (turnId: string, model = "m"): ChatEvent => ({
  type: "turnStarted",
  sessionId: "s1",
  turnId,
  model,
  permissionMode: "default",
});
const sessionStarted = (over: Partial<Extract<ChatEvent, { type: "sessionStarted" }>> = {}): ChatEvent => ({
  type: "sessionStarted",
  sessionId: "s1",
  cwd: "/w",
  model: "claude-sonnet-5",
  permissionMode: "default",
  tools: [],
  slashCommands: [],
  mcpServers: [],
  models: [],
  modes: [],
  fastModeState: null,
  fastModeDisabledReason: null,
  account: null,
  ...over,
});
const text = (turnId: string, t: string): ChatEvent => ({ type: "textDelta", sessionId: "s1", turnId, text: t });
const started = (turnId: string, toolUseId: string, name = "Edit", input: unknown = { file_path: "/a" }): ChatEvent => ({
  type: "toolCallStarted",
  sessionId: "s1",
  turnId,
  toolUseId,
  name,
  input,
  kind: "edit",
  locations: [],
  title: null,
});
const completed = (turnId: string, toolUseId: string, status: "ok" | "error" | "denied" = "ok"): ChatEvent => ({
  type: "toolCallCompleted",
  sessionId: "s1",
  turnId,
  toolUseId,
  status,
  output: "done",
  files: ["/a"],
  durationMs: 12,
  summary: null,
  outputTruncated: false,
  patch: [],
});
const prompt = (toolUseId: string, requestId = "r1"): ChatEvent => ({
  type: "permissionRequest",
  sessionId: "s1",
  toolUseId,
  toolName: "Bash",
  input: { command: "ls" },
  requestId,
  autoDenyAtMs: null,
  agentId: null,
});
const turnDone = (turnId: string, outcome: "completed" | "cancelled" | "errored"): ChatEvent => ({
  type: "turnCompleted",
  sessionId: "s1",
  turnId,
  outcome,
  stopReason: null,
  usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
  costUsd: 0.01,
  permissionDenials: [],
});

// The three switches land at the same turn boundary, so they are promised once
// rather than three times - and above the input rather than in the bar, where
// the sentence used to appear beside whichever pill was pending and push every
// control to its right out from under the cursor.
describe("what is waiting for the next turn", () => {
  const pending = (over: Partial<ChatState>) => pendingSwitchNotice({ ...initialChat("s1"), ...over });

  it("says nothing while nothing is waiting", () => {
    expect(pendingSwitchNotice(initialChat("s1"))).toBeNull();
  });

  it("names the one control that is waiting", () => {
    expect(pending({ pendingEffort: "high" })).toBe("Thinking effort applies from the next turn.");
    expect(pending({ pendingMode: "plan" })).toBe("Permission mode applies from the next turn.");
  });

  it("names them all in one sentence when several are", () => {
    expect(
      pending({
        pendingModel: { value: "sonnet", resolvedModel: "claude-sonnet-5" },
        pendingEffort: "high",
        pendingMode: "plan",
      }),
    ).toBe("Model, thinking effort and permission mode apply from the next turn.");
    expect(pending({ pendingEffort: "high", pendingMode: "plan" })).toBe(
      "Thinking effort and permission mode apply from the next turn.",
    );
  });

  // `undefined` is "nothing picked" and `null` is "picked: back to the CLI's
  // own default", which is a switch like any other and waits like one.
  it("counts a pick of the CLI's own default as a pick", () => {
    expect(pending({ pendingEffort: null })).toBe("Thinking effort applies from the next turn.");
  });
});

// Effort is the one setting nothing on the wire ever mentions: `system/init`
// names the model and the permission mode and stops there, and a resume does
// not carry the flag. So the level a session was started on has to be recorded
// as applied when the panel opens, or the control describes a child it is not
// running.
describe("the effort a session opened on", () => {
  it("is in force from the first frame, not pending", () => {
    const s = initialChat("s1");
    seedEffort(s, "high");
    expect(shownEffort(s)).toBe("high");
    expect(effortPending(s)).toBe(false);
  });

  it("never overwrites a level this session has actually picked", () => {
    // The seed is what the argv already carried; a pick is a request in flight.
    // Ordering is not something a mount can promise, so the seed yields.
    const s = initialChat("s1");
    selectEffort(s, "low");
    seedEffort(s, "high");
    expect(shownEffort(s)).toBe("low");
  });
});

// A compaction is 30-odd seconds in which the wire says nothing at all
// (measured at 33s on dev/fixtures/claude/compaction.jsonl: the start frame,
// then the boundary, with nothing between them). The transcript's job in that
// window is to say the session is working rather than wedged.
describe("a compaction while it is running", () => {
  const started: ChatEvent = { type: "compactionStarted", sessionId: "s1", turnId: "t1" };
  const failed: ChatEvent = {
    type: "compactionFailed",
    sessionId: "s1",
    turnId: "t1",
    error: "Not enough messages to compact.",
  };
  const boundary = (pre: number | null, post: number | null): ChatEvent => ({
    type: "compacted",
    sessionId: "s1",
    turnId: "t1",
    trigger: "manual",
    preTokens: pre,
    postTokens: post,
    summary: "the summary",
  });
  const notices = (s: ChatState) => s.items.filter((i): i is Extract<ChatItem, { kind: "notice" }> => i.kind === "notice");

  it("announces itself the moment it starts, with a stamp to count from", () => {
    const s = replay([turnStarted("t1"), started]);
    expect(notices(s)).toHaveLength(1);
    expect(notices(s)[0].text).toBe("Compacting the conversation");
    expect(notices(s)[0].pendingSince).toBeGreaterThan(0);
  });

  it("settles into the same row rather than pushing a second one", () => {
    // The running row and the result are one event. Two rows would leave
    // "Compacting the conversation" sitting above its own outcome forever.
    const s = replay([turnStarted("t1"), started, boundary(16_572, 1_990)]);
    expect(notices(s)).toHaveLength(1);
    expect(notices(s)[0].text).toBe("Compacted manually (17k to 2k).");
    expect(notices(s)[0].pendingSince).toBeUndefined();
    expect(notices(s)[0].details).toBe("the summary");
  });

  it("says so when the agent refused, which used to be silent", () => {
    const s = replay([turnStarted("t1"), started, failed]);
    expect(notices(s)).toHaveLength(1);
    expect(notices(s)[0].text).toBe("Compaction failed: Not enough messages to compact.");
    expect(notices(s)[0].level).toBe("error");
  });

  it("drops the row when the turn ends having reported neither", () => {
    // An interrupt, a crash, a CLI that reports neither end. Nothing was
    // recorded, so nothing is claimed - and a row still saying "Compacting"
    // after the turn is over is the one outcome worse than no row at all.
    const s = replay([turnStarted("t1"), started, turnDone("t1", "cancelled")]);
    expect(notices(s)).toHaveLength(0);
  });

  it("still reports a compaction it never saw start", () => {
    // Replayed history and any agent that reports no start of its own: the
    // boundary alone is still the whole record.
    const s = replay([turnStarted("t1"), boundary(247_408, 9_444)]);
    expect(notices(s).map((n) => n.text)).toEqual(["Compacted manually (247k to 9k)."]);
  });

  it("ignores a second start while one is already running", () => {
    const s = replay([turnStarted("t1"), started, started]);
    expect(notices(s)).toHaveLength(1);
  });
});

// What the context meter divides. Measured on dev/fixtures/claude, where one
// turn made three API calls reading 17,440, 23,532 and 23,766 cached tokens and
// the result frame reported their sum, 64,738, for a conversation that never
// held more than 24k. Read the sum as the context and a long turn reports
// several times the window it is running in.
describe("what a turn's usage means", () => {
  const usage = (turnId: string, cacheRead: number, extra?: Record<string, unknown>): ChatEvent => ({
    type: "usage",
    sessionId: "s1",
    turnId,
    usage: { inputTokens: 2, outputTokens: 9, cacheReadTokens: cacheRead, cacheWriteTokens: 0, thinkingTokens: 0 },
    ...(extra ? { extra } : {}),
  });
  const resultUsage = (turnId: string, cacheRead: number): ChatEvent => ({
    ...(turnDone(turnId, "completed") as Extract<ChatEvent, { type: "turnCompleted" }>),
    usage: { inputTokens: 6, outputTokens: 30, cacheReadTokens: cacheRead, cacheWriteTokens: 0, thinkingTokens: 0 },
  });

  it("reads the context off the newest response, not off the turn's total", () => {
    const s = replay([turnStarted("t1"), usage("t1", 17_440), usage("t1", 23_766), resultUsage("t1", 64_738)]);
    expect(s.contextTokens).toBe(2 + 23_766);
  });

  it("still totals the turn, under the names that mean the turn", () => {
    // The aggregate is not wrong, it is a different measurement: it is what the
    // turn cost. Losing it would take the cost readout with it.
    const s = replay([turnStarted("t1"), usage("t1", 17_440), resultUsage("t1", 64_738)]);
    expect(s.lastTurnUsage?.cacheReadTokens).toBe(64_738);
    expect(s.totalUsage.cacheReadTokens).toBe(64_738);
  });

  it("keeps the last response's figure after the turn ends", () => {
    // The regression this pins: a turn that completes must not move the meter.
    // It used to jump to the total at exactly that moment, which is why the
    // number looked right mid-turn and wrong the rest of the time.
    const s = replay([turnStarted("t1"), usage("t1", 23_766), resultUsage("t1", 64_738)]);
    const during = replay([turnStarted("t1"), usage("t1", 23_766)]);
    expect(s.contextTokens).toBe(during.contextTokens);
  });

  // A compaction is the one moment the newest response stops describing the
  // conversation: the middle of it has just been replaced by a summary. The
  // boundary reports the size it left behind, so there is a measured answer to
  // move to rather than a stale one to sit on.
  it("follows a compaction down to the size it left behind", () => {
    const compacted = (post: number | null): ChatEvent => ({
      type: "compacted",
      sessionId: "s1",
      turnId: "t1",
      trigger: "auto",
      preTokens: 247_000,
      postTokens: post,
      summary: null,
    });
    const s = replay([turnStarted("t1"), usage("t1", 240_000), compacted(9_000)]);
    expect(s.contextTokens).toBe(9_000);

    // ...and the next response supersedes it in turn, with no precedence rule
    // to get wrong: whichever measurement arrived last is the answer.
    const after = replay([turnStarted("t1"), usage("t1", 240_000), compacted(9_000), usage("t1", 12_000)]);
    expect(after.contextTokens).toBe(2 + 12_000);
  });

  it("holds its last reading when a compaction reports no size", () => {
    // Nothing measured is not zero. The next response repopulates it within one
    // API call, and until then a figure that was true a moment ago beats one
    // that was never true.
    const s = replay([
      turnStarted("t1"),
      usage("t1", 240_000),
      {
        type: "compacted",
        sessionId: "s1",
        turnId: "t1",
        trigger: "manual",
        preTokens: null,
        postTokens: null,
        summary: null,
      } as ChatEvent,
    ]);
    expect(s.contextTokens).toBe(2 + 240_000);
  });

  it("takes the window an ACP agent states beside its occupancy", () => {
    // ACP reports "used of size" per session rather than per model, so it
    // cannot go in the per-model map Claude fills.
    const s = replay([turnStarted("t1"), usage("t1", 1000, { contextWindow: 200_000 })]);
    expect(s.contextWindow).toBe(200_000);
  });

  it("ignores a stated window that is not one", () => {
    const s = replay([turnStarted("t1"), usage("t1", 1000, { contextWindow: 0 })]);
    expect(s.contextWindow).toBeNull();
  });
});

describe("replaying the captured fixture", () => {
  it("produces one item per rendered event, in arrival order", () => {
    const s = replay(FIXTURE);
    // the replayed user turn, the compaction notice, then the second one the
    // compaction *lifecycle* pair leaves behind (a start that the failure
    // settles in place), text, thinking, then a card each for toolu_1
    // (started), toolu_2 (fileEdit) and toolu_3 (permissionRequest), then
    // toolu_4's question, then the error and end notices, and last the hook
    // frame (the fixture lists it after the lifecycle events).
    expect(kinds(s)).toEqual([
      "user",
      "notice",
      "notice",
      "text",
      "thinking",
      "tool",
      "tool",
      "tool",
      "question",
      "notice",
      "notice",
      "hook",
    ]);
    // The compaction renders in place. The line carries the figures; the
    // summary rides along as details, folded away rather than inline.
    const boundary = s.items[1] as { text: string; details?: string };
    expect(boundary.text).toBe("Compacted manually (247k to 9k).");
    expect(boundary.details).toContain("continued from a previous conversation");
    // And the pair after it: the start row, settled by the failure that
    // follows it in the fixture, so one row carries both.
    expect((s.items[2] as { text: string }).text).toBe("Compaction failed: Not enough messages to compact.");
    expect(s.items.filter((i): i is ToolItem => i.kind === "tool").map((t) => t.toolUseId)).toEqual([
      "toolu_1",
      "toolu_2",
      "toolu_3",
    ]);
  });

  it("carries the session facts off the first init", () => {
    const s = replay(FIXTURE);
    expect(s.started).toBe(true);
    expect(s.tools).toEqual(["Bash", "Edit"]);
    expect(s.mcpServers.map((m) => m.name)).toEqual(["ctx"]);
    expect(s.plan.length).toBeGreaterThan(0);
    expect(s.contextTokens).not.toBeNull();
  });

  // The commands are the one session fact that is not settled by the init. An
  // ACP agent publishes them afterwards, on a notification of their own, and
  // the fixture carries both: the handshake's list and the update that replaces
  // it. Replaced, not merged - the update is the agent's current list.
  it("takes a later command list over the one the handshake carried", () => {
    const s = replay(FIXTURE);
    expect(s.slashCommands.map((c) => c.name)).toEqual(["plan"]);

    const handshakeOnly = replay(FIXTURE.filter((e) => e.type !== "slashCommands"));
    expect(handshakeOnly.slashCommands.map((c) => c.name)).toEqual(["review"]);
  });

  it("is idempotent under a duplicated replay of every event", () => {
    const once = replay(FIXTURE);
    const twice = replay([...FIXTURE, ...FIXTURE]);
    // The second `sessionEnded`/`sessionError` legitimately add notices; the
    // structural spine (turns, tool cards, their states) must not double.
    expect(Object.keys(twice.toolIndex).sort()).toEqual(Object.keys(once.toolIndex).sort());
    expect(twice.items.filter((i) => i.kind === "tool")).toHaveLength(3);
    expect(twice.activeTurnId).toBeNull();
  });

  it("ignores events belonging to another session", () => {
    const s = replay(FIXTURE, "other");
    expect(s.items).toEqual([]);
    expect(s.started).toBe(false);
  });
});

describe("ordering tolerance", () => {
  it("opens a new bubble for text that resumes after a tool call", () => {
    const s = replay([turnStarted("t1"), text("t1", "a"), started("t1", "x"), text("t1", "b")]);
    expect(kinds(s)).toEqual(["text", "tool", "text"]);
    expect((s.items[0] as { text: string }).text).toBe("a");
    expect((s.items[2] as { text: string }).text).toBe("b");
  });

  it("appends consecutive deltas into one bubble", () => {
    const s = replay([turnStarted("t1"), text("t1", "he"), text("t1", "llo")]);
    expect(kinds(s)).toEqual(["text"]);
    expect((s.items[0] as { text: string }).text).toBe("hello");
  });

  it("accepts a delta whose turnStarted never arrived", () => {
    const s = replay([text("t9", "orphan")]);
    expect(s.activeTurnId).toBe("t9");
    expect(kinds(s)).toEqual(["text"]);
  });

  it("does not reopen a turn that already completed", () => {
    const s = replay([turnStarted("t1"), turnDone("t1", "completed"), text("t1", "late")]);
    expect(s.activeTurnId).toBeNull();
  });

  it("absorbs a repeated turnStarted and a repeated turnCompleted", () => {
    const s = replay([turnStarted("t1"), turnStarted("t1"), turnDone("t1", "completed"), turnDone("t1", "cancelled")]);
    expect(s.turns.t1.completed).toBe(true);
    expect(s.queueHeld).toBe(false);
  });
});

describe("a tool card is materialized by whichever channel arrives first", () => {
  it("makes exactly one card when the prompt beats the assistant frame", () => {
    // The real race: the approval comes off the Unix socket from a forked hook
    // helper, the declaration off the child's stdout on another thread.
    const s = replay([prompt("toolu_9"), started("t1", "toolu_9", "Bash", { command: "rm -rf /" })]);
    expect(s.items.filter((i) => i.kind === "tool")).toHaveLength(1);
    const card = tool(s, "toolu_9");
    expect(card.state).toBe("awaitingApproval");
    expect(card.approval?.requestId).toBe("r1");
    expect(card.name).toBe("Bash");
    expect(card.input).toEqual({ command: "rm -rf /" });
    expect(card.turnId).toBe("t1");
  });

  it("makes exactly one card when the assistant frame beats the prompt", () => {
    const s = replay([started("t1", "toolu_9", "Bash", { command: "ls" }), prompt("toolu_9")]);
    expect(s.items.filter((i) => i.kind === "tool")).toHaveLength(1);
    const card = tool(s, "toolu_9");
    expect(card.state).toBe("awaitingApproval");
    expect(card.input).toEqual({ command: "ls" });
  });

  it("drops a duplicate prompt for the same request", () => {
    const s = replay([prompt("toolu_9"), prompt("toolu_9")]);
    expect(pendingApprovals(s)).toHaveLength(1);
  });

  it("never walks a settled card back to blocked", () => {
    const s = replay([started("t1", "x"), completed("t1", "x"), prompt("x", "late")]);
    expect(tool(s, "x").state).toBe("ok");
    expect(pendingApprovals(s)).toHaveLength(0);
  });

  it("keeps a completion that arrived before its declaration", () => {
    const s = replay([completed("t1", "x", "denied"), started("t1", "x")]);
    expect(tool(s, "x").state).toBe("denied");
    expect(tool(s, "x").name).toBe("Edit");
  });

  it("clears the prompt when it is answered, then takes the real outcome", () => {
    const s = replay([prompt("x"), started("t1", "x")]);
    resolveApproval(s, "x");
    expect(tool(s, "x").state).toBe("running");
    applyEvent(s, completed("t1", "x"));
    expect(tool(s, "x").state).toBe("ok");
  });
});

describe("the neutral facts a collapsed row reads", () => {
  type Started = Extract<ChatEvent, { type: "toolCallStarted" }>;
  const declared = (over: Partial<Started> = {}): ChatEvent => ({
    type: "toolCallStarted",
    sessionId: "s1",
    turnId: "t1",
    toolUseId: "x",
    name: "Grep",
    input: { pattern: "fn main" },
    kind: "search",
    locations: [{ path: "/a.rs", line: 3 }],
    title: null,
    ...over,
  });
  const answered = (summary: ToolSummary | null): ChatEvent => ({
    type: "toolCallCompleted",
    sessionId: "s1",
    turnId: "t1",
    toolUseId: "x",
    status: "ok",
    output: "done",
    files: [],
    durationMs: 12,
    summary,
    outputTruncated: false,
    patch: [],
  });

  it("carries the kind, the locations and the summary onto the card", () => {
    const s = replay([declared(), answered({ type: "paths", count: 7 })]);
    expect(tool(s, "x").toolKind).toBe("search");
    expect(tool(s, "x").locations).toEqual([{ path: "/a.rs", line: 3 }]);
    expect(tool(s, "x").summary).toEqual({ type: "paths", count: 7 });
  });

  // The upsert contract, for the two fields that gained one: `other` and an
  // empty list are what a patch that did not mention the field carries, so
  // neither may wipe what the card already knows.
  it("keeps the kind and the locations a later patch said nothing about", () => {
    const s = replay([declared(), declared({ kind: "other", locations: [], title: "Search for fn main" })]);
    expect(tool(s, "x").toolKind).toBe("search");
    expect(tool(s, "x").locations).toEqual([{ path: "/a.rs", line: 3 }]);
    expect(tool(s, "x").title).toBe("Search for fn main");
  });

  it("leaves a result no summariser recognised with no summary at all", () => {
    const s = replay([declared(), answered(null)]);
    expect(tool(s, "x").summary).toBeNull();
  });
});

describe("status", () => {
  it("reports running before the first init, idle after it", () => {
    const s = initialChat("s1");
    expect(chatStatus(s)).toBe("running");
    applyEvent(s, FIXTURE[0]);
    expect(chatStatus(s)).toBe("idle");
  });

  it("reports executing while a turn runs and idle once it completes", () => {
    const s = replay([FIXTURE[0], turnStarted("t1")]);
    expect(chatStatus(s)).toBe("executing");
    applyEvent(s, turnDone("t1", "completed"));
    expect(chatStatus(s)).toBe("idle");
  });

  it("reports waitingForApproval over executing while a prompt is pending", () => {
    const s = replay([FIXTURE[0], turnStarted("t1"), prompt("x")]);
    expect(chatStatus(s)).toBe("waitingForApproval");
    resolveApproval(s, "x");
    expect(chatStatus(s)).toBe("executing");
  });

  it("reports none once the session ends", () => {
    const s = replay([FIXTURE[0], { type: "sessionEnded", sessionId: "s1", reason: null }]);
    expect(chatStatus(s)).toBe("none");
  });
});

describe("the composer queue", () => {
  function queued(n: number): ChatState {
    const s = replay([FIXTURE[0], turnStarted("t1")]);
    for (let i = 0; i < n; i++) enqueue(s, `m${i}`);
    return s;
  }

  it("holds queued input while a turn runs", () => {
    const s = queued(2);
    expect(pendingFlush(s)).toBeNull();
    expect(s.queue).toHaveLength(2);
  });

  it("flushes in order, one turn at a time, once a turn completes normally", () => {
    const s = queued(3);
    applyEvent(s, turnDone("t1", "completed"));
    const sent: string[] = [];
    for (let turn = 2; turn < 9; turn++) {
      const next = takeForSend(s);
      if (!next) break;
      sent.push(next.text);
      // Taking one message must close the window until that turn is done: the
      // whole backlog going out at once is the failure this guards.
      expect(takeForSend(s)).toBeNull();
      applyEvent(s, turnStarted(`t${turn}`));
      applyEvent(s, turnDone(`t${turn}`, "completed"));
    }
    expect(sent).toEqual(["m0", "m1", "m2"]);
  });

  it("holds the queue for the round trip before the child acknowledges a turn", () => {
    const s = queued(2);
    applyEvent(s, turnDone("t1", "completed"));
    expect(takeForSend(s)?.text).toBe("m0");
    expect(isRunning(s)).toBe(true);
    expect(chatStatus(s)).toBe("executing");
    expect(pendingFlush(s)).toBeNull();
    clearAwaitingTurn(s);
    expect(pendingFlush(s)?.text).toBe("m1");
  });

  it("sends nothing on a cancelled turn and keeps every message actionable", () => {
    // Stop must not flush: an interrupt reports as a completion, and a naive
    // flush would fire exactly the messages the user pressed stop to prevent.
    const s = queued(3);
    applyEvent(s, turnDone("t1", "cancelled"));
    expect(pendingFlush(s)).toBeNull();
    expect(takeForSend(s)).toBeNull();
    expect(s.queueHeld).toBe(true);
    expect(s.queue.map((q) => q.text)).toEqual(["m0", "m1", "m2"]);
  });

  it("holds the queue on an errored turn too", () => {
    const s = queued(1);
    applyEvent(s, turnDone("t1", "errored"));
    expect(pendingFlush(s)).toBeNull();
  });

  it("sends the held queue on an explicit send-now", () => {
    const s = queued(2);
    applyEvent(s, turnDone("t1", "cancelled"));
    releaseQueue(s);
    expect(pendingFlush(s)?.text).toBe("m0");
  });

  it("discards the held queue on an explicit discard", () => {
    const s = queued(2);
    applyEvent(s, turnDone("t1", "cancelled"));
    discardQueue(s);
    expect(s.queue).toEqual([]);
    expect(pendingFlush(s)).toBeNull();
  });

  it("drops one queued message and releases the hold when the last one goes", () => {
    const s = queued(2);
    applyEvent(s, turnDone("t1", "cancelled"));
    removeQueued(s, s.queue[0].id);
    expect(s.queue.map((q) => q.text)).toEqual(["m1"]);
    expect(s.queueHeld).toBe(true);
    removeQueued(s, s.queue[0].id);
    expect(s.queueHeld).toBe(false);
  });

  // The ceiling used to be a tool-call denial the agent's own hook enforced.
  // It is a turn-boundary refusal now, which means the queue is the whole
  // enforcement surface: a flush that went ahead would open exactly the turn the
  // limit exists to prevent.
  it("never flushes a queued message under a spend ceiling", () => {
    const s = queued(2);
    applyEvent(s, turnDone("t1", "completed"));
    s.budgetStopped = true;
    expect(pendingFlush(s)).toBeNull();
    expect(takeForSend(s)).toBeNull();
    // Held, not dropped: raising the limit sends what was typed rather than
    // asking for it again.
    expect(s.queue.map((q) => q.text)).toEqual(["m0", "m1"]);
  });

  // "Send now" is a button, and a ceiling a button can lift is not a ceiling.
  // This is why the stop is read in `pendingFlush` rather than expressed as a
  // queue hold, which `releaseQueue` exists to clear.
  it("does not let send-now walk past a spend ceiling", () => {
    const s = queued(1);
    applyEvent(s, turnDone("t1", "cancelled"));
    s.budgetStopped = true;
    releaseQueue(s);
    expect(pendingFlush(s)).toBeNull();
  });

  // And the way back: nothing is re-sent by hand, so a raised limit does not
  // cost the user the message they already typed.
  it("flushes what was queued once the ceiling is raised", () => {
    const s = queued(1);
    applyEvent(s, turnDone("t1", "completed"));
    s.budgetStopped = true;
    expect(pendingFlush(s)).toBeNull();
    s.budgetStopped = false;
    expect(pendingFlush(s)?.text).toBe("m0");
  });

  it("never flushes into a dead session", () => {
    const s = queued(1);
    applyEvent(s, { type: "sessionEnded", sessionId: "s1", reason: "child exited" });
    expect(pendingFlush(s)).toBeNull();
  });
});

// Phase 2's spike 5 measured a message written mid-turn being consumed before
// the next tool call, 3 trials of 3. So an acknowledged running turn takes input
// directly, and the queue narrows to the one window where there is still no turn
// to steer.
describe("steering a running turn", () => {
  it("is offered only once the child has acknowledged the turn", () => {
    const s = replay([FIXTURE[0]]);
    expect(steerable(s)).toBe(false);

    // Between Enter and `turnStarted` the turn is in flight but has not begun,
    // so there is nothing to steer and the queue is still the right answer.
    pushUserTurn(s, [{ type: "text", text: "do the thing" }]);
    expect(isRunning(s)).toBe(true);
    expect(steerable(s)).toBe(false);

    applyEvent(s, turnStarted("t1"));
    expect(steerable(s)).toBe(true);
  });

  it("is not offered once the turn or the session is over", () => {
    const s = replay([FIXTURE[0], turnStarted("t1")]);
    applyEvent(s, turnDone("t1", "completed"));
    expect(steerable(s)).toBe(false);

    applyEvent(s, turnStarted("t2"));
    applyEvent(s, { type: "sessionEnded", sessionId: "s1", reason: "child exited" });
    expect(steerable(s)).toBe(false);
  });

  it("records the steer without claiming a second turn is in flight", () => {
    const s = replay([FIXTURE[0], turnStarted("t1")]);
    pushSteer(s, [{ type: "text", text: "actually, stop reading and summarise" }]);

    const last = s.items[s.items.length - 1];
    expect(last.kind).toBe("user");
    expect((last as UserItem).steer).toBe(true);
    // The turn it interrupted is still the running one. `awaitingTurn` would
    // make the composer wait for a `turnStarted` that is never coming, and a
    // changed `activeTurnId` would split one turn's output across two headers.
    expect(s.awaitingTurn).toBe(false);
    expect(s.activeTurnId).toBe("t1");
    expect(steerable(s)).toBe(true);
  });

  it("marks an ordinary turn as not a steer", () => {
    const s = replay([FIXTURE[0]]);
    pushUserTurn(s, [{ type: "text", text: "do the thing" }]);
    expect((s.items[s.items.length - 1] as UserItem).steer).toBe(false);
    expect(s.awaitingTurn).toBe(true);
  });

  // Task 4's contract, asserted through the real gate rather than by reading
  // the probe's return value: what matters is that a blocked session is refused
  // with the reason the PTY route already gives, and that nothing is written.
  it("is refused, with the existing reason, while the session awaits a permission answer", async () => {
    const s = replay([FIXTURE[0], turnStarted("t1"), started("t1", "toolu_1"), prompt("toolu_1")]);
    expect(steerable(s)).toBe(true);
    expect(steerProbe(s)).toBe("blocked");

    const written: string[] = [];
    const refused = await sendWithProbeGate("stop, just summarise", {
      probe: async () => steerProbe(s),
      write: async (t) => void written.push(t),
      now: () => 0,
      sleep: async () => {},
    });
    expect(refused).toEqual({ kind: "blocked" });
    expect(written).toEqual([]);
    // The same string the terminal route refuses with, so one rule does not
    // read as two.
    expect(BLOCKED_REASON).toContain("waiting for permission");

    // Answering the prompt is what unblocks it, so the refusal is a "not yet"
    // rather than a dead end.
    resolveApproval(s, "toolu_1");
    expect(steerProbe(s)).toBe("ready");
    expect(await sendWithProbeGate("stop, just summarise", {
      probe: async () => steerProbe(s),
      write: async (t) => void written.push(t),
      now: () => 0,
      sleep: async () => {},
    })).toEqual({ kind: "sent" });
    expect(written).toEqual(["stop, just summarise"]);
  });

  it("replays a historical user message as an ordinary one, never a steer", () => {
    // The wire frame carries no such distinction, so guessing at one would put a
    // "Steer" label on a message nothing recorded as one.
    const s = replay([
      FIXTURE[0],
      { type: "userMessage", sessionId: "s1", turnId: "hist-turn-1", blocks: [{ type: "text", text: "from the transcript" }] },
    ]);
    expect((s.items[s.items.length - 1] as UserItem).steer).toBe(false);
  });
});

describe("the render window", () => {
  it("renders only the tail and offers to load earlier", () => {
    const s = initialChat("s1");
    for (let i = 0; i < 2000; i++) {
      pushUserTurn(s, [{ type: "text", text: `m${i}` }]);
    }
    expect(s.items).toHaveLength(2000);
    expect(windowed(s.items, 60)).toHaveLength(60);
    expect(hasEarlier(s.items, 60)).toBe(true);
    expect(hasEarlier(s.items, 2000)).toBe(false);
  });

  it("keeps the tail's order and identity", () => {
    const items = [1, 2, 3, 4].map((n) => ({ kind: "notice", id: `n${n}`, text: `${n}`, level: "info" }) as ChatItem);
    expect(windowed(items, 2).map((i) => i.id)).toEqual(["n3", "n4"]);
    expect(windowed(items, 99)).toEqual(items);
  });

  it("folds a 2000-turn session well inside the first-paint budget", () => {
    // Not a paint measurement (there is no DOM in this suite): the reducer plus
    // the window is the only work that scales with history, and the render
    // itself is bounded to WINDOW_STEP items by construction.
    const evs: ChatEvent[] = [];
    for (let i = 0; i < 2000; i++) {
      evs.push(turnStarted(`t${i}`), text(`t${i}`, "hello there"), turnDone(`t${i}`, "completed"));
    }
    const at = performance.now();
    const s = replay(evs);
    windowed(s.items, 60);
    expect(performance.now() - at).toBeLessThan(500);
    expect(s.items).toHaveLength(2000);
  });
});

// A mode switch is applied by the CLI at the next turn boundary, so between the
// click and that boundary the control is describing the future. Showing it as
// current would be wrong for exactly the turn the user is worried about.
describe("the permission mode control", () => {
  const turnIn = (turnId: string, mode: "default" | "plan" | "acceptEdits" | "bypassPermissions"): ChatEvent => ({
    type: "turnStarted",
    sessionId: "s1",
    turnId,
    model: "m",
    permissionMode: mode,
  });

  it("shows a pick immediately and flags it as not yet in force", () => {
    const s = replay([turnIn("t1", "default")]);
    expect(shownMode(s)).toBe("default");
    expect(modePending(s)).toBe(false);

    selectMode(s, "plan");
    expect(shownMode(s)).toBe("plan");
    expect(modePending(s)).toBe(true);
    // The session itself has not moved: only the child's own re-declaration
    // says a switch landed.
    expect(s.permissionMode).toBe("default");
  });

  it("settles once the next turn declares the mode it was given", () => {
    const s = replay([turnIn("t1", "default")]);
    selectMode(s, "plan");
    applyEvent(s, turnIn("t2", "plan"));
    expect(modePending(s)).toBe(false);
    expect(shownMode(s)).toBe("plan");
  });

  // The CLI is free to ignore a switch. A control that cleared its pending mark
  // on the click alone would then show a mode the session is not in, forever.
  it("stays pending when the next turn comes back in the old mode", () => {
    const s = replay([turnIn("t1", "default")]);
    selectMode(s, "bypassPermissions");
    applyEvent(s, turnIn("t2", "default"));
    expect(modePending(s)).toBe(true);
    expect(shownMode(s)).toBe("bypassPermissions");
  });

  it("treats re-picking the mode in force as cancelling the pending switch", () => {
    const s = replay([turnIn("t1", "default")]);
    selectMode(s, "plan");
    selectMode(s, "default");
    expect(modePending(s)).toBe(false);
    expect(shownMode(s)).toBe("default");
  });

  // The fallback is the caller's to supply, because it is the *adapter's*
  // declared default. Returning the literal "default" here, as this once did,
  // named a mode that exists only in Claude's vocabulary: on a agent whose
  // modes are `auto_edit|yolo` the pill would show a value absent from its own
  // menu.
  it("falls back to the adapter's declared default before the session has said anything", () => {
    const s = initialChat("s1");
    expect(shownMode(s, "auto_edit")).toBe("auto_edit");
    expect(modePending(s)).toBe(false);
  });

  it("knows no mode at all when nothing has been said and no default is declared", () => {
    expect(shownMode(initialChat("s1"))).toBeNull();
  });
});

describe("filesWritten", () => {
  // What the gutter and the Changes panel refresh on, ahead of the watcher's
  // debounce. Reading it off the events the transport already sends is what
  // keeps it from becoming a second, drifting source of "what changed".
  it("reports a tool call's write targets", () => {
    expect(filesWritten(completed("t1", "toolu_1"))).toEqual(["/a"]);
  });

  it("reports a fileEdit's single path", () => {
    expect(
      filesWritten({
        type: "fileEdit",
        sessionId: "s1",
        turnId: "t1",
        toolUseId: "toolu_1",
        path: "/a/b.ts",
        kind: "modified",
        beforeBlob: null,
      }),
    ).toEqual(["/a/b.ts"]);
  });

  it("reports nothing for the events that wrote nothing", () => {
    expect(filesWritten(prompt("toolu_1"))).toEqual([]);
    expect(filesWritten(started("t1", "toolu_1", "Read", { file_path: "/a" }))).toEqual([]);
  });
});

describe("reasoningFor", () => {
  // How the diff view answers "why is this line here" without storing a second
  // copy of the reasoning: the transcript already holds it, in order.
  const tool = (id: string): ChatItem => ({
    kind: "tool",
    id: `card-${id}`,
    toolUseId: id,
    turnId: "t1",
    name: "Edit",
    title: null,
    toolKind: "edit",
    locations: [],
    input: {},
    state: "ok",
    approval: null,
    output: null,
    outputTruncated: false,
    summary: null,
    patch: [],
    files: [],
    durationMs: null,
    edits: [],
  });
  const text = (id: string, body: string): ChatItem => ({ kind: "text", id, turnId: "t1", text: body });

  it("takes the model's last word before the call", () => {
    const items = [text("x1", "first thought"), tool("toolu_1"), text("x2", "second thought"), tool("toolu_2")];
    expect(reasoningFor(items, "toolu_1")).toBe("first thought");
    // Not "first thought": a turn with six calls has six justifications, and
    // crediting all of them to every hunk would be worse than showing none.
    expect(reasoningFor(items, "toolu_2")).toBe("second thought");
  });

  it("stops at the user's turn rather than reaching into the previous one", () => {
    const items: ChatItem[] = [
      text("x1", "last turn's reasoning"),
      { kind: "user", id: "u2", blocks: [{ type: "text", text: "now do this" }], steer: false },
      tool("toolu_9"),
    ];
    expect(reasoningFor(items, "toolu_9")).toBeNull();
  });

  it("skips empty text rather than reporting a blank explanation", () => {
    const items = [text("x1", "the real reason"), text("x2", "   "), tool("toolu_1")];
    expect(reasoningFor(items, "toolu_1")).toBe("the real reason");
  });

  it("is null for a call the transcript does not have", () => {
    expect(reasoningFor([], "toolu_missing")).toBeNull();
  });
});

// The switch that cannot be confirmed the obvious way.
//
// `system/init` reports `resolvedModel` and never the `value` that `--model`
// takes, and several values resolve to one id. So every assertion here goes
// through the resolved id; comparing the picked value against init's model
// would report every successful switch as a failure.
describe("model and effort switching", () => {
  const HAIKU = { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" };
  const SONNET = { value: "sonnet", resolvedModel: "claude-sonnet-5" };

  // The real pair: the first `system/init` opens the session *and* starts turn
  // one, so a session with no live turn is a state the transport never emits.
  function live(): ChatState {
    const s = initialChat("s1");
    applyEvent(s, sessionStarted());
    applyEvent(s, turnStarted("turn-1", "claude-sonnet-5"));
    return s;
  }

  it("shows a pick at once but marks it pending until a turn confirms it", () => {
    const s = live();
    selectModel(s, HAIKU);
    expect(shownModelValue(s)).toBe("haiku");
    expect(modelPending(s)).toBe(true);
    // Still the old session model: the CLI cannot switch mid-turn.
    expect(s.model).toBe("claude-sonnet-5");

    applyEvent(s, turnStarted("t2", "claude-haiku-4-5-20251001"));
    expect(modelPending(s)).toBe(false);
    expect(s.modelValue).toBe("haiku");
    expect(s.model).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps the pick pending while the session reports a different model", () => {
    const s = live();
    selectModel(s, HAIKU);
    applyEvent(s, turnStarted("t2", "claude-sonnet-5"));
    expect(modelPending(s)).toBe(true);
    expect(s.modelValue).toBeNull();
  });

  it("confirms two values that share one resolved id, because nothing else can", () => {
    // `default` and `sonnet` both resolve to claude-sonnet-5, so init cannot
    // distinguish them. The boundary is treated as confirmation, which is the
    // least wrong answer available - the alternative is a marker that never
    // clears.
    const s = live();
    selectModel(s, SONNET);
    applyEvent(s, turnStarted("t2", "claude-sonnet-5"));
    expect(modelPending(s)).toBe(false);
    expect(s.modelValue).toBe("sonnet");
  });

  it("treats re-picking the model in force as cancelling a pending switch", () => {
    const s = live();
    selectModel(s, SONNET);
    applyEvent(s, turnStarted("t2", "claude-sonnet-5"));
    selectModel(s, HAIKU);
    expect(modelPending(s)).toBe(true);
    selectModel(s, SONNET);
    expect(modelPending(s)).toBe(false);
    expect(shownModelValue(s)).toBe("sonnet");
  });

  it("applies effort at the next turn boundary, since nothing reports it back", () => {
    const s = live();
    selectEffort(s, "xhigh");
    expect(shownEffort(s)).toBe("xhigh");
    expect(effortPending(s)).toBe(true);
    // A delta of the turn already running is not a boundary.
    applyEvent(s, text("turn-1", "still going"));
    expect(effortPending(s)).toBe(true);

    applyEvent(s, turnStarted("t2"));
    expect(effortPending(s)).toBe(false);
    expect(s.effort).toBe("xhigh");
  });

  it("reverts a pick whose request never left, so the control stops promising", () => {
    const s = live();
    selectModel(s, HAIKU);
    revertModelPick(s, "haiku");
    expect(modelPending(s)).toBe(false);
    expect(shownModelValue(s)).toBeNull();

    selectEffort(s, "max");
    revertEffortPick(s, "max");
    expect(effortPending(s)).toBe(false);
  });

  it("does not let a late rejection drop a newer pick", () => {
    const s = live();
    selectModel(s, HAIKU);
    selectModel(s, SONNET);
    // The rejection of the first pick arrives after the second was made.
    revertModelPick(s, "haiku");
    expect(shownModelValue(s)).toBe("sonnet");
  });

  it("carries the catalogue and fast-mode state off the session start", () => {
    const s = initialChat("s1");
    applyEvent(
      s,
      sessionStarted({
        models: [
          {
            value: "haiku",
            resolvedModel: "claude-haiku-4-5-20251001",
            displayName: "Haiku",
            description: "Fastest",
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAutoMode: false,
            supportsFastMode: false,
            supportsAdaptiveThinking: false,
          },
        ],
        fastModeState: "off",
        fastModeDisabledReason: "sdk_opt_in_required",
      }),
    );
    expect(s.models).toHaveLength(1);
    expect(s.fastModeState).toBe("off");
    expect(s.fastModeDisabledReason).toBe("sdk_opt_in_required");
  });
});

// Replayed history folds through the same reducer as a live stream, which is
// the point: one renderer, so the path used less often cannot rot separately.
describe("backfilled history", () => {
  const userMsg = (turnId: string, text: string): ChatEvent => ({
    type: "userMessage",
    sessionId: "s1",
    turnId,
    blocks: [{ type: "text", text }],
  });

  it("renders a long conversation in order with its tool calls intact", () => {
    // 50 prior turns, each a question, an answer and a tool call.
    const events: ChatEvent[] = [];
    for (let i = 1; i <= 50; i++) {
      const t = `hist-turn-${i}`;
      events.push(userMsg(t, `question ${i}`));
      events.push(text(t, `answer ${i}`));
      events.push(started(t, `toolu_${i}`, "Read"));
      events.push(completed(t, `toolu_${i}`));
    }
    const s = replay(events);

    expect(s.items).toHaveLength(150);
    expect(kinds(s).slice(0, 6)).toEqual(["user", "text", "tool", "user", "text", "tool"]);
    // In order, not merely present.
    expect((s.items[0] as { blocks: { text: string }[] }).blocks[0].text).toBe("question 1");
    expect((s.items[147] as { blocks: { text: string }[] }).blocks[0].text).toBe("question 50");
    // Each call kept its own card and reached a settled state.
    expect(Object.keys(s.toolIndex)).toHaveLength(50);
    expect(tool(s, "toolu_50").state).toBe("ok");
  });

  it("does not leave a reopened tab reading as busy", () => {
    // `pushUserTurn` sets awaitingTurn so the composer locks for the round trip.
    // Replayed history is finished, so it must not.
    const s = replay([userMsg("hist-turn-1", "an old question")]);
    expect(s.awaitingTurn).toBe(false);
    expect(isRunning(s)).toBe(false);
  });

  it("keeps replayed turns separate from the live ones that follow", () => {
    const s = replay([userMsg("hist-turn-1", "old"), text("hist-turn-1", "old answer"), turnStarted("turn-1")]);
    // The live turn is the active one; the replayed turn never reopens.
    expect(s.activeTurnId).toBe("turn-1");
    expect(s.turns["hist-turn-1"]).toBeDefined();
  });

  it("ignores history addressed to another session", () => {
    const s = initialChat("other");
    applyEvent(s, userMsg("hist-turn-1", "not yours"));
    expect(s.items).toEqual([]);
  });
});

describe("hook rows", () => {
  const hook = (
    hookId: string,
    phase: "started" | "finished",
    swayOwned: boolean,
    over: Record<string, unknown> = {},
  ): ChatEvent =>
    ({
      type: "hookFired",
      sessionId: "s1",
      hookId,
      // The measured name: the tool, not the matcher. Sway's hook and the
      // user's hook on the same tool are indistinguishable by this field.
      name: "PreToolUse:Bash",
      event: "PreToolUse",
      phase,
      swayOwned,
      outcome: phase === "finished" ? "success" : null,
      exitCode: phase === "finished" ? 0 : null,
      output: null,
      stderr: null,
      ...over,
    }) as ChatEvent;

  const hookRows = (s: ChatState, show: boolean) => visibleItems(s.items, show).filter((i) => i.kind === "hook");

  it("adds no visible rows for a 60-tool-call turn, and reveals all 120 when toggled", () => {
    // The plan's headline figure, measured when Sway's hook ran on every tool
    // call and contributed two frames each time. It is narrowed to the write
    // tools now, so a turn like this one produces fewer - but the user's own
    // hooks are not, and the collapse exists for the volume either way.
    const s = initialChat("s1");
    for (let i = 0; i < 60; i++) {
      applyEvent(s, hook(`sway-${i}`, "started", false));
      applyEvent(s, hook(`sway-${i}`, "finished", true));
    }
    expect(hookRows(s, false)).toHaveLength(0);
    expect(hookRows(s, true)).toHaveLength(120);
  });

  it("settles the started frame retroactively so a pair never splits", () => {
    // Only the response carries Sway's marker, so the started frame arrives
    // unattributed. It is quiet anyway (nothing has failed yet), and the
    // back-propagation is what keeps it folded under the *reveal-all-but-Sway*
    // reading a future view might take; the marker must land either way.
    const s = initialChat("s1");
    applyEvent(s, hook("sway-1", "started", false));
    applyEvent(s, hook("sway-1", "finished", true));
    expect(s.items.filter((i) => i.kind === "hook" && i.swayOwned)).toHaveLength(2);
    expect(hookRows(s, false)).toHaveLength(0);
  });

  it("surfaces a failed user hook, with its outcome and stderr, and nothing else", () => {
    const s = initialChat("s1");
    applyEvent(s, hook("user-1", "started", false, { name: "SessionStart:startup", event: "SessionStart" }));
    applyEvent(
      s,
      hook("user-1", "finished", false, {
        name: "SessionStart:startup",
        event: "SessionStart",
        outcome: "blocking_error",
        exitCode: 2,
        stderr: "a warning",
      }),
    );
    // Only the failure row: the started frame was not news, the failure is.
    const rows = hookRows(s, false);
    expect(rows).toHaveLength(1);
    const done = rows[0] as { name: string; outcome: string; exitCode: number; stderr: string };
    expect(done.name).toBe("SessionStart:startup");
    expect(done.outcome).toBe("blocking_error");
    expect(done.exitCode).toBe(2);
    expect(done.stderr).toBe("a warning");
  });

  it("folds a user hook that ran as configured; the toggle still reveals the lot", () => {
    // A hook that succeeded is an answer to a question nobody asked: four
    // SessionStart rows on every resumed tab was the measured complaint.
    const s = initialChat("s1");
    applyEvent(s, hook("sway-1", "started", false));
    applyEvent(s, hook("user-1", "started", false));
    applyEvent(s, hook("sway-1", "finished", true));
    applyEvent(s, hook("user-1", "finished", false));
    expect(hookRows(s, false)).toHaveLength(0);
    expect(hookRows(s, true)).toHaveLength(4);
  });

  it("never drops a folded row from the state, so the toggle works mid-session", () => {
    const s = initialChat("s1");
    applyEvent(s, hook("sway-1", "started", false));
    applyEvent(s, hook("sway-1", "finished", true));
    // Folded from the view, still present in the transcript.
    expect(s.items.filter((i) => i.kind === "hook")).toHaveLength(2);
  });
});

// `system/init` does not arrive until the first turn starts, so the answered
// handshake is the only liveness signal a chat nobody has typed in has. This
// is what keeps a fresh chat from reading "Connecting" until the first send.
describe("the answered handshake (sessionReady)", () => {
  const MODEL = {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "Balanced",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    supportsAutoMode: true,
    supportsFastMode: false,
    supportsAdaptiveThinking: false,
  };
  const ACCOUNT = { subscriptionType: "Claude Pro", organization: "Acme", apiProvider: "firstParty" };
  const ready = (over: Partial<Extract<ChatEvent, { type: "sessionReady" }>> = {}): ChatEvent => ({
    type: "sessionReady",
    sessionId: "s1",
    slashCommands: [{ name: "review", description: "Multi-lens code review", argumentHint: null, aliases: [] }],
    models: [MODEL],
    modes: [],
    account: ACCOUNT,
    capabilities: null,
    ...over,
  });

  it("reads as connected and idle before any turn has run", () => {
    const s = initialChat("s1");
    expect(connectionHealth(s)).toBe("connecting");
    expect(chatStatus(s)).toBe("running");
    applyEvent(s, ready());
    expect(connectionHealth(s)).toBe("connected");
    expect(chatStatus(s)).toBe("idle");
    // Weaker than started: nothing has named a model or a mode yet.
    expect(s.started).toBe(false);
  });

  it("delivers the catalogues before the first message", () => {
    const s = initialChat("s1");
    applyEvent(s, ready());
    expect(s.models.map((m) => m.value)).toEqual(["sonnet"]);
    expect(s.slashCommands.map((c) => c.name)).toEqual(["review"]);
  });

  it("lets a bare acknowledgement pass without erasing delivered catalogues", () => {
    const s = initialChat("s1");
    applyEvent(s, ready());
    applyEvent(s, ready({ slashCommands: [], models: [] }));
    expect(s.models).toHaveLength(1);
    expect(s.slashCommands).toHaveLength(1);
  });

  it("hands over to sessionStarted unchanged", () => {
    const s = initialChat("s1");
    applyEvent(s, ready());
    applyEvent(s, sessionStarted({ models: [MODEL] }));
    expect(s.started).toBe(true);
    expect(connectionHealth(s)).toBe("connected");
  });

  // Claude opens its session *with* the first turn, so the answered handshake is
  // as ready as it can get before one: waiting for `started` would wait for the
  // very turn being asked about.
  it("counts an answered handshake as able to take a turn on claude", () => {
    const s = initialChat("s1");
    expect(sendCapable(s, "claude_stream_json")).toBe(false);
    applyEvent(s, ready());
    expect(sendCapable(s, "claude_stream_json")).toBe(true);
  });

  // An ACP agent answers the handshake before it has opened a session, and
  // refuses a turn sent into that window. The status strip calls it connected
  // there, which is right for a strip and wrong for a send - so this is a
  // separate question with a separate answer.
  it("waits for the opened session on acp, where ready is not enough", () => {
    const s = initialChat("s1");
    applyEvent(s, ready());
    expect(connectionHealth(s)).toBe("connected");
    expect(sendCapable(s, "acp")).toBe(false);
    applyEvent(s, sessionStarted({ models: [MODEL] }));
    expect(sendCapable(s, "acp")).toBe(true);
  });

  // An adapter with no chat block at all reaches this the same way a claude one
  // does; guessing the slower rule for it would hold a first message on a
  // session that was ready for it.
  it("treats an unstated transport as the handshake rule", () => {
    const s = initialChat("s1");
    applyEvent(s, ready());
    expect(sendCapable(s, undefined)).toBe(true);
  });

  it("folds the account in and reads it back", () => {
    const s = initialChat("s1");
    expect(s.account).toBeNull();
    applyEvent(s, ready());
    expect(s.account).toEqual(ACCOUNT);
  });

  // The handshake is the account's only source, and `sessionStarted` re-fires
  // every turn, so an unguarded assignment would blank it on turn two.
  it("keeps the account when a later frame carries none", () => {
    const s = initialChat("s1");
    applyEvent(s, ready());
    applyEvent(s, sessionStarted());
    expect(s.account).toEqual(ACCOUNT);
  });

  it("is cleared by a reconnect, whose new child has answered nothing yet", () => {
    const s = initialChat("s1");
    applyEvent(s, ready());
    beginReconnect(s);
    expect(connectionHealth(s)).toBe("connecting");
    expect(chatStatus(s)).toBe("running");
  });
});

describe("the figures the status strip reads live", () => {
  // The strip used to take all of these from a transcript re-scan triggered by
  // the same turnCompleted the store folds, so it rendered the previous turn's
  // numbers. These come off the items instead, which have no such lag.
  it("counts prompts and tool calls off the store, replayed history included", () => {
    const s = replay(FIXTURE);
    expect(promptsSent(s)).toBe(s.items.filter((it) => it.kind === "user").length);
    expect(toolCallsSeen(s)).toBe(s.items.filter((it) => it.kind === "tool").length);
    expect(promptsSent(s)).toBeGreaterThan(0);
  });

  it("counts a steer as a prompt, the way the transcript records it", () => {
    const s = initialChat("s1");
    pushUserTurn(s, [{ type: "text", text: "one" }]);
    pushSteer(s, [{ type: "text", text: "two" }]);
    expect(promptsSent(s)).toBe(2);
  });

  // A tool call is announced twice on two unsynchronised channels; the card is
  // keyed by toolUseId, so the count must not double.
  it("counts a tool call once even though two channels announce it", () => {
    const s = initialChat("s1");
    applyEvent(s, started("t1", "call-1"));
    applyEvent(s, prompt("call-1", "req-1"));
    expect(toolCallsSeen(s)).toBe(1);
  });

  it("counts nothing for a session with no turns", () => {
    const s = initialChat("s1");
    expect(promptsSent(s)).toBe(0);
    expect(toolCallsSeen(s)).toBe(0);
  });
});

describe("compactions", () => {
  const compacted = (pre: number | null, post: number | null): ChatEvent => ({
    type: "compacted",
    sessionId: "s1",
    turnId: "t1",
    trigger: "auto",
    preTokens: pre,
    postTokens: post,
    summary: null,
  });

  it("counts each one and totals what they reclaimed", () => {
    const s = initialChat("s1");
    expect(s.compactions).toBe(0);
    applyEvent(s, compacted(180_000, 40_000));
    applyEvent(s, compacted(190_000, 50_000));
    expect(s.compactions).toBe(2);
    expect(s.compactionReclaimed).toBe(280_000);
  });

  // Unknown is not zero, and the half-reported case is what proves it: treating
  // a missing `postTokens` as 0 would claim the compaction reclaimed the entire
  // context. It still counts as a compaction, because it happened.
  it("counts a half-reported compaction without guessing what it reclaimed", () => {
    const s = initialChat("s1");
    applyEvent(s, compacted(180_000, null));
    applyEvent(s, compacted(null, null));
    expect(s.compactions).toBe(2);
    expect(s.compactionReclaimed).toBe(0);
  });

  // The agent has reported a post larger than the pre; that is not a negative
  // reclaim, it is a figure to ignore rather than to subtract from the total.
  it("never subtracts from the total", () => {
    const s = initialChat("s1");
    applyEvent(s, compacted(40_000, 90_000));
    expect(s.compactionReclaimed).toBe(0);
  });
});

describe("the context window the session reports", () => {
  const withUsage = (models: Record<string, unknown>): ChatEvent => ({
    ...(turnDone("t1", "completed") as Extract<ChatEvent, { type: "turnCompleted" }>),
    extra: { modelUsage: models },
  });

  it("folds a completed turn's reported windows into the store", () => {
    const s = initialChat("s1");
    expect(s.contextWindows).toEqual({});
    applyEvent(s, withUsage({ "claude-sonnet-5": { contextWindow: 1_000_000, canonicalModel: "claude-sonnet-5" } }));
    expect(s.contextWindows["claude-sonnet-5"]).toBe(1_000_000);
  });

  // A turn reports only the models it touched, so a straight assignment would
  // drop the model that ran the previous turn and take its window with it.
  it("keeps a window a later turn did not mention", () => {
    const s = initialChat("s1");
    applyEvent(s, withUsage({ "claude-opus-5": { contextWindow: 1_000_000 } }));
    applyEvent(s, {
      ...(turnDone("t2", "completed") as Extract<ChatEvent, { type: "turnCompleted" }>),
      extra: { modelUsage: { "claude-haiku-4-5": { contextWindow: 200000 } } },
    });
    expect(s.contextWindows["claude-opus-5"]).toBe(1_000_000);
    expect(s.contextWindows["claude-haiku-4-5"]).toBe(200000);
  });
});

describe("a session that never handshook", () => {
  // The `initialize` response is the account's only source, so a session that
  // skipped it knows nothing rather than knowing a free tier.
  it("has no account at all", () => {
    const s = initialChat("s1");
    applyEvent(s, sessionStarted());
    expect(s.account).toBeNull();
  });
});

// The transcript on disk records no turn boundaries, so a replay's turn-scoped
// events register their `hist-turn-*` as live and nothing ever completes it.
// Settling is what keeps a reopened tab from reading "working" about turns
// that finished before the tab existed.
describe("settleBackfill", () => {
  it("puts a replayed session at rest", () => {
    const s = initialChat("s1");
    applyEvent(s, { type: "userMessage", sessionId: "s1", turnId: "hist-turn-1", blocks: [{ type: "text", text: "hi" }] });
    applyEvent(s, text("hist-turn-1", "finished answer"));
    expect(isRunning(s)).toBe(true);
    settleBackfill(s);
    expect(isRunning(s)).toBe(false);
    expect(chatStatus(s)).toBe("running"); // still pre-handshake: not started
  });

  it("keeps settled turns closed against late deltas, while live turns still open", () => {
    const s = initialChat("s1");
    applyEvent(s, text("hist-turn-1", "old"));
    settleBackfill(s);
    // A stray delta for a settled turn is history, not a resurrected spinner.
    applyEvent(s, text("hist-turn-1", " tail"));
    expect(isRunning(s)).toBe(false);
    // A genuinely live turn re-opens through its own id space.
    applyEvent(s, turnStarted("turn-1"));
    expect(isRunning(s)).toBe(true);
  });
});

// An ACP agent has no transcript file, so `session/load` hands the whole
// conversation back as ordinary live notifications. Read as live they open a
// turn nothing closes, which is the "Working 36s" a reopened codex chat sat at
// with nothing running.
describe("the replay window for history that arrives live", () => {
  const started = sessionStarted();

  it("folds a replayed frame as history while the session is still opening", () => {
    expect(replayFold(text("turn-0", "an old answer"), true)).toEqual({ as: "history", replaying: true });
  });

  it("closes the window on the event that says the session is open", () => {
    expect(replayFold(started, true)).toEqual({ as: "settle", replaying: false });
  });

  it("leaves an ordinary session alone", () => {
    expect(replayFold(text("turn-1", "live"), false)).toEqual({ as: "live", replaying: false });
    expect(replayFold(started, false)).toEqual({ as: "live", replaying: false });
  });

  // Otherwise the frame saying the session died is folded as history and the
  // message being held for it is never handed back.
  it("ends the window on a session that dies while opening", () => {
    const fatal: ChatEvent = { type: "sessionError", sessionId: "s1", message: "gone", fatal: true };
    expect(replayFold(fatal, true)).toEqual({ as: "live", replaying: false });
  });

  it("keeps the window open through a non-fatal error, which load failure is", () => {
    const soft: ChatEvent = { type: "sessionError", sessionId: "s1", message: "starts empty", fatal: false };
    expect(replayFold(soft, true)).toEqual({ as: "history", replaying: true });
  });

  // The whole point, end to end: the replay opens a turn, and the event that
  // says the session is open is what puts it back to rest.
  it("leaves a replayed conversation at rest rather than working", () => {
    const s = initialChat("s1");
    let replaying = true;
    for (const ev of [text("turn-0", "an answer from yesterday"), started]) {
      const fold = replayFold(ev, replaying);
      replaying = fold.replaying;
      applyEvent(s, ev);
      if (fold.as === "settle") settleBackfill(s);
    }
    expect(isRunning(s)).toBe(false);
  });
});

describe("a question the agent asked", () => {
  const FORM = {
    questions: [
      {
        question: "Which answer channel?",
        header: "Channel",
        multiSelect: false,
        options: [
          { label: "In protocol", description: "Answer what the agent asked.", preview: "behavior: deny" },
          { label: "A dedicated hook", description: "Intercept the call first.", preview: null },
        ],
      },
      {
        question: "Which should I address?",
        header: "Scope",
        multiSelect: true,
        options: [
          { label: "One", description: "", preview: null },
          { label: "Two", description: "", preview: null },
        ],
      },
    ],
  };

  const asked = (toolUseId = "toolu_q", requestId = "req-q", agentId: string | null = null): ChatEvent => ({
    type: "questionRequest",
    sessionId: "s1",
    toolUseId,
    requestId,
    agentId,
    questions: FORM.questions,
  });
  const startedQuestion = (toolUseId = "toolu_q", turnId = "turn-1"): ChatEvent => ({
    type: "toolCallStarted",
    sessionId: "s1",
    turnId,
    toolUseId,
    name: "AskUserQuestion",
    input: FORM,
    // `other` rather than a nearest fit, which is what the Claude mapper really
    // sends for this tool: a question form is not one of ACP's kinds.
    kind: "other",
    locations: [],
    title: null,
  });
  const completedQuestion = (toolUseId = "toolu_q", output: string, turnId = "turn-1"): ChatEvent => ({
    type: "toolCallCompleted",
    sessionId: "s1",
    turnId,
    toolUseId,
    status: "error",
    output,
    files: [],
    durationMs: 3,
    summary: null,
    outputTruncated: false,
    patch: [],
  });
  const question = (s: ChatState): QuestionItem =>
    s.items.find((i): i is QuestionItem => i.kind === "question")!;

  const ANSWER =
    'Your questions have been answered: "Which answer channel?"="In protocol" selected preview:\nbehavior: deny. ' +
    "You can now continue with these answers in mind.";

  it("folds a questionRequest into one question item", () => {
    const s = initialChat("s1");
    applyEvent(s, turnStarted("turn-1"));
    applyEvent(s, asked());
    expect(kinds(s)).toEqual(["question"]);
    const q = question(s);
    expect(q.requestId).toBe("req-q");
    expect(q.questions.map((x) => x.question)).toEqual(["Which answer channel?", "Which should I address?"]);
    expect(answerable(q)).toBe(true);
  });

  it("makes no tool card for the call, at either end", () => {
    const s = initialChat("s1");
    applyEvent(s, turnStarted("turn-1"));
    applyEvent(s, startedQuestion());
    applyEvent(s, asked());
    applyEvent(s, completedQuestion("toolu_q", ANSWER));
    // The whole point of the suppression: `ensureTool` creates on miss, so a
    // completion alone would resurrect the card the declaration refused to
    // make, carrying the answer string as a denied call.
    expect(kinds(s)).toEqual(["question"]);
    expect(s.toolIndex["toolu_q"]).toBeUndefined();
    const q = question(s);
    expect(q.result).toBe(ANSWER);
    expect(answerable(q)).toBe(false);
  });

  it("takes the form from whichever frame lands first, and does not let the other overwrite it", () => {
    // The control request and the assistant frame race on the wire, so both
    // orders have to end in the same place.
    for (const order of [[startedQuestion(), asked()], [asked(), startedQuestion()]]) {
      const s = initialChat("s1");
      applyEvent(s, turnStarted("turn-1"));
      for (const e of order) applyEvent(s, e);
      expect(kinds(s)).toEqual(["question"]);
      expect(question(s).questions).toHaveLength(2);
      expect(question(s).requestId).toBe("req-q");
      expect(question(s).turnId).toBe("turn-1");
    }
  });

  it("rebuilds a replayed question from the tool call alone, read only", () => {
    // What `history.rs` actually emits: no questionRequest at all, so the form
    // comes from the call's own input and the answer from its result.
    const s = initialChat("s1");
    applyEvent(s, startedQuestion());
    applyEvent(s, completedQuestion("toolu_q", ANSWER));
    const q = question(s);
    expect(q.questions.map((x) => x.question)).toEqual(["Which answer channel?", "Which should I address?"]);
    expect(q.result).toBe(ANSWER);
    // Null `requestId` is what makes it read only, rather than a second flag
    // that could disagree with it.
    expect(q.requestId).toBeNull();
    expect(answerable(q)).toBe(false);
  });

  it("attributes a subagent's question to the subagent, not the parent", () => {
    const s = initialChat("s1");
    applyEvent(s, asked("toolu_q", "req-q", "affdd797eddcfa753"));
    expect(question(s).agentId).toBe("affdd797eddcfa753");
    const parent = initialChat("s1");
    applyEvent(parent, asked());
    expect(question(parent).agentId).toBeNull();
  });

  it("settles the form the moment answers are sent, before the agent replies", () => {
    const s = initialChat("s1");
    applyEvent(s, asked());
    pushQuestionAnswers(s, "toolu_q", [{ question: "Which answer channel?", picks: ["In protocol"], freeText: null }]);
    expect(answerable(question(s))).toBe(false);
    // A second send must not overwrite the first: the request behind it takes
    // exactly one answer.
    pushQuestionAnswers(s, "toolu_q", [{ question: "Which answer channel?", picks: ["A dedicated hook"], freeText: null }]);
    expect(question(s).submitted?.[0]?.picks).toEqual(["In protocol"]);
  });

  it("leaves an answered question alone when a stale request arrives after it", () => {
    const s = initialChat("s1");
    applyEvent(s, startedQuestion());
    applyEvent(s, completedQuestion("toolu_q", ANSWER));
    applyEvent(s, asked());
    expect(question(s).requestId).toBeNull();
    expect(answerable(question(s))).toBe(false);
  });

  it("renders the old tool card when the setting is off", () => {
    const s = initialChat("s1", false);
    applyEvent(s, turnStarted("turn-1"));
    applyEvent(s, startedQuestion());
    applyEvent(s, completedQuestion("toolu_q", ANSWER));
    expect(kinds(s)).toEqual(["tool"]);
    expect(tool(s, "toolu_q").name).toBe("AskUserQuestion");
  });

  it("still honours a question the backend sent, even with the setting off", () => {
    // The backend decides what it sends. If the preference was flipped after
    // this session spawned, a request already in flight must not be orphaned
    // into a card nobody can answer.
    const s = initialChat("s1", false);
    applyEvent(s, asked());
    applyEvent(s, startedQuestion());
    expect(kinds(s)).toEqual(["question"]);
    expect(s.toolIndex["toolu_q"]).toBeUndefined();
  });

  it("falls back to a tool card when the input is not a form it can read", () => {
    // All or nothing, the same rule the Rust mapper applies: a form one row
    // short would show fewer questions than the agent asked.
    const broken: unknown[] = [
      { questions: [] },
      { questions: [{ header: "no prose", options: [{ label: "A" }] }] },
      { questions: [{ question: "Q", options: [] }] },
      { questions: [{ question: "Q", options: [{ description: "no label" }] }] },
      { questions: [{ question: "ok", options: [{ label: "A" }] }, { question: "no options" }] },
      { prompt: "not the shape" },
      null,
      "a string",
    ];
    for (const input of broken) {
      expect(parseQuestions(input), JSON.stringify(input)).toBeNull();
      const s = initialChat("s1");
      applyEvent(s, { ...(startedQuestion() as object), input } as ChatEvent);
      expect(kinds(s), JSON.stringify(input)).toEqual(["tool"]);
    }
  });

  it("takes over a card already made for the call rather than rendering both", () => {
    // The one window where this happens: the backend reads the preference when
    // it spawns and the store reads it when it mounts, so a remount after the
    // setting was flipped leaves a store that suppresses nothing talking to a
    // child that still asks.
    const s = initialChat("s1", false);
    applyEvent(s, turnStarted("turn-1"));
    applyEvent(s, startedQuestion());
    expect(kinds(s)).toEqual(["tool"]);

    applyEvent(s, asked());
    expect(kinds(s), "one call, one row").toEqual(["question"]);
    const q = question(s);
    expect(q.requestId).toBe("req-q");
    expect(q.turnId).toBe("turn-1");
    // The form survives the takeover: it came off the card's own input.
    expect(q.questions.map((x) => x.question)).toEqual(["Which answer channel?", "Which should I address?"]);
    // And the card's index is gone, or a tool lookup would hand back a question
    // wearing a card's name.
    expect(s.toolIndex["toolu_q"]).toBeUndefined();

    applyEvent(s, completedQuestion("toolu_q", ANSWER));
    expect(kinds(s)).toEqual(["question"]);
    expect(question(s).result).toBe(ANSWER);
  });

  it("carries a result the adopted card had already recorded", () => {
    const s = initialChat("s1", false);
    applyEvent(s, startedQuestion());
    applyEvent(s, completedQuestion("toolu_q", ANSWER));
    applyEvent(s, asked());
    expect(kinds(s)).toEqual(["question"]);
    // Adopted after the fact, so the answer must not be lost with the card.
    expect(question(s).result).toBe(ANSWER);
    expect(answerable(question(s)), "already settled, so still not answerable").toBe(false);
  });

  // The bug this pins: an open question reported as "executing", so the dot
  // never rose to needs-you and a user in another space was never notified.
  it("blocks the session while a question is open, and stops blocking once it is answered", () => {
    const s = replay([FIXTURE[0], turnStarted("turn-1"), startedQuestion(), asked()]);
    expect(chatStatus(s)).toBe("waitingForAnswer");
    applyEvent(s, completedQuestion("toolu_q", ANSWER));
    expect(chatStatus(s)).toBe("executing");
  });

  it("does not block on a replayed question, which carries nothing to answer with", () => {
    const s = replay([FIXTURE[0], turnStarted("turn-1"), startedQuestion(), completedQuestion("toolu_q", ANSWER)]);
    expect(answerable(question(s))).toBe(false);
    expect(chatStatus(s)).toBe("executing");
  });

  it("reads the option keys the answer string depends on", () => {
    const parsed = parseQuestions(FORM)!;
    expect(parsed[0].options[0].preview).toBe("behavior: deny");
    expect(parsed[0].options[1].preview).toBeNull();
    expect(parsed[0].options[0].description).toBe("Answer what the agent asked.");
    expect(parsed[0].multiSelect).toBe(false);
    expect(parsed[1].multiSelect).toBe(true);
    // Absent rather than false on the wire is single-select, matching the tool.
    expect(parseQuestions({ questions: [{ question: "Q", options: [{ label: "A" }] }] })![0].multiSelect).toBe(false);
  });
});

// How long the model thought is the silence *before* the block, not the time
// spent receiving it: thinking usually arrives whole, in a single frame, so a
// span measured from the first delta to the last is always about zero. That
// was the bug: every settled thought read "Thought" and never "Thought for Ns".
describe("how long a thought took", () => {
  const think = (turnId: string, t: string): ChatEvent => ({
    type: "thinkingDelta",
    sessionId: "s1",
    turnId,
    text: t,
  });
  const thought = (s: ChatState): ThinkingItem => s.items.find((i) => i.kind === "thinking") as ThinkingItem;
  const span = (s: ChatState) => thought(s).endedAt - thought(s).startedAt;

  afterEach(() => vi.useRealTimers());

  function at(ms: number) {
    vi.setSystemTime(new Date(ms));
  }

  it("measures the wait before a thought that arrives in one frame", () => {
    vi.useFakeTimers();
    at(0);
    const s = initialChat("s1");
    applyEvent(s, turnStarted("t1"));
    at(12_000);
    applyEvent(s, think("t1", "the whole thought, at once"));
    expect(span(s)).toBe(12_000);
  });

  it("runs a streamed thought from the wait through its last delta", () => {
    vi.useFakeTimers();
    at(0);
    const s = initialChat("s1");
    applyEvent(s, turnStarted("t1"));
    at(3_000);
    applyEvent(s, think("t1", "first "));
    at(5_000);
    applyEvent(s, think("t1", "second"));
    expect(thought(s).text).toBe("first second");
    expect(span(s)).toBe(5_000);
  });

  it("starts the clock at the tool result, not at the turn", () => {
    vi.useFakeTimers();
    at(0);
    const s = initialChat("s1");
    applyEvent(s, turnStarted("t1"));
    applyEvent(s, started("t1", "toolu_1"));
    at(30_000);
    applyEvent(s, completed("t1", "toolu_1"));
    at(34_000);
    applyEvent(s, think("t1", "reading that"));
    // 4s of thinking, not the 34s that includes someone else's tool run.
    expect(span(s)).toBe(4_000);
  });

  it("does not count the time a user sat on a permission prompt", () => {
    vi.useFakeTimers();
    at(0);
    const s = initialChat("s1");
    applyEvent(s, turnStarted("t1"));
    applyEvent(s, started("t1", "toolu_1"));
    applyEvent(s, prompt("toolu_1"));
    // Four minutes of the user deciding. None of it is the model thinking.
    at(240_000);
    resolveApproval(s, "toolu_1");
    at(242_000);
    applyEvent(s, think("t1", "allowed, so"));
    expect(span(s)).toBe(2_000);
  });

  it("does not count the time a user sat on a question", () => {
    vi.useFakeTimers();
    at(0);
    const s = initialChat("s1");
    applyEvent(s, turnStarted("t1"));
    applyEvent(s, {
      type: "questionRequest",
      sessionId: "s1",
      toolUseId: "toolu_q",
      requestId: "rq",
      agentId: null,
      questions: [{ question: "which?", header: "h", multiSelect: false, options: [] }],
    });
    at(180_000);
    pushQuestionAnswers(s, "toolu_q", [{ question: "which?", picks: ["a"], freeText: null }]);
    at(181_000);
    applyEvent(s, think("t1", "given that"));
    expect(span(s)).toBe(1_000);
  });

  it("measures nothing on a replay, where every frame lands in one tick", () => {
    vi.useFakeTimers();
    at(0);
    const s = initialChat("s1");
    applyEvent(s, turnStarted("t1"));
    applyEvent(s, think("t1", "replayed whole"));
    // Zero, which the card reads as unmeasured and renders as plain "Thought"
    // rather than as a fabricated duration.
    expect(span(s)).toBe(0);
  });
});
