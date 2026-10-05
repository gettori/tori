import { describe, it, expect } from "vite-plus/test";
import { chatToStop, isStoppable, stoppableChats, type LiveChat } from "./chatSessions";
import { BINDINGS } from "./hotkeys";
import { applyEvent, chatStatus, initialChat } from "../panels/Chat/chatStore";
import type { ChatEvent } from "./chatTypes";

const chat = (over: Partial<LiveChat> & { sessionId: string }): LiveChat => ({
  sessionName: over.sessionId,
  agentId: "claude",
  folderPath: "/work/repo",
  tabId: `chat:${over.sessionId}`,
  status: "executing",
  visible: false,
  ...over,
});

describe("isStoppable", () => {
  it("counts a running turn", () => {
    expect(isStoppable("executing")).toBe(true);
  });

  // A chat blocked on an approval is still mid-turn, and stopping is a
  // reasonable answer to a prompt you do not want to grant. Excluding it would
  // make the state a user most wants out of the one stop cannot reach.
  it("counts a turn blocked on an approval", () => {
    expect(isStoppable("waitingForApproval")).toBe(true);
  });

  it("leaves settled sessions alone", () => {
    expect(isStoppable("idle")).toBe(false);
    expect(isStoppable("running")).toBe(false);
    expect(isStoppable("none")).toBe(false);
  });
});

describe("chatToStop", () => {
  it("has nothing to stop when nothing is running", () => {
    expect(chatToStop([chat({ sessionId: "a", status: "idle" })])).toBeNull();
  });

  it("stops the only running chat, whether or not it is on screen", () => {
    expect(chatToStop([chat({ sessionId: "a" }), chat({ sessionId: "b", status: "idle" })])?.sessionId).toBe("a");
  });

  // The verify: the hotkey has to work from an unfocused pane, so it cannot
  // resolve to "whatever has focus". The chat whose tab is on screen is the one
  // the user means.
  it("prefers the chat whose tab is on screen", () => {
    const chats = [chat({ sessionId: "a" }), chat({ sessionId: "b", visible: true }), chat({ sessionId: "c" })];
    expect(chatToStop(chats)?.sessionId).toBe("b");
  });

  // A stop cannot be undone - the turn does not resume - so picking one of
  // several by list order would sometimes kill the wrong one silently. The
  // caller turns this null into a message pointing at the palette.
  it("refuses to choose between several running chats with none on screen", () => {
    expect(chatToStop([chat({ sessionId: "a" }), chat({ sessionId: "b" })])).toBeNull();
  });

  it("ignores an idle chat that happens to be on screen", () => {
    const chats = [chat({ sessionId: "a" }), chat({ sessionId: "b", status: "idle", visible: true })];
    expect(chatToStop(chats)?.sessionId).toBe("a");
  });
});

describe("stoppableChats", () => {
  it("lists exactly what the palette offers to stop", () => {
    const chats = [
      chat({ sessionId: "a" }),
      chat({ sessionId: "b", status: "waitingForApproval" }),
      chat({ sessionId: "c", status: "idle" }),
    ];
    expect(stoppableChats(chats).map((c) => c.sessionId)).toEqual(["a", "b"]);
  });
});

describe("the stop hotkey", () => {
  const binding = () => BINDINGS.find((b) => b.id === "stop-chat");

  it("is bound and listed in the shortcut sheet", () => {
    expect(binding()).toBeDefined();
    expect(binding()!.keys).toEqual(["⌘", "."]);
    expect(binding()!.group).toBe("session");
  });

  // The whole point: a `window` scope would be swallowed the moment a terminal
  // had focus, which is exactly when a runaway turn needs stopping.
  it("is global, so it survives terminal focus", () => {
    expect(binding()!.scope).toBe("global");
  });

  it("matches Cmd+. and not its near neighbours", () => {
    const ev = (over: Partial<KeyboardEvent>) =>
      ({ metaKey: false, shiftKey: false, ctrlKey: false, altKey: false, key: ".", ...over }) as KeyboardEvent;
    expect(binding()!.match(ev({ metaKey: true }))).toBe(true);
    expect(binding()!.match(ev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(binding()!.match(ev({ metaKey: false }))).toBe(false);
    expect(binding()!.match(ev({ metaKey: true, key: "," }))).toBe(false);
  });
});

describe("end to end through the store", () => {
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

  // No synthetic status anywhere: real events -> chatStore -> chatStatus is the
  // path a live chat's stoppability actually takes.
  it("becomes stoppable when a turn starts and stops being so when it ends", () => {
    const s = initialChat(SESSION);
    applyEvent(s, started);
    const entry = () => [chat({ sessionId: SESSION, status: chatStatus(s), visible: true })];
    expect(chatToStop(entry())).toBeNull();

    applyEvent(s, {
      type: "turnStarted",
      sessionId: SESSION,
      turnId: "t1",
      model: "claude-sonnet-5",
      permissionMode: "default",
      agentInitiated: false,
    });
    expect(chatToStop(entry())?.sessionId).toBe(SESSION);

    applyEvent(s, {
      type: "turnCompleted",
      sessionId: SESSION,
      turnId: "t1",
      outcome: "cancelled",
      stopReason: "interrupt",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
      costUsd: null,
      permissionDenials: [],
    });
    expect(chatToStop(entry())).toBeNull();
  });
});
