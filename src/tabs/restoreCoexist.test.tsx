// The two restore ceremonies, side by side (plan phase 6): a relaunch offers
// last run's terminal tabs (never spawning them unasked) while the same
// workspace's files come back silently. Both panels mount into one tree, the
// shape the two-pane shell gives them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
// The strip seeds its visible count from an empty item list and corrects it in a
// frame, so without this every lookup by tab role races that correction.
import { installAnimationFrame } from "../test/frames";
import { pointerClick } from "../test/menus";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

const REPO = "/space/proj/main";

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
// What `list_sessions` finds on disk. A restored chat names a stored session,
// and a session the scan cannot see is skipped as deleted rather than restored.
let storedSessions: { id: string; agent: string; cwd: string; path: string }[] = [];
// Tauri event listeners, so a test can fire `sessions://changed` and drive the
// backfill that runs on it.
const handlers: Record<string, (e: { payload: unknown }) => void> = {};
// What the backend is still holding, in each host's own key: chat by session
// id, PTY by frontend tab id. Both empty is a cold relaunch, where every stored
// tab comes back inert; populated is a webview reload, where the tabs they name
// come back live and re-subscribe.
let liveChats: string[] = [];
let livePtys: string[] = [];
// Folders that are gone since last run. A stored tab pointing at one is opened
// at home instead, so a deleted worktree never yields a tab whose spawn fails.
const missingPaths = new Set<string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "file_exists":
        return Promise.resolve(!missingPaths.has(String(args.path)));
      case "fs_read_dir":
        return Promise.resolve([]);
      case "list_sessions":
        return Promise.resolve(storedSessions);
      case "session_running":
        return Promise.resolve(false);
      case "chat_orphans":
        return Promise.resolve([]);
      case "chat_live_sessions":
        return Promise.resolve(liveChats);
      case "pty_live_ids":
        return Promise.resolve(livePtys);
      case "profile_spawn_env":
        if (args.profileId === null) return Promise.resolve({});
        return args.profileId === "fonn"
          ? Promise.resolve({ CLAUDE_CONFIG_DIR: "/homes/fonn" })
          : Promise.reject(`no profile \`${String(args.profileId)}\``);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    handlers[name] = fn;
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("../panels/Terminal/TerminalView", () => ({
  default: (props: { id: string }) => <div data-testid="pty" data-id={props.id} />,
}));
// `started` is the whole of what a restored chat is being tested for here, so
// the stand-in publishes it and offers the send that flips it. A chat surface
// mounts either way now; whether a child is behind it is the question.
vi.mock("../panels/Chat/ChatView", () => ({
  default: (props: { tabId: string; started: boolean; resume: boolean; onStart: () => void }) => (
    <div
      data-testid="chat"
      data-tab={props.tabId}
      data-started={String(props.started)}
      data-resume={String(props.resume)}
    >
      <button onClick={() => props.onStart()}>send</button>
    </div>
  ),
}));
vi.mock("../panels/Chat/ChatDraft", () => ({
  default: (props: { tabId: string; agentId: string }) => (
    <div data-testid="draft" data-tab={props.tabId} data-agent={props.agentId} />
  ),
}));
vi.mock("../panels/Editor/CodeEditor", () => ({ default: () => null }));
vi.mock("../panels/Editor/lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Terminal } = await import("../panels/Terminal/Terminal");
const { default: PaneView } = await import("./PaneView");
const { default: Editor } = await import("../panels/Editor/Editor");
const { open } = await import("../panels/Terminal/terminalTabStore");
const { emitWith, onWith, GIT_STAGE_ACTIVE, TOAST } = await import("../utils/events");
const { draftFor } = await import("../utils/chatCompose");
const { draftPick } = await import("../utils/chatDraftPick");
const { envelopeFor, resetPaneLayoutModel, seedTwoPane } = await import("../layout/layoutStore");
const { paneOfTab, resetTabPlacement, flushTabPlacement } = await import("../layout/tabPlacement");
const { visibleId, focusTab, setTabTitles } = await import("../panels/Terminal/terminalTabStore");
const { closeOf } = await import("../test/tabs");
const { forgetProfileEnvs } = await import("../utils/profileEnv");

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

beforeEach(() => {
  localStorage.clear();
  invokes.length = 0;
  storedSessions = [];
  liveChats = [];
  livePtys = [];
  missingPaths.clear();
  resetPaneLayoutModel();
  resetTabPlacement();
  forgetProfileEnvs();
});

/** A stored chat tab, and the on-disk session it names. */
const chatTab = (n: number) => {
  storedSessions.push({ id: `s-${n}`, agent: "claude", cwd: REPO, path: `/t/s-${n}.jsonl` });
  return { title: `chat ${n}`, cwd: REPO, kind: "chat", program: "claude", args: [], id: `chat:${n}`, sessionId: `s-${n}` };
};

/** A stored workspace, saved just now so nothing prunes it. */
const storeTabs = (tabs: unknown[], over: Record<string, unknown> = {}) =>
  localStorage.setItem(
    "tori.terminalTabs",
    JSON.stringify({ [REPO]: { tabs, active: 0, savedAt: Date.now(), ...over } }),
  );

const shell = (over: Record<string, unknown> = {}) => ({
  title: "shell",
  cwd: REPO,
  kind: "shell",
  program: "",
  args: [],
  ...over,
});

const restore = async () => {
  render(() => (
    <div>
      <Terminal selected={selection as never} onOpenChange={() => {}} />
      <PaneView pinKind="shell" />
    </div>
  ));
  // Nothing to press: restore runs on first visit to the workspace. It awaits
  // the backend liveness listing, so the tabs land a microtask or two after the
  // render rather than inside it.
  await waitFor(() => expect(open().length).toBeGreaterThan(0));
};

describe("restore, per pane", () => {
  it("restores last run's terminals and last run's files, both without asking", async () => {
    const now = Date.now();
    localStorage.setItem(
      "tori.terminalTabs",
      JSON.stringify({
        [REPO]: {
          tabs: [
            { title: "shell", cwd: REPO, kind: "shell", program: "", args: [] },
            { title: "claude", cwd: REPO, kind: "agent", program: "claude", args: [], sessionId: "s-1" },
          ],
          active: 0,
          savedAt: now,
        },
      }),
    );
    localStorage.setItem(
      "tori.editor.tabs.v1",
      JSON.stringify({
        [REPO]: { paths: [`${REPO}/src/a.ts`], active: `${REPO}/src/a.ts`, savedAt: now },
      }),
    );

    render(() => (
      <div>
        <Terminal selected={selection as never} onOpenChange={() => {}} />
        <Editor selected={selection as never} />
        <PaneView pinKind="shell" />
        <PaneView pinKind="file" />
      </div>
    ));

    // The terminal pane restores on its own, with no banner in the way. One
    // tab, not two: this fixture's `list_sessions` finds nothing, so the stored
    // agent tab is skipped as a session that no longer exists. What the strip
    // then costs is covered by the one-step tests further down.
    await waitFor(() => expect(open()).toHaveLength(1));
    expect(screen.queryByText(/from last time/)).toBeNull();

    // The file pane restored on its own: no banner, the stored file is open
    // and active (read through staging, which names the active tab).
    await waitFor(() => expect(screen.queryByText(/Open a file from the tree/)).toBeNull());
    emitWith(GIT_STAGE_ACTIVE, null);
    await waitFor(() => {
      const staged = invokes.filter((i) => i.cmd === "git_stage");
      expect(staged.length).toBe(1);
      expect(staged[0].args).toEqual({ projectPath: REPO, paths: ["src/a.ts"] });
    });
  });

  // A draft is the one tab with nothing behind it: no session to resume, no
  // shell to respawn. What comes back is what was in it, and the text and the
  // pick travel in the stored record rather than staying in the stores they
  // were typed into, since a restore that had to mint a fresh id could not
  // reach them there.
  it("brings an unsent draft back with its text and its pick, still unstarted", async () => {
    localStorage.setItem(
      "tori.terminalTabs",
      JSON.stringify({
        [REPO]: {
          tabs: [
            {
              title: "proj",
              cwd: REPO,
              kind: "chat",
              program: "claude",
              args: [],
              text: "half a thought",
              pick: { model: "sonnet", mode: "plan", effort: null },
            },
          ],
          active: 0,
          savedAt: Date.now(),
        },
      }),
    );

    render(() => (
      <div>
        <Terminal selected={selection as never} onOpenChange={() => {}} />
        <PaneView pinKind="shell" />
      </div>
    ));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.agent).toBe("claude");
    expect(draftFor(draft.dataset.tab!)).toBe("half a thought");
    expect(draftPick(draft.dataset.tab!)).toEqual({
      model: "sonnet",
      mode: "plan",
      effort: null,
      optionValues: {},
    });
    // Restored, not started: a draft that spawned on restore would be the eager
    // path back, with a process and a claim nobody asked for.
    expect(invokes.some((i) => i.cmd === "chat_spawn")).toBe(false);
    expect(screen.queryByTestId("chat")).toBeNull();
  });

  // The pick comes back for a *resumed* chat too, which is the half a session
  // cannot restore for itself. Measured on claude 2.1.251: `--resume` brings
  // the model back and reports it on `system/init`, and comes back on the
  // CLI's default permission mode with no effort level reported at all. So the
  // mode and the level reset on every reload until the tab carried them.
  it("brings back what a resumed chat was running, which its session cannot", async () => {
    const t = chatTab(1);
    storeTabs([{ ...t, pick: { model: "sonnet", mode: "plan", effort: "high", optionValues: {} } }]);

    await restore();

    const chat = await screen.findByTestId("chat");
    expect(draftPick(chat.dataset.tab!)).toEqual({
      model: "sonnet",
      mode: "plan",
      effort: "high",
      optionValues: {},
    });
  });

  // The half the restore above depends on: a *live* chat's pick has to reach the
  // store in the first place. It used to be dropped on the way out - the save
  // read the pick only for a chat with no child - so the record the resume
  // needs was never written, however faithfully it was read back.
  it("keeps writing a live chat's pick down, which is what a resume reads", async () => {
    const t = chatTab(1);
    storeTabs([{ ...t, pick: { model: "sonnet", mode: "plan", effort: "high", optionValues: {} } }]);
    liveChats = ["s-1"];

    await restore();
    // Live means the backend still holds the session, which is what makes this
    // tab take the branch the pick used to fall off.
    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat.dataset.started).toBe("true"));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tori.terminalTabs")!)[REPO].tabs[0].pick).toEqual({
        model: "sonnet",
        mode: "plan",
        effort: "high",
        optionValues: {},
      }),
    );
    // And not its text: a running conversation has the composer and the
    // transcript for that.
    expect("text" in JSON.parse(localStorage.getItem("tori.terminalTabs")!)[REPO].tabs[0]).toBe(false);
  });

  // A chat that has been opened to read holds unsent text the same way a draft
  // does: no child is carrying it, so the store is the only place it can wait.
  it("brings back what was typed at a restored chat that was never started", async () => {
    const t = chatTab(1);
    storeTabs([{ ...t, text: "where were we" }]);

    await restore();

    const chat = await screen.findByTestId("chat");
    expect(chat.dataset.started).toBe("false");
    expect(draftFor("chat:1")).toBe("where were we");
    // And is still stored after this run saves over it. The save is what a quit
    // lands on, and the tab is a chat with a session id now - the shape the old
    // rule dropped the text for.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tori.terminalTabs")!)[REPO].tabs[0].text).toBe(
        "where were we",
      ),
    );
  });
});

