import { describe, it, expect, afterEach } from "vitest";
import { attributionReliable, chatTabLabel, shouldNotice } from "./chatConcurrency";
import { dropLiveChat, setLiveChat } from "./chatSessions";

const REPO = "/work/repo";

const chat = (sessionId: string, folderPath = REPO) =>
  setLiveChat({ sessionId, sessionName: sessionId, folderPath, tabId: `tab:${sessionId}`, status: "idle" });

describe("shouldNotice", () => {
  it("says nothing for the first chat on a worktree", () => {
    expect(shouldNotice(1, REPO, new Set())).toBe(false);
  });

  it("fires when a second chat opens on the same worktree", () => {
    expect(shouldNotice(2, REPO, new Set())).toBe(true);
  });

  it("stays dismissed per worktree once it has been seen", () => {
    expect(shouldNotice(3, REPO, new Set([REPO]))).toBe(false);
    expect(shouldNotice(2, "/work/other", new Set([REPO]))).toBe(true);
  });
});

describe("chatTabLabel", () => {
  it("gives three chats on one branch three distinguishable labels", () => {
    const labels: string[] = [];
    for (let i = 0; i < 3; i++) labels.push(chatTabLabel("sway", labels));
    expect(labels).toEqual(["sway chat", "sway chat 2", "sway chat 3"]);
  });

  it("does not hand out a number a still-open chat already has", () => {
    // Closing the first of three and opening another used to reuse "sway chat 2"
    // while the real one was still on screen.
    expect(chatTabLabel("sway", ["sway chat 2", "sway chat 3"])).toBe("sway chat");
    expect(chatTabLabel("sway", ["sway chat", "sway chat 3"])).toBe("sway chat 2");
  });
});

describe("attributionReliable", () => {
  afterEach(() => {
    dropLiveChat("a");
    dropLiveChat("b");
    dropLiveChat("c");
  });

  it("holds for a worktree with no chats or exactly one", () => {
    expect(attributionReliable(REPO)).toBe(true);
    chat("a");
    expect(attributionReliable(REPO)).toBe(true);
  });

  it("fails while two chats share one working tree", () => {
    chat("a");
    chat("b");
    expect(attributionReliable(REPO)).toBe(false);
  });

  it("is scoped to the worktree, not to chats anywhere", () => {
    chat("a");
    chat("c", "/work/other");
    expect(attributionReliable(REPO)).toBe(true);
  });

  it("recovers when the second chat closes", () => {
    chat("a");
    chat("b");
    dropLiveChat("b");
    expect(attributionReliable(REPO)).toBe(true);
  });
});
