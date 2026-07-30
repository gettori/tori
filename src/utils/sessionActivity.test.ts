import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The store's job is composing three measurements into one status, so the test
// drives the measurements and reads the status back. The golden fixture pins
// the pure decision (`sessionDot.ts`); what is checkable only here is that each
// input reaches it, and that a change to any one of them moves the answer.
const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  running: [] as string[],
  tail: null as string | null,
  listing: [] as unknown[],
  notified: [] as { title: string }[],
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (n: { title: string }) => bridge.notified.push(n),
  onAction: () => Promise.resolve(() => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_sessions") return Promise.resolve(bridge.listing);
    if (cmd === "sessions_running") return Promise.resolve(bridge.running);
    if (cmd === "session_tail_state") return Promise.resolve(bridge.tail);
    return Promise.resolve(null);
  },
}));

const FOLDER = "/work/repo";
const {
  noteLiveTabs,
  noteAttention,
  noteFolderOwners,
  notePtyActivity,
  probeBatch,
  refreshTailStates,
  sessionStatus,
  sessionCertainty,
  liveSessionDots,
  liveSessionStatuses,
  shouldPollAccumulatedDiff,
  resetSessionActivityForTests,
} = await import("./sessionActivity");
const { trackFolders, resetSessionStoreForTests } = await import("./sessionStore");
const { setLiveChat, dropLiveChat } = await import("./chatSessions");

// Effects inside the store's root are queued, and `notifyNeedsYou` awaits a
// permission check on top of that, so a notification lands two ticks out.
const flush = () => new Promise((r) => setTimeout(r, 0));


const meta = (id: string, branch: string, agent = "claude") => ({
  id,
  path: `${FOLDER}/.t/${id}.jsonl`,
  cwd: FOLDER,
  branch,
  title: `title of ${id}`,
  last_active: 1,
  created_at: 1,
  name: null,
  archived: false,
  agent,
});

const tab = (id: string, sessionId: string) => ({
  id,
  workspace: FOLDER,
  kind: "agent" as const,
  sessionId,
  agent: "claude" as const,
});

// Fill the session store the way a real scan would, so the memos below see the
// write and recompute. Seeding by mutating the map in place would leave them on
// a cached value and pass for the wrong reason.
async function seedSessions(list: ReturnType<typeof meta>[]) {
  bridge.listing = list;
  await trackFolders([FOLDER]);
  bridge.calls.length = 0;
}

describe("the status a PTY agent tab composes to", () => {
  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.running = [];
    bridge.tail = null;
  });

  it("moves with each of the three measurements in turn", async () => {
    await seedSessions([meta("s1", "main")]);
    noteLiveTabs([tab("t1", "s1")]);

    // Never probed: a live tab that is not confirmed running is "none", not
    // idle - the probe is what says the process exists at all.
    expect(sessionStatus("s1")).toBe("none");

    // 1. the probe lands.
    bridge.running = ["s1"];
    await probeBatch([{ id: "s1", agent: "claude" }]);
    expect(sessionStatus("s1")).toBe("idle");

    // 2. the PTY starts producing output.
    notePtyActivity("t1", "active");
    expect(sessionStatus("s1")).toBe("executing");

    // 3. it goes quiet, and the transcript tail says it is blocked. Needs-you
    //    takes both: either alone is a guess.
    bridge.tail = "blocked-candidate";
    notePtyActivity("t1", "quiet");
    await refreshTailStates();
    expect(sessionStatus("s1")).toBe("waitingForApproval");

    // and back down: the probe going false outranks everything below it.
    bridge.running = [];
    await probeBatch([{ id: "s1", agent: "claude" }]);
    expect(sessionStatus("s1")).toBe("none");
  });

  it("marks the inferred tier as inferred", async () => {
    await seedSessions([meta("s1", "main")]);
    noteLiveTabs([tab("t1", "s1")]);
    expect(sessionCertainty("s1")).toBe("inferred");
  });
});

describe("the two tiers in one list", () => {
  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.running = [];
  });
  afterEach(() => dropLiveChat("c1"));

  // A chat reports its own status exactly, so it needs none of the composition
  // above - but every consumer of "what is waiting on me" wants both tiers, and
  // a consumer that had to union them itself is a second place to disagree.
  //
  // Merging them here is what widened four consumers at once, so the fields
  // each of them keys on are asserted here rather than in four component
  // harnesses: `folderActors`' revert guard and CheckpointTimeline's revert
  // button read `status` + `folderPath`; Terminal's next-waiting jump and the
  // command palette's focus entry read `tabId`; the palette also shows
  // `sessionName`. This is where that contract is decided.
  it("carries a waiting chat exactly once, with what its consumers key on", async () => {
    await seedSessions([]);
    setLiveChat({
      sessionId: "c1",
      sessionName: "the chat",
      folderPath: FOLDER,
      tabId: "chat:1",
      visible: false,
      status: "waitingForApproval",
    });

    const mine = liveSessionStatuses().filter((s) => s.sessionId === "c1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      status: "waitingForApproval",
      folderPath: FOLDER,
      tabId: "chat:1",
      sessionName: "the chat",
    });
    // The dot list is what the tray and the dock badge count, and it must not
    // gain a second copy of the chat now that the status list has one.
    expect(liveSessionDots().filter((s) => s.sessionId === "c1")).toHaveLength(1);
  });

  // A chat hosted in a tab whose session also has a transcript would be in both
  // loops if the PTY half did not require an agent tab.
  it("does not also count a chat as a PTY tab", async () => {
    await seedSessions([meta("c1", "main")]);
    noteLiveTabs([{ id: "chat:1", workspace: FOLDER, kind: "chat", sessionId: "c1" }]);
    setLiveChat({
      sessionId: "c1",
      sessionName: "the chat",
      folderPath: FOLDER,
      tabId: "chat:1",
      visible: false,
      status: "executing",
    });
    expect(liveSessionStatuses().filter((s) => s.sessionId === "c1")).toHaveLength(1);
  });
});