// An account is part of session identity, so a tab comes back on the one it ran
// on. The home *variable* is not stored: it is derived from the profile id at
// restore, so a profile moved or removed since cannot respawn a dead path.
describe("restore brings a tab back on its own account", () => {
  it("re-derives an agent tab's home variable from the stored profile id", async () => {
    storeTabs([shell({ id: "sh:1", kind: "agent", program: "claude", args: [], profile: "fonn" })]);

    await restore();

    expect(open()[0].profile).toBe("fonn");
    expect(open()[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/homes/fonn" });
    expect(invokes.some((i) => i.cmd === "profile_spawn_env" && i.args.profileId === "fonn")).toBe(true);
  });

  it("brings a chat tab back on its account, which chat_spawn resolves the env for", async () => {
    storeTabs([{ ...chatTab(1), profile: "fonn" }]);

    await restore();

    expect(open()[0].profile).toBe("fonn");
  });

  it("reads a tab stored before accounts existed as the default profile, and asks for its env", async () => {
    storeTabs([shell({ id: "sh:1", kind: "agent", program: "claude", args: [] })]);

    await restore();

    expect(open()[0].profile).toBeNull();
    expect(open()[0].env).toBeUndefined();
    expect(invokes.some((i) => i.cmd === "profile_spawn_env" && i.args.profileId === null)).toBe(true);
  });

  // The failure the whole feature exists to prevent: an empty env here would
  // start the agent on the user's own login under a label saying otherwise.
  it("drops a tab whose account has been removed rather than respawning it as default", async () => {
    storeTabs([
      shell({ id: "sh:1" }),
      shell({ id: "sh:2", kind: "agent", program: "claude", args: [], profile: "gone" }),
    ]);

    await restore();

    expect(open().map((t) => t.id)).toEqual(["sh:1"]);
  });
});

// A restored tab comes back as *itself*, under the id it was stored with. That
// id is what `tori.tabpanes.v1` keys placement on and what the backend's
// liveness listing answers in, so minting a fresh one on every restore threw
// both away.
describe("restore reuses the stored tab id", () => {
  it("brings a shell back under its own id rather than a fresh one", async () => {
    storeTabs([shell({ id: "sh:stored" })]);

    await restore();

    const pty = await screen.findByTestId("pty");
    expect(pty.dataset.id).toBe("sh:stored");
  });

  it("mints a fresh id for a store written before ids were kept", async () => {
    storeTabs([shell()]);

    await restore();

    const pty = await screen.findByTestId("pty");
    expect(pty.dataset.id).toMatch(/^sh:/);
  });

  // A store naming one id twice must still produce two tabs. `pty_spawn`
  // delivers a tab's `init` exactly once per id, so a second tab sharing one
  // would be seeded nothing and come back an empty shell.
  it("refuses a duplicate id within one restore, giving each entry its own tab", async () => {
    storeTabs([shell({ id: "sh:same", title: "one" }), shell({ id: "sh:same", title: "two" })]);

    await restore();

    // Read off the tab model, not the mounted surfaces: since lazy restore only
    // the tab in front has a surface, and what is under test here is that two
    // entries produced two distinct tabs.
    await waitFor(() => expect(open()).toHaveLength(2));
    const ids = open().map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("sh:same");
  });

  // Placement is keyed by tab id and nothing prunes it, so reusing the id is
  // the whole of what puts a hand-moved tab back in the pane it was moved to.
  it("puts a hand-moved tab back in the pane it was moved to", async () => {
    localStorage.setItem("tori.tabpanes.v1", JSON.stringify({ [REPO]: { tabs: { "sh:moved": "right" } } }));
    resetTabPlacement();
    storeTabs([shell({ id: "sh:moved" })]);

    await restore();

    const pty = await screen.findByTestId("pty");
    const root = envelopeFor(REPO, () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true })).layout;
    expect(paneOfTab(REPO, { id: pty.dataset.id!, kind: "shell" }, root)).toBe("right");
    // The pin rule sends a shell leftmost, so "right" is only reachable through
    // the stored entry: a fresh id would have gone home.
    expect(paneOfTab(REPO, { id: "sh:fresh", kind: "shell" }, root)).toBe("left");
  });

  it("refocuses by the stored active id, not by its position in the stored order", async () => {
    // The index deliberately disagrees: it is what an older build reads, and
    // the id has to win where both are present.
    storeTabs([shell({ id: "sh:a" }), shell({ id: "sh:b" })], { active: 0, activeId: "sh:b" });

    await restore();

    await waitFor(() => expect(visibleId()).toBe("sh:b"));
  });

  it("refocuses by the index for a store carrying no active id", async () => {
    storeTabs([shell({ id: "sh:a" }), shell({ id: "sh:b" })], { active: 1 });

    await restore();

    await waitFor(() => expect(visibleId()).toBe("sh:b"));
  });
});

