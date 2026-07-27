import { describe, it, expect, vi, afterEach } from "vitest";

const sessions = [
  { id: "chatted", agent: "claude", cwd: "/work/repo", name: "held by a chat" },
  { id: "detached", agent: "claude", cwd: "/work/repo", name: "someone's terminal" },
];

// `list_sessions` sees every transcript on disk, and `session_running`'s pgrep
// answers for a chat's child exactly as it does for a terminal's.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "list_sessions") return Promise.resolve(sessions);
    if (cmd === "session_running") return Promise.resolve(true);
    return Promise.resolve(null);
  },
}));

const { detachedCandidates, liveCandidates } = await import("./folderActors");
const { setLiveChat, dropLiveChat } = await import("./chatSessions");

describe("detachedCandidates", () => {
  afterEach(() => dropLiveChat("chatted"));

  it("reports both sessions when no chat holds either", async () => {
    const out = await detachedCandidates("/work/repo");
    expect(out.map((c) => c.sessionId).sort()).toEqual(["chatted", "detached"]);
  });

  it("leaves a chat-hosted session to the chat tier rather than reporting it twice", async () => {
    // The chat's own child answers the same pgrep probe. Reported by both tiers,
    // one session would appear as an exact "executing" blocker *and* as an
    // overridable "cannot verify" one, and the override would look like it
    // applied to a session we can see is mid-turn.
    setLiveChat({
      sessionId: "chatted",
      sessionName: "chat",
      folderPath: "/work/repo",
      tabId: "chat:1",
      status: "executing",
    });
    const detached = await detachedCandidates("/work/repo");
    expect(detached.map((c) => c.sessionId)).toEqual(["detached"]);
    expect(liveCandidates().map((c) => c.sessionId)).toEqual(["chatted"]);
  });
});
