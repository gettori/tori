import { describe, it, expect, afterEach } from "vite-plus/test";
import { chatsInFolder, dropLiveChat, liveChats, setLiveChat, type LiveChat } from "./chatSessions";
import { pastCap } from "./chatConcurrency";

const chat = (sessionId: string, side?: string): LiveChat => ({
  sessionId,
  sessionName: sessionId,
  agentId: "claude",
  folderPath: "/repo",
  tabId: `tab-${sessionId}`,
  status: "idle",
  visible: false,
  side,
});

describe("a side chat among the live chats", () => {
  afterEach(() => {
    dropLiveChat("parent");
    dropLiveChat("side");
  });

  it("is not a second chat on the worktree, and still counts toward the cap", () => {
    setLiveChat(chat("parent"));
    setLiveChat(chat("side", "parent"));
    expect(chatsInFolder("/repo").map((c) => c.sessionId)).toEqual(["parent"]);
    const ids = liveChats().map((c) => c.sessionId);
    expect(pastCap("side", ids, 1)).toBe(true);
  });
});