// The lazy half (plan phase 2): a restored tab is a strip entry until it is
// reached for. `TerminalView` is mocked here, so a mounted `pty` host stands in
// for the `pty_spawn` it would issue - the surface existing at all is the thing
// under test.
describe("a restored tab is inert until it is reached for", () => {
  const sixShells = () => [0, 1, 2, 3, 4, 5].map((n) => shell({ id: `sh:${n}`, title: `sh ${n}` }));

  it("mounts one surface for the active tab and none for the rest", async () => {
    storeTabs(sixShells(), { activeId: "sh:3" });

    await restore();

    await waitFor(() => expect(open()).toHaveLength(6));
    // Six entries in the strip, one surface: the other five are records.
    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(1));
    expect(screen.getByTestId("pty").dataset.id).toBe("sh:3");
  });

  it("spawns nothing when the active tab is a chat, which opens to read", async () => {
    storeTabs([0, 1, 2, 3, 4, 5].map(chatTab), { activeId: "chat:2" });

    await restore();

    await waitFor(() => expect(open()).toHaveLength(6));
    // One chat surface, the active one, and it is unstarted: the transcript is
    // read from disk and no child is behind it.
    const chats = await screen.findAllByTestId("chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]!.dataset.tab).toBe("chat:2");
    expect(chats[0]!.dataset.started).toBe("false");
    expect(screen.queryAllByTestId("pty")).toHaveLength(0);
    expect(invokes.some((i) => i.cmd === "chat_spawn")).toBe(false);
  });

  it("wakes a tab exactly one step when it is reached for, and no further", async () => {
    storeTabs(sixShells(), { activeId: "sh:0" });

    await restore();
    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(1));

    focusTab(REPO, "sh:4");

    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(2));
    // The first one is not torn down by looking away from it: that would be the
    // destroy gate a lazy surface must never become.
    expect(screen.getAllByTestId("pty").map((el) => el.dataset.id).sort()).toEqual(["sh:0", "sh:4"]);
  });

  // Nothing was ever spawned, so there is nothing to kill. Issuing `pty_kill`
  // anyway would be harmless today and a real bug the moment an id is reused,
  // which restore now does.
  it("kills nothing when an inert tab is closed, and forgets where it sat", async () => {
    localStorage.setItem("tori.tabpanes.v1", JSON.stringify({ [REPO]: { tabs: { "sh:1": "right" } } }));
    resetTabPlacement();
    storeTabs([shell({ id: "sh:0", title: "front" }), shell({ id: "sh:1", title: "spare" })], { activeId: "sh:0" });

    await restore();
    await waitFor(() => expect(open()).toHaveLength(2));
    invokes.length = 0;

    fireEvent.click(await waitFor(() => closeOf("spare")));

    await waitFor(() => expect(open().map((t) => t.id)).toEqual(["sh:0"]));
    expect(invokes.filter((i) => i.cmd === "pty_kill")).toEqual([]);
    expect(invokes.filter((i) => i.cmd === "chat_close")).toEqual([]);
    flushTabPlacement();
    expect(JSON.parse(localStorage.getItem("tori.tabpanes.v1")!)[REPO].tabs["sh:1"]).toBeUndefined();
  });

  // The live tab is the control: the same close on a tab that was reached for
  // must still kill its PTY, or this stops being laziness and starts being a leak.
  it("still kills the PTY of a tab that was reached for", async () => {
    storeTabs([shell({ id: "sh:0", title: "front" })], { activeId: "sh:0" });

    await restore();
    await screen.findByTestId("pty");
    invokes.length = 0;

    fireEvent.click(await waitFor(() => closeOf("front")));

    await waitFor(() => expect(invokes.filter((i) => i.cmd === "pty_kill")).toHaveLength(1));
  });

  // The concurrent-chat cap counts `liveChats()`, which only `ChatView` writes
  // to, from inside itself. A restored chat that never mounts one therefore
  // cannot be counted - so ten of them under a cap of three say nothing. This
  // is a regression check on that chain, not new behaviour: what it pins is
  // that restore still mounts no `ChatView` it was not asked to.
  it("starts no chat child for ten restored chats, so none can reach the cap", async () => {
    storeTabs([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(chatTab), { activeId: "chat:0" });

    await restore();

    await waitFor(() => expect(open()).toHaveLength(10));
    const chats = await screen.findAllByTestId("chat");
    expect(chats.map((el) => el.dataset.started)).toEqual(["false"]);
  });

  // `backfillFreshSessions` attributes a session that appeared after a fresh
  // agent tab spawned. An inert tab spawned nothing, and carries no
  // `spawnedAt` - so its `?? 0` floor would make *every* unclaimed session in
  // the folder younger than it, and the tab would take the first one.
  //
  // The two halves run the same fixture with the agent tab inert and then
  // reached for, so the second is the proof that the first is not passing for
  // some unrelated reason.
  const backfillFixture = (activeId: string) => {
    // `created_at` matters: the backfill compares it against the tab's
    // `spawnedAt`, and a session with none would be refused for that reason
    // instead of the one under test.
    storedSessions = [{ id: "s-stranger", agent: "claude", cwd: REPO, path: "/t/s.jsonl", created_at: 1 } as never];
    storeTabs(
      [
        { title: "claude", cwd: REPO, kind: "agent", program: "claude", args: [], id: "sh:agent" },
        shell({ id: "sh:x", title: "front" }),
      ],
      { activeId },
    );
  };
  const agentTabSession = () => open().find((t) => t.id === "sh:agent")?.sessionId;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("does not let an inert agent tab claim an unrelated session", async () => {
    backfillFixture("sh:x");

    await restore();
    await waitFor(() => expect(open()).toHaveLength(2));
    handlers["sessions://changed"]!({ payload: null });
    await settle();
    await settle();

    expect(agentTabSession()).toBeUndefined();
  });

  it("still lets a reached-for agent tab claim it, so the case above is real", async () => {
    backfillFixture("sh:agent");

    await restore();
    await waitFor(() => expect(open()).toHaveLength(2));
    handlers["sessions://changed"]!({ payload: null });

    await waitFor(() => expect(agentTabSession()).toBe("s-stranger"));
  });

  // The transition Phase 3 is for: a restored chat opens to read, and the first
  // send is what starts it - on the session id it already has, never a fresh
  // one, or the conversation on screen would not be the one the child resumes.
  it("starts an opened chat on its own session, and only on a first send", async () => {
    storeTabs([chatTab(1)]);

    await restore();
    const chat = await screen.findByTestId("chat");
    expect(chat.dataset.started).toBe("false");
    expect(chat.dataset.resume).toBe("true");

    fireEvent.click(screen.getByText("send"));

    await waitFor(() => expect(screen.getByTestId("chat").dataset.started).toBe("true"));
    // Same tab, so the same session id: a mint would have replaced the record.
    expect(screen.getByTestId("chat").dataset.tab).toBe("chat:1");
    expect(open().find((t) => t.id === "chat:1")?.sessionId).toBe("s-1");
  });
});