describe("the metadata a live status carries", () => {
  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
  });

  // The rollup badges key off this. A tab descriptor carries no branch, so on a
  // plain repo - where every branch unit shares one folderPath - a status
  // without a recorded branch cannot be attributed to a row at all.
  it("joins the recorded branch and agent from the session store", async () => {
    await seedSessions([meta("s1", "feature-x", "claude")]);
    noteFolderOwners({ [FOLDER]: { spaceName: "work", projectName: "repo" } });
    noteLiveTabs([tab("t1", "s1")]);

    const s = liveSessionStatuses()[0];
    expect(s.recordedBranch).toBe("feature-x");
    expect(s.agent).toBe("claude");
    expect(s.sessionName).toBe("title of s1");
    expect(s.spaceName).toBe("work");
    expect(s.projectName).toBe("repo");
  });

  // A session with no transcript yet, or one that recorded no branch, has to
  // read as "no branch" rather than as the empty-string branch.
  it("leaves the branch absent rather than empty when none was recorded", async () => {
    await seedSessions([meta("s1", "")]);
    noteLiveTabs([tab("t1", "s1")]);
    expect(liveSessionStatuses()[0].recordedBranch).toBeUndefined();
  });
});

describe("the editor's accumulated-diff gate", () => {
  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.running = [];
    bridge.tail = null;
  });
  afterEach(() => dropLiveChat("c1"));

  it("polls for a mid-turn PTY session but not for a mid-turn chat", async () => {
    await seedSessions([meta("s1", "main")]);
    noteLiveTabs([tab("t1", "s1")]);
    bridge.running = ["s1"];
    await probeBatch([{ id: "s1", agent: "claude" }]);
    notePtyActivity("t1", "active");
    expect(sessionStatus("s1")).toBe("executing");
    expect(shouldPollAccumulatedDiff("s1")).toBe(true);

    // The chat reads as executing in exactly the same list, and is still not
    // polled: it renders its own diff per tool call from its event stream.
    setLiveChat({
      sessionId: "c1",
      sessionName: "the chat",
      folderPath: FOLDER,
      tabId: "chat:1",
      visible: true,
      status: "executing",
    });
    expect(liveSessionStatuses().find((s) => s.sessionId === "c1")?.status).toBe("executing");
    expect(shouldPollAccumulatedDiff("c1")).toBe(false);
  });

  it("polls for nothing when there is no selection", () => {
    expect(shouldPollAccumulatedDiff(null)).toBe(false);
    expect(shouldPollAccumulatedDiff(undefined)).toBe(false);
  });
});

// The store owns the OS notification now, and the one thing it cannot work out
// for itself is whether you are already looking at the session that blocked.
// That arrives through `noteAttention`, so the suppression rule is only as good
// as that push - which is precisely what moving it out of the sidebar put at
// risk.
describe("the needs-you notification", () => {
  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.notified = [];
  });

  // Distinct ids per case: the presence tracker fires on a *rising* edge, so
  // reusing one id would make the second case depend on the first's teardown.
  const blocks = async (sessionId: string, name: string) => {
    setLiveChat({
      sessionId,
      sessionName: name,
      folderPath: FOLDER,
      tabId: `chat:${sessionId}`,
      visible: false,
      status: "waitingForApproval",
    });
    await flush();
  };

  it("fires when the blocked session is not the one you are looking at", async () => {
    noteAttention("something-else", true);
    await blocks("blocked-a", "session A");
    expect(bridge.notified.map((n) => n.title)).toContain("session A");
    dropLiveChat("blocked-a");
  });

  it("stays quiet when you are focused on the session that blocked", async () => {
    noteAttention("blocked-b", true);
    await blocks("blocked-b", "session B");
    expect(bridge.notified.map((n) => n.title)).not.toContain("session B");
    dropLiveChat("blocked-b");
  });

  // Focus is half the signal: the same selection with the window in the
  // background is not "you are looking at it".
  it("fires for the selected session when the window is unfocused", async () => {
    noteAttention("blocked-c", false);
    await blocks("blocked-c", "session C");
    expect(bridge.notified.map((n) => n.title)).toContain("session C");
    dropLiveChat("blocked-c");
  });
});
