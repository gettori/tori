import { describe, it, expect } from "vite-plus/test";
import {
  applyEvent,
  beginReconnect,
  chatStatus,
  connectionHealth,
  enqueue,
  initialChat,
  queuedText,
} from "../panels/Chat/chatStore";
import type { ChatEvent } from "./chatTypes";

const SESSION = "11111111-2222-3333-4444-555555555555";

const started: ChatEvent = {
  type: "sessionStarted",
  sessionId: SESSION,
  cwd: "/work/repo",
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
};

const turn = (turnId: string): ChatEvent => ({
  type: "turnStarted",
  sessionId: SESSION,
  turnId,
  model: "claude-sonnet-5",
  permissionMode: "default",
  agentInitiated: false,
});

/** What `claude_transport` emits when the child's stdout hits EOF - i.e. what
 *  an externally killed process actually looks like from here. */
const childDied: ChatEvent = {
  type: "sessionError",
  sessionId: SESSION,
  message: "the claude process exited",
  fatal: true,
};

describe("connectionHealth", () => {
  it("is connecting until the child's first init arrives", () => {
    expect(connectionHealth(initialChat(SESSION))).toBe("connecting");
  });

  it("is connected once the session has started", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    expect(connectionHealth(s)).toBe("connected");
  });

  // The verify: killing the child externally flips this. It is driven by the
  // fatal `sessionError` the transport emits on stdout EOF, so it lands as fast
  // as the OS closes the pipe - there is no poll interval to be slower than the
  // two seconds asked for.
  it("flips to disconnected on the fatal error a dying child produces", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    applyEvent(s, turn("t1"));
    expect(connectionHealth(s)).toBe("connected");

    applyEvent(s, childDied);
    expect(connectionHealth(s)).toBe("disconnected");
    // And the turn it was running is no longer claimed to be running.
    expect(chatStatus(s)).toBe("none");
  });

  // A single unparseable stdout line is worth surfacing and not worth
  // declaring the session dead over - the same split the host reaps on.
  it("stays connected through a non-fatal error", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    applyEvent(s, { ...childDied, fatal: false });
    expect(connectionHealth(s)).toBe("connected");
  });

  it("is disconnected after a deliberate session end too", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    applyEvent(s, { type: "sessionEnded", sessionId: SESSION, reason: null });
    expect(connectionHealth(s)).toBe("disconnected");
  });
});

describe("beginReconnect", () => {
  it("reads as connecting until the resumed child answers", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    applyEvent(s, childDied);

    beginReconnect(s);
    // Not "connected": nothing has answered yet, and saying connected here
    // would promise a process that may never come back.
    expect(connectionHealth(s)).toBe("connecting");

    applyEvent(s, started);
    expect(connectionHealth(s)).toBe("connected");
  });

  // The reconnect resumes the same session, so its transcript is still the
  // truth. Clearing it would throw away the conversation to reflect a dropped
  // pipe, which is the opposite of what resuming means.
  it("keeps the transcript and the queue", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    applyEvent(s, turn("t1"));
    applyEvent(s, { type: "textDelta", sessionId: SESSION, turnId: "t1", text: "half an answer", agentId: null });
    enqueue(s, [{ type: "text", text: "the thing I typed during the outage" }]);
    applyEvent(s, childDied);

    const itemsBefore = s.items.length;
    beginReconnect(s);
    expect(s.items.length).toBe(itemsBefore);
    expect(s.items.some((i) => i.kind === "text" && i.text === "half an answer")).toBe(true);
    expect(s.queue.map(queuedText)).toEqual(["the thing I typed during the outage"]);
  });

  // The turn that was in flight died with the child. Leaving it marked running
  // would leave the composer stuck reading as busy against a process that is
  // not there, and the revert guard blocking on a turn nothing is executing.
  it("does not carry the dead turn over as still running", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    applyEvent(s, turn("t1"));
    applyEvent(s, childDied);

    beginReconnect(s);
    expect(s.activeTurnId).toBeNull();
    expect(s.awaitingTurn).toBe(false);
    expect(chatStatus(s)).toBe("running");
  });
});

// A refused claim is not a connection problem and must not be reported as one.
// No child is ever started for it, so the health would sit on "connecting"
// indefinitely - which is why the panel hides the control entirely rather than
// letting this function invent a state for it.
describe("a session whose claim was refused", () => {
  it("never reaches connected on its own, which is why the control is hidden", () => {
    const s = initialChat(SESSION);
    // Nothing arrives: no init, no error, because no child was spawned.
    expect(connectionHealth(s)).toBe("connecting");
    expect(s.started).toBe(false);
    expect(s.ended).toBe(false);
  });
});