// Phase 4: the two listings from phase 1 turn a reload into a reattach. A cold
// relaunch answers both empty and everything comes back inert; a reload names
// what it is still holding, and those tabs come back live.
describe("reload reattach", () => {
  // A mounted surface is the reattach: `pty_spawn` and `chat_spawn` both rewire
  // an id the backend already holds, so what has to happen on this side is that
  // the surface exists to do the asking. Both are stubbed here, so the mount is
  // what this suite can see and the rewire is the backend's own contract.
  const mountedPtys = () => screen.queryAllByTestId("pty").map((el) => el.dataset.id);
  const startedChats = () =>
    screen.queryAllByTestId("chat").filter((el) => el.dataset.started === "true").map((el) => el.dataset.tab);

  // A detached PTY's output is dropped rather than buffered, so a tab that
  // waited to be clicked would come back missing whatever ran meanwhile. The
  // shell here is not the active tab, and it comes up anyway.
  it("mounts every tab the backend still holds, clicked or not", async () => {
    storeTabs([chatTab(1), chatTab(2), shell({ id: "sh:1" })], { activeId: "chat:1" });
    liveChats = ["s-1", "s-2"];
    livePtys = ["sh:1"];

    await restore();

    await waitFor(() => expect(open()).toHaveLength(3));
    // Three surfaces for one tab on screen. Both chats are started, so each
    // asks for its own session rather than opening to read.
    await waitFor(() => expect(startedChats().sort()).toEqual(["chat:1", "chat:2"]));
    expect(mountedPtys()).toEqual(["sh:1"]);
  });

  // The control: same store, backend holding nothing. This is the cold relaunch
  // phases 2 and 3 built, and the reattach must not have broken it.
  it("leaves every tab inert when the backend holds nothing", async () => {
    storeTabs([chatTab(1), chatTab(2), shell({ id: "sh:1" })], { activeId: "chat:1" });

    await restore();

    await waitFor(() => expect(open()).toHaveLength(3));
    expect(mountedPtys()).toEqual([]);
    expect(startedChats()).toEqual([]);
    // One surface, the active tab's, and it opened to read rather than started.
    expect(screen.getAllByTestId("chat").map((el) => el.dataset.started)).toEqual(["false"]);
  });

  // A terminal is keyed by the tab id itself, so an id the backend never heard
  // of is a spawn and must stay inert until it is asked for.
  // A workspace is restored on first visit, which can be long after startup.
  // Reading the listing then, rather than reusing a startup answer, is what
  // stops a PTY that exited in between from being treated as held: that tab
  // would come back live, mount, find nothing to rewire and spawn a fresh one.
  it("asks again per restore, so a listing cannot go stale under it", async () => {
    storeTabs([shell({ id: "sh:0" }), shell({ id: "sh:1", title: "second" })], { activeId: "sh:0" });
    livePtys = ["sh:0", "sh:1"];

    render(() => (
      <div>
        <Terminal selected={selection as never} onOpenChange={() => {}} />
        <PaneView pinKind="shell" />
      </div>
    ));
    // The listing is read once per restore, so the reads outnumber the single
    // startup read `reportStranded` makes.
    await waitFor(() => expect(invokes.filter((i) => i.cmd === "pty_live_ids").length).toBeGreaterThan(1));
  });

  it("matches a terminal by tab id, so an unlisted one stays an entry", async () => {
    storeTabs(
      [shell({ id: "sh:active" }), shell({ id: "sh:kept", title: "kept" }), shell({ id: "sh:gone", title: "gone" })],
      { activeId: "sh:active" },
    );
    livePtys = ["sh:kept"];

    await restore();

    await waitFor(() => expect(open()).toHaveLength(3));
    // `sh:active` mounts because it is the tab on screen taking its one step,
    // `sh:kept` because the backend named it. `sh:gone` is neither.
    await waitFor(() => expect(mountedPtys().sort()).toEqual(["sh:active", "sh:kept"]));
  });
});

