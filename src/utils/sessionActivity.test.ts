import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Rust composes every dot (`rpc/dots.rs`, pinned by the golden fixtures there),
// so the test hands the store Rust's answer through `noteDots` and checks what
// each surface reads back from it.
const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  running: [] as string[],
  tail: null as string | null,
  listing: [] as unknown[],
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
  noteFolderOwners,
  noteForgeUnits,
  noteDots,
  sessionStatus,
  sessionCertainty,
  liveSessionStatuses,
  sessionFacts,
  shouldPollAccumulatedDiff,
  branchOwner,
  resetSessionActivityForTests,
} = await import("./sessionActivity");
const { trackFolders, resetSessionStoreForTests } = await import("./sessionStore");
const { setLiveChat, dropLiveChat } = await import("./chatSessions");
type SessionDot = import("./sessionStatus").SessionDot;
type SessionHome = import("./sessionStatus").SessionHome;

// What Rust sends on `sessions://dots`.
const rust = (id: string, dot: SessionDot, home: SessionHome | null = null, certainty: "exact" | "inferred" = "inferred") =>
  noteDots([{ id, dot, certainty, home }]);


const meta = (id: string, branch: string, agent = "claude", home?: SessionHome) => ({
  id,
  path: `${FOLDER}/.t/${id}.jsonl`,
  cwd: FOLDER,
  branch,
  title: `title of ${id}`,
  last_active: 1,
  created_at: 1,
  name: null,
  agent,
  ...(home ? { home } : {}),
});

const tab = (id: string, sessionId: string) => ({
  id,
  workspace: FOLDER,
  kind: "agent" as const,
  sessionId,
  agent: "claude" as const, state: "live" as const,
});

// Fill the session store the way a real scan would, so the memos below see the
// write and recompute. Seeding by mutating the map in place would leave them on
// a cached value and pass for the wrong reason.
async function seedSessions(list: ReturnType<typeof meta>[]) {
  bridge.listing = list;
  await trackFolders([FOLDER]);
  bridge.calls.length = 0;
}

