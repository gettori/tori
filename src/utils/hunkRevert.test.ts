import { describe, it, expect, afterEach } from "vitest";
import { hunkRevertPermission } from "./hunkRevert";
import type { RevertCandidate } from "./revertGuard";
import { applyEvent, chatStatus, initialChat } from "../panels/Chat/chatStore";
import { dropLiveChat, setLiveChat } from "./chatSessions";
import { liveCandidates } from "./folderActors";
import type { ChatEvent } from "./chatTypes";

const REPO = "/work/repo";

function candidate(over: Partial<RevertCandidate> & { sessionId: string }): RevertCandidate {
  return {
    sessionName: over.sessionId,
    folderPath: REPO,
    status: "idle",
    hasLiveTab: true,
    ...over,
  };
}

describe("hunkRevertPermission", () => {
  it("allows the revert when nothing in the folder is busy", () => {
    expect(hunkRevertPermission([candidate({ sessionId: "a" })], REPO)).toEqual({ kind: "allow" });
  });

  it("refuses without an override while a session is mid-turn, naming it", () => {
    const perm = hunkRevertPermission([candidate({ sessionId: "busy", status: "executing" })], REPO);
    expect(perm.kind).toBe("refuse");
    if (perm.kind === "allow") return;
    expect(perm.reason).toContain("busy");
  });

  it("asks rather than refuses when the only blocker is a session we cannot see inside", () => {
    const perm = hunkRevertPermission(
      [candidate({ sessionId: "detached", status: "running", hasLiveTab: false })],
      REPO,
    );
    expect(perm.kind).toBe("confirm");
  });

  it("ignores sessions outside the folder the file lives in", () => {
    const perm = hunkRevertPermission(
      [candidate({ sessionId: "elsewhere", status: "executing", folderPath: "/work/other" })],
      REPO,
    );
    expect(perm).toEqual({ kind: "allow" });
  });
});

describe("a chat's own turn blocks reverting its own edits", () => {
  // Through the shipping path rather than a synthetic candidate: real events ->
  // chatStore -> chatStatus -> the live-chat registry -> liveCandidates. The
  // hazard this exists for is a card's Revert clicked while the agent that wrote
  // the card is still writing.
  const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function register(state: ReturnType<typeof initialChat>) {
    setLiveChat({
      sessionId: SESSION,
      sessionName: "chat",
      folderPath: REPO,
      tabId: "chat:1",
      visible: true,
      status: chatStatus(state),
    });
  }

  afterEach(() => dropLiveChat(SESSION));

  it("refuses while the turn runs and allows once it finishes", () => {
    const state = initialChat(SESSION);
    const started: ChatEvent = {
      type: "turnStarted",
      sessionId: SESSION,
      turnId: "t1",
      model: "claude-sonnet-5",
      permissionMode: "default",
    };
    applyEvent(state, started);
    register(state);
    expect(hunkRevertPermission(liveCandidates(), REPO).kind).toBe("refuse");

    applyEvent(state, {
      type: "turnCompleted",
      sessionId: SESSION,
      turnId: "t1",
      outcome: "completed",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
      costUsd: null,
      permissionDenials: [],
    });
    register(state);
    expect(hunkRevertPermission(liveCandidates(), REPO)).toEqual({ kind: "allow" });
  });
});