// Stranded: what the backend holds that no stored tab anywhere can reach.
describe("stranded processes", () => {
  const OTHER = "/space/proj/other";
  let said: string[] = [];
  let offToast: (() => void) | undefined;

  beforeEach(() => {
    said = [];
    offToast = onWith<{ message: string }>(TOAST, (e) => said.push(e.message));
  });
  afterEach(() => offToast?.());

  /** Two workspaces' tabs stored, only one of them ever visited. */
  const twoWorkspaces = () =>
    localStorage.setItem(
      "tori.terminalTabs",
      JSON.stringify({
        [REPO]: { tabs: [shell({ id: "sh:here" })], active: 0, savedAt: Date.now() },
        [OTHER]: { tabs: [shell({ id: "sh:there" })], active: 0, savedAt: Date.now() },
      }),
    );

  // The bug this is measured against: scoping the check to the workspace being
  // restored would call every other workspace's live session stranded, when
  // those come back the moment their workspace is looked at.
  it("says nothing about a live process whose workspace has not been visited", async () => {
    twoWorkspaces();
    livePtys = ["sh:here", "sh:there"];

    await restore();
    await waitFor(() => expect(open()).toHaveLength(1));

    expect(said.filter((m) => /still running/.test(m))).toEqual([]);
  });

  it("reports exactly the one whose stored record is gone", async () => {
    twoWorkspaces();
    // `sh:there` is live and stored; `sh:lost` is live and named by nothing.
    livePtys = ["sh:here", "sh:there", "sh:lost"];

    await restore();

    await waitFor(() => expect(said.filter((m) => /still running/.test(m))).toHaveLength(1));
    expect(said.find((m) => /still running/.test(m))).toMatch(/^1 process is still running/);
  });
});

