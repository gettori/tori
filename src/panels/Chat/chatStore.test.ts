import { describe, it, expect } from "vitest";
import events from "../../../dev/fixtures/chat/events.json";
import { parseChatEvent, type ChatEvent } from "../../utils/chatTypes";
import {
  applyEvent,
  chatStatus,
  clearAwaitingTurn,
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
  pendingFlush,
  pushUserTurn,
  releaseQueue,
  removeQueued,
  resolveApproval,
  revertEffortPick,
  revertModelPick,
  selectEffort,
  selectMode,
  selectModel,
  shownEffort,
  shownMode,
  shownModelValue,
  takeForSend,
  visibleItems,
  windowed,
  type ChatItem,
  type ChatState,
  type ToolItem,
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
  fastModeState: null,
  fastModeDisabledReason: null,
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
});
const prompt = (toolUseId: string, requestId = "r1"): ChatEvent => ({
  type: "permissionRequest",
  sessionId: "s1",
  toolUseId,
  toolName: "Bash",
  input: { command: "ls" },
  requestId,
  autoDenyAtMs: null,
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

describe("replaying the captured fixture", () => {
  it("produces one item per rendered event, in arrival order", () => {
    const s = replay(FIXTURE);
    // the replayed user turn, the compaction notice, text, thinking, then a
    // card each for toolu_1 (started), toolu_2 (fileEdit) and toolu_3
    // (permissionRequest), then the error and end notices, and last the hook
    // frame (the fixture lists it after the lifecycle events).
    expect(kinds(s)).toEqual([
      "user",
      "notice",
      "text",
      "thinking",
      "tool",
      "tool",
      "tool",
      "notice",
      "notice",
      "hook",
    ]);
    // The compaction renders in place, carrying the figures and the summary.
    expect((s.items[1] as { text: string }).text).toContain("Compacted manually (247k to 9k)");
    expect((s.items[1] as { text: string }).text).toContain("continued from a previous conversation");
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
    expect(s.slashCommands.map((c) => c.name)).toEqual(["review"]);
    expect(s.mcpServers.map((m) => m.name)).toEqual(["ctx"]);
    expect(s.plan.length).toBeGreaterThan(0);
    expect(s.lastUsage).not.toBeNull();
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

  it("never flushes into a dead session", () => {
    const s = queued(1);
    applyEvent(s, { type: "sessionEnded", sessionId: "s1", reason: "child exited" });
    expect(pendingFlush(s)).toBeNull();
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

  it("falls back to default before the session has said anything", () => {
    const s = initialChat("s1");
    expect(shownMode(s)).toBe("default");
    expect(modePending(s)).toBe(false);
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
    // The plan's headline figure. Sway's approval hook runs on every tool call
    // and contributes two frames each time, which is exactly the noise the
    // default collapse exists to keep out of the user's transcript.
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
    // unattributed. Without back-propagation the row that starts Sway's hook
    // would stay visible while the row that finishes it folded away.
    const s = initialChat("s1");
    applyEvent(s, hook("sway-1", "started", false));
    expect(hookRows(s, false)).toHaveLength(1);
    applyEvent(s, hook("sway-1", "finished", true));
    expect(hookRows(s, false)).toHaveLength(0);
  });

  it("shows a user hook inline with its outcome and exit code", () => {
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
    const rows = hookRows(s, false);
    expect(rows).toHaveLength(2);
    const done = rows[1] as { name: string; outcome: string; exitCode: number; stderr: string };
    expect(done.name).toBe("SessionStart:startup");
    expect(done.outcome).toBe("blocking_error");
    expect(done.exitCode).toBe(2);
    expect(done.stderr).toBe("a warning");
  });

  it("keeps the user's hooks visible while folding Sway's, in one interleaved turn", () => {
    // The attribution has to be per-hook, not per-name: both hooks here are
    // `PreToolUse:Bash`, and only the marker separates them.
    const s = initialChat("s1");
    applyEvent(s, hook("sway-1", "started", false));
    applyEvent(s, hook("user-1", "started", false));
    applyEvent(s, hook("sway-1", "finished", true));
    applyEvent(s, hook("user-1", "finished", false));
    expect(hookRows(s, false).map((r) => (r as { hookId: string }).hookId)).toEqual(["user-1", "user-1"]);
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
