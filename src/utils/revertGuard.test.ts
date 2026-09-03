import { describe, it, expect, afterEach } from "vitest";
import { revertGuard, revertBlockers, type RevertCandidate } from "./revertGuard";
import { applyEvent, chatStatus, initialChat } from "../panels/Chat/chatStore";
import { dropLiveChat, setLiveChat } from "./chatSessions";
import { liveCandidates } from "./folderActors";
import { computeSessionDot } from "./sessionDot";
import { statusFromDot } from "./sessionStatus";
import guardSource from "./revertGuard.ts?raw";
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

describe("revertGuard", () => {
  it("allows a revert when every folder-local session is idle", () => {
    const verdict = revertGuard([candidate({ sessionId: "a" }), candidate({ sessionId: "b" })], {
      folderPath: REPO,
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it("refuses hard, naming the session, while a live tab is Executing", () => {
    const verdict = revertGuard(
      [candidate({ sessionId: "a" }), candidate({ sessionId: "busy", status: "executing" })],
      { folderPath: REPO },
    );
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.overridable).toBe(false);
    expect(verdict.reason).toContain("busy");
    expect(verdict.blockers).toEqual([{ sessionId: "busy", sessionName: "busy", kind: "executing" }]);
  });

  it("does not let the detached override unblock a verified Executing session", () => {
    const verdict = revertGuard([candidate({ sessionId: "busy", status: "executing" })], {
      folderPath: REPO,
      allowDetached: true,
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.overridable).toBe(false);
  });

  it("refuses a detached running session by default, but names it as overridable", () => {
    const verdict = revertGuard([candidate({ sessionId: "ghost", status: "running", hasLiveTab: false })], {
      folderPath: REPO,
    });
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.overridable).toBe(true);
    expect(verdict.reason).toContain("ghost");
    expect(verdict.blockers[0].kind).toBe("detached");
  });

  it("proceeds past a detached session only once the override is invoked", () => {
    const sessions = [candidate({ sessionId: "ghost", status: "running", hasLiveTab: false })];
    expect(revertGuard(sessions, { folderPath: REPO }).allow).toBe(false);
    const overridden = revertGuard(sessions, {
      folderPath: REPO,
      allowDetached: true,
    });
    expect(overridden.allow).toBe(true);
    // The blast radius is still reported, so the confirm can list it.
    expect(overridden.blockers[0].sessionName).toBe("ghost");
  });

  it("counts a session in a subfolder, and ignores one outside the repo", () => {
    const blockers = revertBlockers(
      [
        candidate({
          sessionId: "nested",
          folderPath: `${REPO}/packages/app`,
          status: "executing",
        }),
        candidate({
          sessionId: "elsewhere",
          folderPath: "/work/other",
          status: "executing",
        }),
      ],
      REPO,
    );
    expect(blockers.map((b) => b.sessionId)).toEqual(["nested"]);
  });

  it("names several blockers readably", () => {
    const verdict = revertGuard(
      [candidate({ sessionId: "one", status: "executing" }), candidate({ sessionId: "two", status: "executing" })],
      { folderPath: REPO },
    );
    if (verdict.allow) throw new Error("expected a block");
    expect(verdict.reason).toContain("one and two");
    expect(verdict.reason).toContain("are running");
  });

  it("treats a live tab that is merely running as no blocker", () => {
    // "running" on a live tab is the idle-but-alive case; only the detached
    // tier's unverifiable "running" blocks.
    const verdict = revertGuard([candidate({ sessionId: "alive", status: "running" })], {
      folderPath: REPO,
    });
    expect(verdict.allow).toBe(true);
  });

  it("blocks hard on a chat session mid-turn", () => {
    const verdict = revertGuard([candidate({ sessionId: "chat", status: "executing" })], { folderPath: REPO });
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.overridable).toBe(false);
    expect(verdict.blockers).toEqual([{ sessionId: "chat", sessionName: "chat", kind: "executing" }]);
  });

  it("does not block on an idle chat session", () => {
    expect(revertGuard([candidate({ sessionId: "chat", status: "idle" })], { folderPath: REPO }).allow).toBe(true);
  });

  it("blocks a session known to be executing even without a live tab", () => {
    // The old `hasLiveTab && executing` pairing relied on an invariant chat
    // retired: a candidate reporting executing without a live tab matched
    // neither branch and blocked nothing.
    const verdict = revertGuard([candidate({ sessionId: "chat", status: "executing", hasLiveTab: false })], {
      folderPath: REPO,
    });
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.overridable).toBe(false);
  });
});

// The half of Phase 5's fix that could not be checked until chat actually
// supplied a status: the guard was corrected then, but nothing composed an
// `executing` without a live tab, so the corrected branch was unreachable and
// the module's own docs still taught the retired invariant. Both halves are
// pinned here - the behaviour through the shipping composition, and the prose,
// which is what a reader believes when the code disagrees with it.
describe("the retired single-agent invariant", () => {
  it("no longer survives in the guard's doc comment", () => {
    // Read as source rather than asserted from memory: the claim was true when
    // it was written, so nothing about the code flags it as stale.
    expect(guardSource).not.toMatch(/never report Executing/i);
    expect(guardSource).toMatch(/judged on the status alone/);
  });

  it("blocks the revert through the same composition the sidebar renders", () => {
    // computeSessionDot -> statusFromDot -> RevertCandidate, i.e. the path the
    // sidebar row takes, not a hand-written "executing".
    const dot = computeSessionDot({ chatStatus: "executing", hasLiveTab: false, running: false });
    const verdict = revertGuard(
      [candidate({ sessionId: "chat", status: statusFromDot(dot), hasLiveTab: false })],
      { folderPath: REPO },
    );
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.overridable).toBe(false);
    expect(verdict.blockers.map((b) => b.kind)).toEqual(["executing"]);
  });
});

describe("a live chat blocks a real tree revert", () => {
  // End to end through the shipping path, with no synthetic candidate anywhere:
  // real events -> chatStore -> chatStatus -> the live-chat registry ->
  // folderActors.liveCandidates -> revertGuard.
  const SESSION = "11111111-2222-3333-4444-555555555555";

  const turn = (turnId: string): ChatEvent => ({
    type: "turnStarted",
    sessionId: SESSION,
    turnId,
    model: "claude-sonnet-5",
    permissionMode: "default", agentInitiated: false
  });

  function register(state: ReturnType<typeof initialChat>) {
    setLiveChat({
      sessionId: SESSION,
      sessionName: "chat",
      folderPath: REPO,
      tabId: "chat:1",
      visible: false,
      status: chatStatus(state),
    });
  }

  afterEach(() => dropLiveChat(SESSION));

  it("refuses hard while the chat is mid-turn, and allows once it finishes", () => {
    const state = initialChat(SESSION);
    applyEvent(state, {
      type: "sessionStarted",
      sessionId: SESSION,
      cwd: REPO,
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
    });
    register(state);
    expect(revertGuard(liveCandidates(), { folderPath: REPO }).allow).toBe(true);

    applyEvent(state, turn("t1"));
    register(state);
    const blocked = revertGuard(liveCandidates(), { folderPath: REPO });
    expect(blocked.allow).toBe(false);
    if (blocked.allow) return;
    expect(blocked.overridable).toBe(false);
    expect(blocked.blockers.map((b) => b.kind)).toEqual(["executing"]);

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
    expect(revertGuard(liveCandidates(), { folderPath: REPO }).allow).toBe(true);
  });
});