// The two prunes a restore has always made, kept through four phases of change
// to what a restored tab is. Nothing here is new; it is here because an
// automatic restore is the one that most needs to say what it dropped, and
// neither prune had a test of its own before.
describe("what a restore drops, and what it says about it", () => {
  let said: string[] = [];
  let offToast: (() => void) | undefined;

  beforeEach(() => {
    said = [];
    offToast = onWith<{ message: string }>(TOAST, (e) => said.push(e.message));
  });
  afterEach(() => offToast?.());

  const restoreNotice = () => said.find((m) => m.startsWith("Restored tabs:"));

  it("brings back the rest when one stored session is gone, and counts it", async () => {
    // `chatTab(2)` is the only one whose session the scan finds: the first is
    // stored but was deleted since last run.
    const gone = { ...chatTab(1), sessionId: "s-deleted" };
    storeTabs([gone, chatTab(2)], { activeId: "chat:2" });

    await restore();

    await waitFor(() => expect(open().map((t) => t.id)).toEqual(["chat:2"]));
    await waitFor(() => expect(restoreNotice()).toBeTruthy());
    expect(restoreNotice()).toContain("1 session no longer exist");
  });

  it("opens a tab whose folder is gone at home, and counts that too", async () => {
    missingPaths.add(REPO);
    storeTabs([shell({ id: "sh:0" })], { activeId: "sh:0" });

    await restore();

    await waitFor(() => expect(open()).toHaveLength(1));
    // The tab still belongs to its workspace; only where it opens changed, so a
    // deleted worktree yields a usable shell rather than a dead pane.
    expect(open()[0]!.cwd).toBe("/home/me");
    expect(open()[0]!.workspace).toBe(REPO);
    await waitFor(() => expect(restoreNotice()).toBeTruthy());
    expect(restoreNotice()).toContain("1 folder missing, opened in your home directory");
  });

  // A restore is not a naming. `openChatTab` labels a *new* chat, so routing a
  // stored draft through it ran the title it had already been given back
  // through the label maker: "proj chat" came back as "proj chat chat", and
  // again on every launch. Invisible while restore was a button nobody pressed.
  it("brings a draft back under the name it already had, launch after launch", async () => {
    storeTabs([
      { title: "proj chat", cwd: REPO, kind: "chat", program: "claude", args: [], id: "chat:1" },
      { title: "proj chat 2", cwd: REPO, kind: "chat", program: "claude", args: [], id: "chat:2" },
    ]);

    await restore();

    await waitFor(() => expect(open()).toHaveLength(2));
    expect(open().map((t) => t.title)).toEqual(["proj chat", "proj chat 2"]);
  });

  it("says nothing when a restore drops nothing", async () => {
    storeTabs([shell({ id: "sh:0" })], { activeId: "sh:0" });

    await restore();

    await waitFor(() => expect(open()).toHaveLength(1));
    expect(restoreNotice()).toBeUndefined();
  });
});

