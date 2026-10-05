import { describe, it, expect, afterEach } from "vite-plus/test";
import * as concurrency from "./chatConcurrency";
import { capNotice, chatTabLabel, pastCap, shouldNotice, MULTI_CHAT_NOTICE } from "./chatConcurrency";
import { chatsInFolder, dropLiveChat, setLiveChat } from "./chatSessions";

const REPO = "/work/repo";

const chat = (sessionId: string, folderPath = REPO) =>
  setLiveChat({
    sessionId,
    sessionName: sessionId,
    agentId: "claude",
    folderPath,
    tabId: `tab:${sessionId}`,
    status: "idle",
    visible: false,
  });

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
    for (let i = 0; i < 3; i++) labels.push(chatTabLabel("tori", labels));
    expect(labels).toEqual(["tori chat", "tori chat 2", "tori chat 3"]);
  });

  it("does not hand out a number a still-open chat already has", () => {
    // Closing the first of three and opening another used to reuse "tori chat 2"
    // while the real one was still on screen.
    expect(chatTabLabel("tori", ["tori chat 2", "tori chat 3"])).toBe("tori chat");
    expect(chatTabLabel("tori", ["tori chat", "tori chat 3"])).toBe("tori chat 2");
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

describe("the concurrency cap", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);

  it("says nothing while the count is inside the cap", () => {
    const live = ids(4);
    expect(live.filter((id) => pastCap(id, live, 4))).toEqual([]);
  });

  it("warns in the chat that put the count past the line, not in the ones already running", () => {
    // The whole point of answering by position: opening a fifth chat must not
    // put a banner in the four that were there first.
    const live = ids(6);
    expect(live.filter((id) => pastCap(id, live, 4))).toEqual(["s4", "s5"]);
  });

  it("takes zero as no cap rather than as a cap of zero", () => {
    const live = ids(6);
    for (const cap of [0, -1]) {
      expect(live.filter((id) => pastCap(id, live, cap))).toEqual([]);
    }
  });

  it("stops warning as soon as a chat closes", () => {
    expect(pastCap("s4", ids(5), 4)).toBe(true);
    // s0 closed: the same session is now the fourth, and inside the cap.
    expect(pastCap("s4", ["s1", "s2", "s3", "s4"], 4)).toBe(false);
  });

  it("says nothing about a chat that is not live", () => {
    expect(pastCap("gone", ids(6), 4)).toBe(false);
  });

  // It warns rather than refusing, so the text has to carry both ways out or it
  // is a banner that only complains.
  it("names both remedies and the cost being paid", () => {
    const said = capNotice(6, 4);
    expect(said).toContain("6");
    expect(said).toContain("4");
    expect(said).toMatch(/close one/i);
    expect(said).toMatch(/settings/i);
    expect(said).toMatch(/token spend/i);
  });
});
