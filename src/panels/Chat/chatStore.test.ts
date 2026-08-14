import { describe, it, expect } from "vitest";
import events from "../../../dev/fixtures/chat/events.json";
import { parseChatEvent, type ChatEvent } from "../../utils/chatTypes";
import { BLOCKED_REASON, sendWithProbeGate } from "../../utils/safeSend";
import {
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
  pendingFlush,
  promptsSent,
  pushSteer,
  pushUserTurn,
  toolCallsSeen,
  reasoningFor,
  releaseQueue,
  removeQueued,
  resolveApproval,
  revertEffortPick,
  revertModelPick,
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
  type ChatState,
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
    // The compaction renders in place. The line carries the figures; the
    // summary rides along as details, folded away rather than inline.
    const boundary = s.items[1] as { text: string; details?: string };
    expect(boundary.text).toBe("Compacted manually (247k to 9k).");
    expect(boundary.details).toContain("continued from a previous conversation");
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

  // The ceiling used to be a tool-call denial the harness's own hook enforced.
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
  // named a mode that exists only in Claude's vocabulary: on a harness whose
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
    input: {},
    state: "ok",
    approval: null,
    output: null,
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

  // The harness has reported a post larger than the pre; that is not a negative
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