// The action that replaces the banner's bulk decline. Said after the strip is
// there rather than as an answer to a question asked before it.
describe("closing every tab that was never started", () => {
  /** Open the launch menu and pick one of its rows by name. Every pane's strip
   *  draws its own, so the first is this test's. */
  const menuItem = async (name: string) => {
    pointerClick(screen.getAllByLabelText("Launch an agent session")[0]!);
    pointerClick(await screen.findByRole("menuitem", { name }));
  };

  it("leaves exactly the tabs that were reached for, and kills nothing", async () => {
    const twelve = [...Array(12).keys()].map((n) => shell({ id: `sh:${n}`, title: `shell ${n}` }));
    storeTabs(twelve, { activeId: "sh:0" });

    await restore();
    await waitFor(() => expect(open()).toHaveLength(12));
    // Two reached for: the stored active one, and one clicked.
    focusTab(REPO, "sh:5");
    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(2));

    await menuItem("Close 10 tabs not started");

    await waitFor(() => expect(open().map((t) => t.id).sort()).toEqual(["sh:0", "sh:5"]));
    // Nothing was started in the ten, so there was nothing to end.
    expect(invokes.filter((i) => i.cmd === "pty_kill")).toEqual([]);
    expect(invokes.filter((i) => i.cmd === "chat_close")).toEqual([]);
  });

  // A row that would do nothing is worse than no row.
  it("offers nothing once every tab has been started", async () => {
    storeTabs([shell({ id: "sh:0" })], { activeId: "sh:0" });

    await restore();
    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(1));

    pointerClick(screen.getAllByLabelText("Launch an agent session")[0]!);
    await screen.findByRole("menuitem", { name: "Terminal" });
    expect(screen.queryByRole("menuitem", { name: /not started/ })).toBeNull();
  });
});

