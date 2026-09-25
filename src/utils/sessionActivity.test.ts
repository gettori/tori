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
  sendNotification: () => {},
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "notify_needs_you") bridge.notified.push(args as { title: string });
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
  noteForgeUnits,
  notePtyActivity,
  probeBatch,
  refreshTailStates,
  sessionStatus,
  sessionDot,
  sessionCertainty,
  liveSessionDots,
  liveSessionStatuses,
  sessionFacts,
  shouldPollAccumulatedDiff,
  branchOwner,
  relayed,
  resetSessionActivityForTests,
} = await import("./sessionActivity");
const { trackFolders, resetSessionStoreForTests } = await import("./sessionStore");
const { setLiveChat, dropLiveChat } = await import("./chatSessions");
const { liveCounts, trayEntries } = await import("./presence");
type SessionStatus = import("./sessionStatus").SessionStatus;

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
  agent,
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

describe("the status a PTY agent tab composes to", () => {
  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.running = [];
    bridge.tail = null;
  });

  // An inert tab is a restored strip entry with nothing behind it. Reading it
  // as a live tab would turn a running session's dot solid ("we are driving
  // this") and suppress the hollow one that means "running, nobody on it".
  it("does not read an inert tab as a live one", async () => {
    await seedSessions([meta("s1", "main")]);
    noteLiveTabs([{ ...tab("t1", "s1"), state: "inert" as const }]);
    bridge.running = ["s1"];
    await probeBatch([{ id: "s1", agent: "claude" }]);

    expect(sessionDot("s1")).toBe("hollow");
  });

  it("reads a live tab as one, which is what makes the same session solid", async () => {
    await seedSessions([meta("s1", "main")]);
    noteLiveTabs([tab("t1", "s1")]);
    bridge.running = ["s1"];
    await probeBatch([{ id: "s1", agent: "claude" }]);

    expect(sessionDot("s1")).not.toBe("hollow");
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
    // The dot list is what the tray and the dock badge count, and it must not
    // gain a second copy of the chat now that the status list has one.
    expect(liveSessionDots().filter((s) => s.sessionId === "c1")).toHaveLength(1);
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
  const blocks = async (sessionId: string, name: string, status: SessionStatus = "waitingForApproval") => {
    setLiveChat({
      sessionId,
      sessionName: name,
      agentId: "claude",
      folderPath: FOLDER,
      tabId: `chat:${sessionId}`,
      visible: false,
      status,
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

  // The bug this pins: a question the agent asked reported as "executing", so
  // the dot never rose and nobody working in another space was told about it.
  it("fires for a question, not only for a permission prompt", async () => {
    noteAttention("something-else", true);
    await blocks("asked-e", "session E", "waitingForAnswer");
    expect(bridge.notified.map((n) => n.title)).toContain("session E");
    dropLiveChat("asked-e");
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

describe("a worker's needs-you", () => {
  const worker = (spawner?: string) => ({
    sessionId: "w",
    sessionName: "worker",
    agentId: "claude",
    folderPath: FOLDER,
    tabId: "chat:w",
    visible: false,
    status: "waitingForAnswer" as const,
    ...(spawner ? { spawner } : {}),
  });

  it("stays with the autopilot while it runs", () => {
    expect(relayed(worker("pilot"), new Set(), true)).toBe(true);
  });

  it("notifies once the autopilot that spawned it has stopped", () => {
    expect(relayed(worker("pilot"), new Set(), false)).toBe(false);
  });

  it("stays with a spawning chat that is still open", () => {
    expect(relayed(worker("chat-a"), new Set(["chat-a"]), false)).toBe(true);
  });

  it("is never relayed for a session nobody spawned", () => {
    expect(relayed(worker(), new Set(["chat-a"]), true)).toBe(false);
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
    bridge.notified = [];
  });

  // The plan's two named cases, and both are chat-free on purpose: the chat tier
  // reports its own status and would carry a needs-you here for reasons that
  // have nothing to do with CI, so a chat-based test proves nothing about the
  // path this feature actually has to travel
  // (`gotchas#only-the-pty-tier-can-starve-so-a-chat-based-needs-you-test-proves-nothing`).
  it("reaches a live PTY agent and a detached session alike", async () => {
    await seedSessions([meta("pty", "main"), meta("loose", "main")]);
    noteLiveTabs([tab("t1", "pty")]);
    bridge.running = ["pty", "loose"];
    await probeBatch([
      { id: "pty", agent: "claude" },
      { id: "loose", agent: "claude" },
    ]);

    // A quiet live agent is idle; a session with no tab at all caps at running.
    expect(sessionStatus("pty")).toBe("idle");
    expect(sessionStatus("loose")).toBe("running");

    noteForgeUnits([unit("main", true)]);

    expect(sessionStatus("pty")).toBe("waitingForApproval");
    expect(sessionStatus("loose")).toBe("waitingForApproval");
    // Inferred either way: the forge measured the branch, not the session, and
    // claiming otherwise would restyle every row this touches.
    expect(sessionCertainty("pty")).toBe("inferred");
  });

  it("leaves a session that is mid-turn alone", async () => {
    await seedSessions([meta("busy", "main")]);
    noteLiveTabs([tab("t1", "busy")]);
    bridge.running = ["busy"];
    await probeBatch([{ id: "busy", agent: "claude" }]);
    notePtyActivity("t1", "active");
    noteForgeUnits([unit("main", true)]);

    // The agent may well be fixing it, and an edge spent now cannot re-arm when
    // it stops - which is the moment the user actually needs telling.
    expect(sessionStatus("busy")).toBe("executing");
  });

  it("lands on the branch that failed, not on its sibling in the same folder", async () => {
    // A plain repo: both branch-units share one folder and are told apart only
    // by the branch each session recorded. This is the case where a second
    // attribution rule would put the warning on the wrong row.
    await seedSessions([meta("on-main", "main"), meta("on-feat", "feat")]);
    noteLiveTabs([tab("t1", "on-main"), tab("t2", "on-feat")]);
    bridge.running = ["on-main", "on-feat"];
    await probeBatch([
      { id: "on-main", agent: "claude" },
      { id: "on-feat", agent: "claude" },
    ]);

    noteForgeUnits([
      { folderPath: FOLDER, projectPath: FOLDER, branch: "main", kind: "plain", isCurrent: true, attention: false },
      { folderPath: FOLDER, projectPath: FOLDER, branch: "feat", kind: "plain", isCurrent: false, attention: true },
    ]);

    expect(sessionStatus("on-feat")).toBe("waitingForApproval");
    expect(sessionStatus("on-main")).toBe("idle");
  });

  // The verify that names the tier: a build wiring only the chat branch leaves
  // this at zero, because there is no chat anywhere in it.
  it("puts a PTY-tier failure in the tray and its counts", async () => {
    await seedSessions([meta("pty", "main")]);
    noteFolderOwners({ [FOLDER]: { spaceName: "work", projectName: "repo" } });
    noteLiveTabs([tab("t1", "pty")]);
    bridge.running = ["pty"];
    await probeBatch([{ id: "pty", agent: "claude" }]);

    expect(liveCounts(liveSessionDots()).needsYou).toBe(0);

    noteForgeUnits([unit("main", true)]);

    const live = liveSessionDots();
    expect(liveCounts(live)).toEqual({ running: 1, needsYou: 1 });
    // The tray marks a needs-you row and sorts it first; a count with no row to
    // click is the failure the merged list was built to end.
    expect(trayEntries(live)).toEqual([{ id: "pty", label: "⚠ title of pty (repo)" }]);
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
        { session: "c-idle", status: "idle", folder: FOLDER, visible: false, spawner: undefined, name: "the idle chat" },
      ],
      forge: [{ folderPath: FOLDER, kind: "worktree", branch: "main", isCurrent: false, attention: true }],
    });
    dropLiveChat("c-idle");
  });

  it("reaches no tray, badge or notification when nothing is running on it", async () => {
    // The sidebar chip is still red - that is the whole surface for a branch
    // nobody has open. Interrupting for it would mean a notification with no
    // session to take you to.
    await seedSessions([meta("cold", "main")]);
    noteForgeUnits([unit("main", true)]);
    await flush();

    expect(liveSessionDots()).toEqual([]);
    expect(liveCounts(liveSessionDots())).toEqual({ running: 0, needsYou: 0 });
    expect(trayEntries(liveSessionDots())).toEqual([]);
    expect(bridge.notified).toEqual([]);
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

    const mine = liveSessionStatuses().find((s) => s.sessionId === "c-budget");
    expect(mine?.status).toBe("budgetStopped");
    // And the dot is unchanged, which is the half the two do share: both mean
    // the session is going nowhere until a person acts.
    expect(liveSessionDots().find((d) => d.sessionId === "c-budget")?.dot).toBe("needsYou");
    dropLiveChat("c-budget");
  });

  it("does not notify twice while the check stays failing", async () => {
    await seedSessions([meta("pty", "main")]);
    noteLiveTabs([tab("t1", "pty")]);
    bridge.running = ["pty"];
    await probeBatch([{ id: "pty", agent: "claude" }]);

    noteForgeUnits([unit("main", true)]);
    await flush();
    expect(bridge.notified.length).toBe(1);

    // The next poll tick reports the same failure. It is a fresh array and a
    // fresh signal write, so the memos and the effect all re-run; only the
    // rising-edge test in `stepPresence` stops it being a second interruption.
    noteForgeUnits([unit("main", true)]);
    await flush();
    expect(bridge.notified.length, "a steady failure interrupted twice").toBe(1);

    // And it re-arms on a genuine recovery-then-failure, rather than going quiet
    // for the rest of the session.
    noteForgeUnits([unit("main", false)]);
    await flush();
    noteForgeUnits([unit("main", true)]);
    await flush();
    expect(bridge.notified.length).toBe(2);
  });
});

describe("the session that speaks for a branch", () => {
  // Who a review comment about a branch should reach. The attribution is
  // `belongsToUnit`, the same rule the CI raise above uses, because a plain
  // repo's sibling units share one folder and are told apart only by the branch
  // a session recorded.
  const plain = (branch: string | null) => ({
    folderPath: FOLDER,
    projectPath: FOLDER,
    branch,
    kind: "plain",
    isCurrent: branch === "main",
    attention: false,
  });

  beforeEach(() => {
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
  });

  it("picks the branch's own session, never a sibling sharing the folder", async () => {
    await seedSessions([meta("on-main", "main"), meta("on-feat", "feat")]);
    noteForgeUnits([plain("main"), plain("feat")]);

    expect(branchOwner(FOLDER, "feat")?.session.id).toBe("on-feat");
    expect(branchOwner(FOLDER, "main")?.session.id).toBe("on-main");
  });

  it("takes the most recent of several, not the first the scan happened to list", async () => {
    await seedSessions([
      { ...meta("old", "feat"), last_active: 10 },
      { ...meta("recent", "feat"), last_active: 90 },
      { ...meta("middling", "feat"), last_active: 50 },
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
    bridge.listing = [{ ...meta("in-wt", "feat"), cwd: wt, path: `${wt}/.t/in-wt.jsonl` }];
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

  it("works out the fallback home from this project's units, not every project's", async () => {
    // A session that recorded no branch (an older scan, or one started outside a
    // repo) re-homes onto its project's current checkout. `fallbackHome` decides
    // that from the sibling list, so handing it every watched unit lets another
    // project's current row claim the fallback and strand the session here.
    await seedSessions([meta("branchless", "")]);
    noteForgeUnits([
      // Listed first and current, so a sibling set that is not filtered by
      // folder picks *this* as the home for the units below it.
      { folderPath: "/other", projectPath: "/other", branch: "feat", kind: "plain", isCurrent: true, attention: false },
      plain("main"),
      plain("feat"),
    ]);

    expect(branchOwner(FOLDER, "main")?.session.id).toBe("branchless");
  });

  it("answers nothing rather than something close, for a branch nobody has worked", async () => {
    await seedSessions([meta("on-main", "main")]);
    noteForgeUnits([plain("main")]);
    expect(branchOwner(FOLDER, "feat")).toBeNull();
    expect(branchOwner(FOLDER, "")).toBeNull();
    expect(branchOwner("/some/other/repo", "main")).toBeNull();
  });
});
