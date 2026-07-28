import { describe, it, expect, afterEach } from "vitest";
import * as concurrency from "./chatConcurrency";
import { chatTabLabel, shouldNotice, MULTI_CHAT_NOTICE } from "./chatConcurrency";
import { chatsInFolder, dropLiveChat, setLiveChat } from "./chatSessions";

const REPO = "/work/repo";

const chat = (sessionId: string, folderPath = REPO) =>
  setLiveChat({ sessionId, sessionName: sessionId, folderPath, tabId: `tab:${sessionId}`, status: "idle", visible: false });

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

// The unreliable marker is retired: per-turn attribution is real now, so a
// worktree with two chats no longer shows one. The *notice* stays, because the
// working tree is still shared state and no attribution scheme changes that.
describe("the retired attribution marker", () => {
  afterEach(() => {
    dropLiveChat("a");
    dropLiveChat("b");
  });

  it("no longer exists as a predicate anything can render", () => {
    // Named explicitly rather than deleted silently: a reader looking for the
    // marker should find out it went away, and why.
    expect("attributionReliable" in concurrency).toBe(false);
    expect("ATTRIBUTION_UNRELIABLE_NOTE" in concurrency).toBe(false);
  });

  it("still notices a second chat on the worktree", () => {
    chat("a");
    expect(shouldNotice(chatsInFolder(REPO).length, REPO, new Set())).toBe(false);
    chat("b");
    expect(shouldNotice(chatsInFolder(REPO).length, REPO, new Set())).toBe(true);
  });

  it("says the tree is shared rather than that attribution is broken", () => {
    expect(MULTI_CHAT_NOTICE).toContain("share one working tree");
    expect(MULTI_CHAT_NOTICE).not.toContain("until per-turn attribution lands");
  });
});