// The launch race that grew the strip by one tab per reload.
//
// Restore is automatic and asynchronous, and the sidebar's saved selection is
// delivered on the same tick. So "does a tab already host this session?" was
// asked against a strip that was still empty and about to hold exactly that
// tab, and the answer opened a second one. The duplicate persists, so the next
// launch starts from two.
describe("a session selection delivered while the strip is still restoring", () => {
  const withSession = { ...selection, sessionId: "s-1", agent: "claude" };

  it("focuses the restored tab rather than opening a second one for it", async () => {
    storeTabs([chatTab(1)], { activeId: "chat:1" });

    render(() => (
      <div>
        <Terminal selected={withSession as never} onOpenChange={() => {}} />
        <PaneView pinKind="shell" />
      </div>
    ));

    await waitFor(() => expect(open().length).toBeGreaterThan(0));
    // Let the selection's own async routing finish before counting.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(open().map((t) => t.id)).toEqual(["chat:1"]);
    expect(open().filter((t) => t.sessionId === "s-1")).toHaveLength(1);
  });
});


// A chat tab has two titles: `t.title`, captured when the tab was made, and the
// `tabTitles` override that `syncTabTitles` and a rename write, which is what
// the strip actually renders. Persisting the first stored the label the chat was
// born with, "<session> chat" straight out of `chatTabLabel`, and dropped the
// session's real name on every save.
//
// It stayed invisible because the override lands a moment after the tab opens,
// so the wrong title was on screen for a frame and only the store kept it.
// Restore running on its own is what put it back on screen.
describe("the title a chat tab is saved under", () => {
  it("takes the session's current name, not the label the tab was born with", async () => {
    storedSessions.push({ id: "s-9", agent: "claude", cwd: REPO, path: "/t/s-9.jsonl", name: "Hello" } as never);
    storeTabs([
      { title: "Hello chat", cwd: REPO, kind: "chat", program: "claude", args: [], id: "chat:9", sessionId: "s-9" },
    ]);

    await restore();

    await waitFor(() => expect(open()).toHaveLength(1));
    // Healed on the way in, from the session restore was already looking up.
    expect(open()[0]!.title).toBe("Hello");
    // And saved that way, so the next launch starts from the right name.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tori.terminalTabs")!)[REPO].tabs[0].title).toBe("Hello"),
    );
  });

  it("keeps a live rename instead of writing the creation label back", async () => {
    storedSessions.push({ id: "s-8", agent: "claude", cwd: REPO, path: "/t/s-8.jsonl", name: "First" } as never);
    storeTabs([
      { title: "First", cwd: REPO, kind: "chat", program: "claude", args: [], id: "chat:8", sessionId: "s-8" },
    ]);

    await restore();
    await waitFor(() => expect(open()).toHaveLength(1));

    // A rename writes the override, never the tab record.
    setTabTitles((m) => ({ ...m, "chat:8": "Renamed" }));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tori.terminalTabs")!)[REPO].tabs[0].title).toBe("Renamed"),
    );
  });
});

// Continuing a session from the history list. The tab is named from the session
// itself, so what it says on the first frame is what it says a minute later.
// `chatTabLabel` used to run over it, appending " chat" until `syncTabTitles`
// arrived and took it back off.
describe("continuing a session from history", () => {
  const fromHistory = { ...selection, sessionId: "s-7", agent: "claude", sessionTitle: "Hello" };

  it("opens the tab under the session's own name, with nothing appended", async () => {
    storedSessions.push({ id: "s-7", agent: "claude", cwd: REPO, path: "/t/s-7.jsonl", name: "Hello" } as never);

    render(() => (
      <div>
        <Terminal selected={fromHistory as never} onOpenChange={() => {}} />
        <PaneView pinKind="shell" />
      </div>
    ));

    await waitFor(() => expect(open()).toHaveLength(1));
    // Read off the tab record, so this is the title from the very first frame
    // rather than whatever a later sync settled on.
    expect(open()[0]!.title).toBe("Hello");
    expect(open()[0]!.sessionId).toBe("s-7");
  });
});
