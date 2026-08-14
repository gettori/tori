import { describe, it, expect } from "vitest";
import {
  stepPresence,
  markAttended,
  liveCounts,
  trayEntries,
  unattendedNeedsYouCount,
  shouldSuppressNotification,
} from "./presence";
import { applyEvent, chatStatus, initialChat, resolveApproval } from "../panels/Chat/chatStore";
import { dotFromStatus } from "./sessionStatus";
import type { ChatEvent } from "./chatTypes";

const empty = { attended: {}, lastDot: {} };

describe("stepPresence", () => {
  it("fires exactly once on the needsYou rising edge, not on every tick while it stays needsYou", () => {
    const first = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(first.transitioned).toEqual(["s1"]);

    const second = stepPresence(first.state, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(second.transitioned).toEqual([]);
  });

  it("a genuine re-block (via an intermediate non-needsYou dot) resets the session to unattended", () => {
    const blocked = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    const attended = markAttended(blocked.state, "s1");
    expect(attended.attended.s1).toBe(true);

    // The steady state (still needsYou, no intervening change) must NOT
    // count as a re-block - attended stays true.
    const stillBlocked = stepPresence(attended, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(stillBlocked.transitioned).toEqual([]);
    expect(stillBlocked.state.attended.s1).toBe(true);

    // A genuine re-block (the agent resumed in between) resets attended.
    const resumed = stepPresence(stillBlocked.state, [{ sessionId: "s1", dot: "working" }]);
    const reblocked = stepPresence(resumed.state, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(reblocked.transitioned).toEqual(["s1"]);
    expect(reblocked.state.attended.s1).toBe(false);
  });

  it("attending doesn't suppress the next genuine transition (re-block after attended fires again)", () => {
    const blocked = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    const attended = markAttended(blocked.state, "s1");

    // The agent resumes (working), then blocks again - a real re-block, not
    // a rerender of the same steady state.
    const resumed = stepPresence(attended, [{ sessionId: "s1", dot: "working" }]);
    expect(resumed.transitioned).toEqual([]);

    const reblocked = stepPresence(resumed.state, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(reblocked.transitioned).toEqual(["s1"]);
  });

  it("tracks multiple sessions independently", () => {
    const step = stepPresence(empty, [
      { sessionId: "a", dot: "needsYou" },
      { sessionId: "b", dot: "working" },
    ]);
    expect(step.transitioned).toEqual(["a"]);

    const next = stepPresence(step.state, [
      { sessionId: "a", dot: "needsYou" }, // steady, no re-fire
      { sessionId: "b", dot: "needsYou" }, // b's own rising edge
    ]);
    expect(next.transitioned).toEqual(["b"]);
  });
});

describe("markAttended", () => {
  it("is a no-op for an already-attended session", () => {
    const step = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    const once = markAttended(step.state, "s1");
    const twice = markAttended(once, "s1");
    expect(twice).toEqual(once);
  });
});

describe("liveCounts", () => {
  it("counts every non-none dot as running, needsYou as a subset", () => {
    const counts = liveCounts([
      { dot: "working" },
      { dot: "needsYou" },
      { dot: "solid" },
      { dot: "hollow" }, // detached sessions still count as running
      { dot: "none" },
    ]);
    expect(counts).toEqual({ running: 4, needsYou: 1 });
  });

  it("is zero/zero for no live sessions", () => {
    expect(liveCounts([])).toEqual({ running: 0, needsYou: 0 });
  });
});

describe("unattendedNeedsYouCount", () => {
  it("counts only needsYou sessions not yet attended", () => {
    const live = [
      { sessionId: "a", dot: "needsYou" },
      { sessionId: "b", dot: "needsYou" },
      { sessionId: "c", dot: "working" },
    ];
    expect(unattendedNeedsYouCount(live, {})).toBe(2);
    expect(unattendedNeedsYouCount(live, { a: true })).toBe(1);
    expect(unattendedNeedsYouCount(live, { a: true, b: true })).toBe(0);
  });
});

describe("shouldSuppressNotification", () => {
  it("suppresses only when the blocked session is both selected and the window is focused", () => {
    const event = { sessionId: "s1" };
    expect(shouldSuppressNotification(event, "s1", true)).toBe(true);
    expect(shouldSuppressNotification(event, "s1", false)).toBe(false); // selected but window unfocused
    expect(shouldSuppressNotification(event, "other", true)).toBe(false); // focused but a different tab
    expect(shouldSuppressNotification(event, undefined, true)).toBe(false);
  });

  // A chat is watched by having its tab on screen, not by being the sidebar's
  // selected row: its session id exists before any transcript does, so
  // selecting its tab usually resolves only as far as its branch. Keying on the
  // selection alone notified about a prompt sitting in the visible pane.
  it("also suppresses for a chat whose tab is the one on screen", () => {
    const event = { sessionId: "chat-1" };
    const onScreen = new Set(["chat-1"]);
    expect(shouldSuppressNotification(event, undefined, true, onScreen)).toBe(true);
    // A background chat is exactly what the notification is for.
    expect(shouldSuppressNotification(event, undefined, true, new Set(["chat-2"]))).toBe(false);
  });

  // The case the notification exists for. Nothing on screen counts as watched
  // when the window is behind another app.
  it("suppresses nothing while the window is unfocused", () => {
    expect(shouldSuppressNotification({ sessionId: "chat-1" }, "chat-1", false, new Set(["chat-1"]))).toBe(false);
  });
});

// The chat tier's contribution to the three presence surfaces, driven through
// the real fold rather than through hand-written dots: chatStore -> chatStatus
// -> dotFromStatus is the path a live chat actually takes to reach them, and a
// status the store computed differently would fail here rather than pass on a
// convenient literal.
describe("chats alongside PTY agents", () => {
  const A = "aaaaaaaa-1111-2222-3333-444444444444";
  const B = "bbbbbbbb-1111-2222-3333-444444444444";

  const started = (sessionId: string): ChatEvent => ({
    type: "sessionStarted",
    sessionId,
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
  });

  const asks = (sessionId: string, toolUseId: string): ChatEvent => ({
    type: "permissionRequest",
    sessionId,
    toolUseId,
    toolName: "Edit",
    input: {},
    requestId: `req-${toolUseId}`,
    autoDenyAtMs: null,
    agentId: null,
  });

  /** The same shape LeftSidebar's `liveSessionDots` builds for a chat. */
  function dotOf(state: ReturnType<typeof initialChat>, sessionId: string, name: string) {
    return {
      sessionId,
      dot: dotFromStatus(chatStatus(state)),
      sessionName: name,
      projectName: "repo",
      folderPath: "/work/repo",
      tabId: `chat:${sessionId}`,
    };
  }

  // The verify: two chats awaiting approval give a badge of 2 that clears as
  // each is answered, with PTY contributions unchanged.
  it("badges two blocked chats and clears as each is answered", () => {
    const a = initialChat(A);
    const b = initialChat(B);
    applyEvent(a, started(A));
    applyEvent(b, started(B));

    // A PTY agent that is busy throughout, so its contribution is visible as a
    // constant rather than assumed to be zero.
    const pty = { sessionId: "pty-1", dot: "working", sessionName: "agent", projectName: "repo", folderPath: "/work/repo", tabId: "t1" };
    const live = () => [pty, dotOf(a, A, "chat A"), dotOf(b, B, "chat B")];

    expect(unattendedNeedsYouCount(live(), {})).toBe(0);

    applyEvent(a, asks(A, "tool-a"));
    applyEvent(b, asks(B, "tool-b"));
    expect(unattendedNeedsYouCount(live(), {})).toBe(2);
    expect(liveCounts(live())).toEqual({ running: 3, needsYou: 2 });

    resolveApproval(a, "tool-a");
    expect(unattendedNeedsYouCount(live(), {})).toBe(1);

    resolveApproval(b, "tool-b");
    expect(unattendedNeedsYouCount(live(), {})).toBe(0);
    // The PTY agent is still there, still working, unaffected throughout.
    expect(liveCounts(live())).toEqual({ running: 3, needsYou: 0 });
  });

  it("fires one notification per blocked chat, on the rising edge only", () => {
    const a = initialChat(A);
    const b = initialChat(B);
    applyEvent(a, started(A));
    applyEvent(b, started(B));
    const live = () => [dotOf(a, A, "chat A"), dotOf(b, B, "chat B")];

    const idle = stepPresence(empty, live());
    expect(idle.transitioned).toEqual([]);

    applyEvent(a, asks(A, "tool-a"));
    const first = stepPresence(idle.state, live());
    expect(first.transitioned).toEqual([A]);

    // B blocks; A is still blocked and must not fire a second time.
    applyEvent(b, asks(B, "tool-b"));
    const second = stepPresence(first.state, live());
    expect(second.transitioned).toEqual([B]);
  });
});

describe("trayEntries", () => {
  const entry = (sessionId: string, dot: string, sessionName: string, projectName = "repo") => ({
    sessionId,
    dot,
    sessionName,
    projectName,
    folderPath: "/work/repo",
    tabId: `t:${sessionId}`,
  });

  // The bug this function exists to fix: the counts came from the merged list
  // and the entries from the PTY-only one, so a blocked chat was counted in the
  // badge and absent from the menu it sent you to.
  it("lists chats and PTY agents alike", () => {
    const live = [entry("pty-1", "working", "agent"), entry("chat-1", "needsYou", "chat A")];
    expect(trayEntries(live).map((e) => e.id)).toEqual(["chat-1", "pty-1"]);
    expect(liveCounts(live).needsYou).toBe(1);
    // Everything the badge counts is reachable from the menu.
    expect(trayEntries(live).length).toBe(live.filter((l) => l.dot !== "none").length);
  });

  it("puts what needs you first and marks it", () => {
    const live = [entry("pty-1", "working", "agent"), entry("chat-1", "needsYou", "chat A")];
    expect(trayEntries(live)[0].label).toBe("⚠ chat A (repo)");
    expect(trayEntries(live)[1].label).toBe("agent (repo)");
  });

  it("keeps a session with no dot out of the menu", () => {
    expect(trayEntries([entry("gone", "none", "ended chat")])).toEqual([]);
  });

  // A comparator that only ranks the waiting state must leave everything else
  // where it was, or the menu reshuffles whenever any unrelated status changes.
  it("does not reorder sessions that share a rank", () => {
    const live = [entry("a", "working", "A"), entry("b", "solid", "B"), entry("c", "hollow", "C")];
    expect(trayEntries(live).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("omits the project suffix when there is no project", () => {
    expect(trayEntries([entry("chat-1", "needsYou", "chat A", "")])[0].label).toBe("⚠ chat A");
  });
});