describe("the status Rust composed", () => {
  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
  });

  it("follows each dot Rust sends for a PTY agent tab", async () => {
    await seedSessions([meta("s1", "main")]);
    noteLiveTabs([tab("t1", "s1")]);

    // Nothing composed yet reads as nothing running, not as idle.
    expect(sessionStatus("s1")).toBe("none");
    rust("s1", "solid");
    expect(sessionStatus("s1")).toBe("idle");
    rust("s1", "working");
    expect(sessionStatus("s1")).toBe("executing");
    rust("s1", "needsYou");
    expect(sessionStatus("s1")).toBe("waitingForApproval");
    rust("s1", "none");
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
  // agents: `folderActors`' revert guard and CheckpointTimeline's revert
  // button read `status` + `folderPath`; Terminal's next-waiting jump and the
  // command palette's focus entry read `tabId`; the palette also shows
  // `sessionName`. This is where that contract is decided.
  it("carries a waiting chat exactly once, with what its consumers key on", async () => {
    await seedSessions([]);
    setLiveChat({
      sessionId: "c1",
      sessionName: "the chat",
      agentId: "claude",
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
  });

  // A chat hosted in a tab whose session also has a transcript would be in both
  // loops if the PTY half did not require an agent tab.
  it("does not also count a chat as a PTY tab", async () => {
    await seedSessions([meta("c1", "main")]);
    noteLiveTabs([{ id: "chat:1", workspace: FOLDER, kind: "chat", sessionId: "c1", state: "live" }]);
    setLiveChat({
      sessionId: "c1",
      sessionName: "the chat",
      agentId: "claude",
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
  // without the unit Rust placed it under cannot be attributed to a row at all.
  it("joins the unit row and agent Rust and the session store know", async () => {
    const home = { project: FOLDER, folder: FOLDER, branch: "feature-x" };
    await seedSessions([meta("s1", "feature-x", "claude")]);
    noteFolderOwners({ [FOLDER]: { spaceName: "work", projectName: "repo" } });
    noteLiveTabs([tab("t1", "s1")]);
    rust("s1", "solid", home);

    const s = liveSessionStatuses()[0];
    expect(s.home).toEqual(home);
    expect(s.agent).toBe("claude");
    expect(s.sessionName).toBe("title of s1");
    expect(s.spaceName).toBe("work");
    expect(s.projectName).toBe("repo");
  });

  // A session no unit holds reads as having no row rather than borrowing one.
  it("leaves the unit absent when no unit holds the session", async () => {
    await seedSessions([meta("s1", "")]);
    noteLiveTabs([tab("t1", "s1")]);
    expect(liveSessionStatuses()[0].home).toBeNull();
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
    rust("s1", "working");
    expect(sessionStatus("s1")).toBe("executing");
    expect(shouldPollAccumulatedDiff("s1")).toBe(true);

    // The chat reads as executing in exactly the same list, and is still not
    // polled: it renders its own diff per tool call from its event stream.
    setLiveChat({
      sessionId: "c1",
      sessionName: "the chat",
      agentId: "claude",
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

// The forge's half of the needs-you pipeline.
//
// A failing check is a fact about a *branch*; needs-you is a fact about a
// *session*. Joining them is the whole of this feature, and the join is the part
// that can be silently wrong: the sidebar chip would still be red, the tray
// would just never mention it, and nothing in a passing suite would say so.
describe("a failing check on the branch a session owns", () => {
  // A worktree unit: one branch, one folder of its own.
  const unit = (branch: string, attention: boolean) => ({
    folderPath: FOLDER,
    projectPath: FOLDER,
    branch,
    kind: "worktree",
    isCurrent: false,
    attention,
  });

  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.running = [];
    bridge.tail = null;
  });

  it("hands Rust the raw facts, with no dot composed", async () => {
    await seedSessions([meta("pty", "main")]);
    noteLiveTabs([tab("t1", "pty")]);
    setLiveChat({
      sessionId: "c-idle",
      sessionName: "the idle chat",
      agentId: "claude",
      folderPath: FOLDER,
      tabId: "chat:idle",
      visible: false,
      status: "idle",
    });
    noteForgeUnits([unit("main", true)]);

    expect(sessionFacts()).toEqual({
      tabs: [{ id: "t1", session: "pty", live: true, workspace: FOLDER, agent: "claude" }],
      chats: [
        { session: "c-idle", status: "idle", folder: FOLDER, visible: false, spawner: undefined, name: "the idle chat", doneAt: 0 },
      ],
      forge: [{ folderPath: FOLDER, kind: "worktree", branch: "main", isCurrent: false, attention: true }],
    });
    dropLiveChat("c-idle");
  });

  // The raise runs the chat tier's status through the dot vocabulary, and that
  // trip is lossy on purpose: `budgetStopped` and `waitingForApproval` share one
  // dot. Only one of them comes back, so a chat stopped at a spend ceiling would
  // arrive in the shared list telling the user to answer a prompt that does not
  // exist - the exact collapse `budgetStopped` was added to prevent.
  it("does not flatten a budget-stopped chat on its way through the raise", async () => {
    await seedSessions([]);
    setLiveChat({
      sessionId: "c-budget",
      sessionName: "the stopped chat",
      agentId: "claude",
      folderPath: FOLDER,
      tabId: "chat:budget",
      visible: false,
      status: "budgetStopped",
    });
    noteForgeUnits([unit("main", true)]);
    rust("c-budget", "needsYou", null, "exact");

    const mine = liveSessionStatuses().find((s) => s.sessionId === "c-budget");
    expect(mine?.status).toBe("budgetStopped");
    dropLiveChat("c-budget");
  });
});

describe("the session that speaks for a branch", () => {
  // Who a review comment about a branch should reach. The attribution is the
  // unit row Rust stamps on each listed session, because a plain repo's sibling
  // units share one folder and are told apart only by the branch a session
  // recorded.
  const plain = (branch: string | null) => ({
    folderPath: FOLDER,
    projectPath: FOLDER,
    branch,
    kind: "plain",
    isCurrent: branch === "main",
    attention: false,
  });
  const at = (branch: string) => ({ project: FOLDER, folder: FOLDER, branch });

  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
  });

  it("picks the branch's own session, never a sibling sharing the folder", async () => {
    await seedSessions([meta("on-main", "main", "claude", at("main")), meta("on-feat", "feat", "claude", at("feat"))]);
    noteForgeUnits([plain("main"), plain("feat")]);

    expect(branchOwner(FOLDER, "feat")?.session.id).toBe("on-feat");
    expect(branchOwner(FOLDER, "main")?.session.id).toBe("on-main");
  });

  it("takes the most recent of several, not the first the scan happened to list", async () => {
    await seedSessions([
      { ...meta("old", "feat", "claude", at("feat")), last_active: 10 },
      { ...meta("recent", "feat", "claude", at("feat")), last_active: 90 },
      { ...meta("middling", "feat", "claude", at("feat")), last_active: 50 },
    ]);
    noteForgeUnits([plain("feat")]);
    expect(branchOwner(FOLDER, "feat")?.session.id).toBe("recent");
  });

  it("answers from a worktree's own folder, which is not the project's path", async () => {
    // The case that makes `projectPath` load-bearing. A worktree project's units
    // each have a checkout of their own, so the directory a panel is showing is
    // one unit's folder and not the project it belongs to. Resolving the sibling
    // set by that folder alone would find one unit and never the branch asked
    // about.
    const wt = `${FOLDER}/.worktrees/feat`;
    bridge.listing = [
      { ...meta("in-wt", "feat", "claude", { project: FOLDER, folder: wt, branch: "feat" }), cwd: wt, path: `${wt}/.t/in-wt.jsonl` },
    ];
    await trackFolders([wt]);
    noteForgeUnits([
      { folderPath: FOLDER, projectPath: FOLDER, branch: "main", kind: "worktree", isCurrent: true, attention: false },
      { folderPath: wt, projectPath: FOLDER, branch: "feat", kind: "worktree", isCurrent: false, attention: false },
    ]);

    const owner = branchOwner(FOLDER, "feat");
    expect(owner?.session.id).toBe("in-wt");
    // The folder the message must be composed against: the unit's, not the one
    // the caller happened to name.
    expect(owner?.folderPath).toBe(wt);
    expect(branchOwner(wt, "feat")?.session.id).toBe("in-wt");
  });

  it("answers nothing rather than something close, for a branch nobody has worked", async () => {
    await seedSessions([meta("on-main", "main", "claude", at("main"))]);
    noteForgeUnits([plain("main")]);
    expect(branchOwner(FOLDER, "feat")).toBeNull();
    expect(branchOwner(FOLDER, "")).toBeNull();
    expect(branchOwner("/some/other/repo", "main")).toBeNull();
  });
});
