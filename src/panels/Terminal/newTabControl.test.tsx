import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { installAnimationFrame } from "../../test/frames";
import { pointerClick } from "../../test/menus";
import {
  COMPOSE_DRAFT,
  TOAST,
  emitWith,
  type ComposeDraft,
  type ToastEvent,
} from "../../utils/events";

// The tab strip's launch control, after the draft-first change: the main half
// makes a chat rather than a shell, and every route the main half no longer
// takes is in the menu beside it.
//
// The point of pinning it here is that "new chat" now means *draft*: no spawn,
// no session id, no claim. A regression that put the eager path back would look
// identical in the strip and be a process on the machine, so what is asserted is
// which surface mounted and that nothing was spawned.

const REPO = "/root/work/repo";

// Two chat-capable agents, which is the least it takes for "the harness the
// project last used" to be a question with a wrong answer.
const chat = {
  transport: "claude_stream_json",
  program: "claude",
  base_args: [],
  session_id_args: [],
  resume_args: [],
  model_args: [],
  effort_args: [],
  mode_args: [],
  add_dir_args: [],
  modes: [],
  effort: [],
  acp: { serve_client_fs: false },
};
const adapter = (id: string, label: string) => ({
  id,
  label,
  program: id,
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: null,
  pty_quiet_ms: 2000,
  chat: { ...chat, program: id },
});
const ADAPTERS = [adapter("claude", "Claude"), adapter("codex", "Codex")];

const bridge = vi.hoisted(() => ({
  invoked: [] as string[],
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  /** This project's remembered chat picks, as the settings store would answer. */
  prefs: {} as { agent?: string | null; profile?: string | null },
  /** The per-agent Settings default, the layer under the project's memory. */
  defaultProfiles: {} as Record<string, string>,
  /** Every call with its arguments, for the ones whose *account* is the point
   *  rather than the fact that they happened. */
  calls: [] as { cmd: string; args?: Record<string, unknown> }[],
  /** What a spawn wrote back as this project's memory. */
  remembered: [] as { path: string; prefs: Record<string, unknown> }[],
  /** The keys that memory was looked up under. A Topic spells its workspace
   *  and its active root differently, so which one is asked is the whole of
   *  whether a lock is read back where it was written. */
  prefsAsked: [] as string[],
  /** Which agents this install offers. Every launch route asks before it offers
   *  a row, so a bench with nothing enabled has no chat to open at all. */
  enabled: {} as Record<string, boolean>,
  /** Claude's accounts, as the health sweep enumerates them. Two of them is
   *  what makes the agent-terminal row a row per account. */
  profiles: [] as { id: string; label: string; signIn: string; account: null; apiKeySource: null }[],
}));

vi.mock("../Settings/settingsStore", async (orig) => {
  const actual = await orig<typeof import("../Settings/settingsStore")>();
  return {
    ...actual,
    chatPrefs: (path: string) => {
      bridge.prefsAsked.push(path);
      return bridge.prefs;
    },
    // A getter, because this factory runs once at module load and the enabled
    // map is set per test: spreading it here would freeze the first bench's
    // answer into every later one.
    get settings() {
      return {
        ...actual.settings,
        agent: { enabled: bridge.enabled, defaultProfiles: bridge.defaultProfiles },
      };
    },
    rememberChatPrefs: (path: string, prefs: Record<string, unknown>) => {
      bridge.remembered.push({ path, prefs });
    },
    settingsLoaded: () => true,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    bridge.invoked.push(cmd);
    bridge.calls.push({ cmd, args });
    if (cmd === "list_agents") return Promise.resolve(ADAPTERS);
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    if (cmd === "chat_orphans") return Promise.resolve([]);
    if (cmd === "agent_health" || cmd === "refresh_agent_health") {
      return Promise.resolve([
        {
          id: "claude",
          label: "Claude",
          program: "claude",
          status: "versionMatch",
          signIn: "signedIn",
          account: null,
          apiKeySource: null,
          path: "/usr/bin/claude",
          version: "2.1.231",
          verifiedAgainst: "claude 2.1.231",
          sessionsDir: null,
          sessionsDirExists: false,
          hooks: false,
          needsYou: false,
          overridePath: null,
          profiles: bridge.profiles,
        },
      ]);
    }
    if (cmd === "agent_hook_launch_args") return Promise.resolve([]);
    if (cmd === "profile_spawn_env") return Promise.resolve({ CLAUDE_CONFIG_DIR: "/homes/fonn" });
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    bridge.listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

vi.mock("./TerminalView", () => ({
  default: (props: { id: string; program: string }) => (
    <div data-testid="pty" data-program={props.program} />
  ),
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("../Chat/ChatDraft", () => ({
  default: (props: { agentId: string; profile: string | null }) => (
    <div data-testid="draft" data-agent={props.agentId} data-profile={props.profile ?? ""} />
  ),
}));

const { default: Terminal } = await import("./Terminal");
const { default: PaneView } = await import("../../tabs/PaneView");
const { agents } = await import("../../utils/agents");
const { refreshAgentHealth } = await import("../../utils/agentHealth");
const { forgetProfileEnvs } = await import("../../utils/profileEnv");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

const branchSelection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

function mount(selected: unknown = branchSelection) {
  return render(() => (
    <>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Terminal selected={selected as any} onOpenChange={() => {}} />
      <PaneView pinKind="shell" />
    </>
  ));
}

/** A Topic: the one selection whose workspace key and whose folder are
 *  different strings. */
const topicSelection = {
  ...branchSelection,
  kind: "topic",
  topicId: "f1",
  activeRoot: `${REPO}/.tori/worktrees/f1`,
  roots: [`${REPO}/.tori/worktrees/f1`],
};

/** Open the launch menu and pick one of its rows by name. */
async function menuItem(name: string) {
  pointerClick(screen.getByLabelText("Launch an agent session"));
  pointerClick(await screen.findByRole("menuitem", { name }));
}

beforeEach(() => {
  bridge.invoked.length = 0;
  bridge.calls.length = 0;
  bridge.remembered.length = 0;
  bridge.prefsAsked.length = 0;
  bridge.listeners.clear();
  bridge.prefs = {};
  bridge.defaultProfiles = {};
  bridge.enabled = { claude: true, codex: true };
  bridge.profiles = [];
  // The spawn env is memoized per (agent, account), so one test resolving fonn
  // would spare the next one the call this file reads the account off.
  forgetProfileEnvs();
  localStorage.clear();
});

/** Mount, and wait for the adapters the draft's default is checked against.
 *
 *  The sweep is re-read first because its store is module state with a
 *  once-per-run latch: without this, whichever accounts the *first* test in the
 *  file mounted with would answer for every test after it. */
async function mountLoaded(selected: unknown = branchSelection) {
  await refreshAgentHealth();
  const r = mount(selected);
  await waitFor(() => expect(agents()).toHaveLength(ADAPTERS.length));
  return r;
}

describe("the launch control", () => {
  // `mountLoaded` rather than `mount`: which agent a draft opens on is read off
  // the resolved adapter list now, and the control says "no agent enabled"
  // until that list has landed rather than guessing claude.
  it("opens a chat draft from the main half, spawning nothing", async () => {
    await mountLoaded();
    fireEvent.click(screen.getByLabelText(`New chat in repo`));

    await waitFor(() => expect(screen.getAllByTestId("draft")).toHaveLength(1));
    // The draft surface, not the session one: a chat with a session id would
    // have mounted `ChatView` and taken a claim.
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(bridge.invoked).not.toContain("chat_spawn");
    expect(bridge.invoked).not.toContain("pty_spawn");
  });

  // The whole point of the setting. The button greys out rather than opening a
  // draft on an agent the user has said they do not want offered, and the
  // reason it gives is the one they can act on.
  it("refuses a new chat when this install offers no agent", async () => {
    bridge.enabled = {};
    await mountLoaded();
    const button = screen.getByLabelText("New chat in repo") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByTestId("draft")).toBeNull();
  });

  it("still opens a shell, from the menu the main half used to be", async () => {
    mount();
    await menuItem("Terminal");

    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(1));
    expect(screen.queryByTestId("draft")).toBeNull();
  });

  // The main half is the only chat route in this control, so the menu must not
  // carry a second one: a row repeating its own button is what was removed.
  it("offers no chat row beside the button that already makes one", async () => {
    await mountLoaded();
    pointerClick(screen.getByLabelText("Launch an agent session"));

    await screen.findByRole("menuitem", { name: "Terminal" });
    expect(screen.queryByRole("menuitem", { name: "New chat" })).toBeNull();
  });

  // An agent tab runs as an account exactly the way a chat does. One row would
  // start whichever login Tori inherited while the menu said only "Claude".
  it("offers the agent terminal once per account", async () => {
    bridge.profiles = [
      { id: "default", label: "Default", signIn: "signedIn", account: null, apiKeySource: null },
      { id: "fonn", label: "Fonn", signIn: "signedIn", account: null, apiKeySource: null },
    ];
    await mountLoaded();
    pointerClick(screen.getByLabelText("Launch an agent session"));

    expect(await screen.findByRole("menuitem", { name: "Claude (Default, terminal)" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Claude (Fonn, terminal)" })).toBeTruthy();
  });

  // And says nothing about accounts on an install with one login, where naming
  // it would be a word for the only thing there is.
  it("names no account when there is only one", async () => {
    await mountLoaded();
    pointerClick(screen.getByLabelText("Launch an agent session"));

    // The note alone, with no account named: this install has one login.
    expect(await screen.findByRole("menuitem", { name: "Claude (terminal)" })).toBeTruthy();
  });

  it("spawns the account whose row was picked", async () => {
    bridge.profiles = [
      { id: "default", label: "Default", signIn: "signedIn", account: null, apiKeySource: null },
      { id: "fonn", label: "Fonn", signIn: "signedIn", account: null, apiKeySource: null },
    ];
    await mountLoaded();
    await menuItem("Claude (Fonn, terminal)");

    // The env is resolved from the profile id at every spawn rather than stored
    // on the tab, so asking for it at all is what says the account arrived.
    await waitFor(() => expect(bridge.invoked).toContain("profile_spawn_env"));
    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(1));
  });
});

// Settings has no Selection, so it describes a draft and Terminal decides where
// it lands. The event is the whole seam: without it, the panel would have to be
// told about workspaces for a reason that has nothing to do with them.
describe("a draft handed over from Settings", () => {
  it("opens one on the selected branch unit with the blocks already attached", async () => {
    await mountLoaded();
    const blocks = [
      { type: "fileRef", path: "/home/me/.claude/CLAUDE.md", startLine: null, endLine: null, text: null, label: "Instructions" },
      { type: "text", text: "Write my Claude instructions." },
    ];

    emitWith<ComposeDraft>(COMPOSE_DRAFT, { blocks: blocks as never });

    await waitFor(() => expect(screen.getAllByTestId("draft")).toHaveLength(1));
    // Offered, never sent: a draft with a claimed session id would have mounted
    // ChatView and spawned.
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(bridge.invoked).not.toContain("chat_spawn");
  });

  // Terminal keeps a guard of its own rather than trusting the sender's: the
  // panel read its root when it opened, and the selection can have moved since.
  it("says so and opens nothing for a selection with no folder", async () => {
    const toasts: string[] = [];
    window.addEventListener(TOAST, (e) => toasts.push((e as CustomEvent<ToastEvent>).detail.message));
    await mountLoaded({ ...topicSelection, activeRoot: null, roots: [], folderPath: "" });

    emitWith<ComposeDraft>(COMPOSE_DRAFT, { blocks: [{ type: "text", text: "hi" }] as never });

    await waitFor(() => expect(toasts).toContain("Select a project first"));
    expect(screen.queryByTestId("draft")).toBeNull();
  });
});

describe("which harness a new draft opens on", () => {
  it("is claude for a project that has never chatted", async () => {
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.agent).toBe("claude");
  });

  it("is the one this project last used", async () => {
    bridge.prefs = { agent: "codex" };
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.agent).toBe("codex");
  });

  // A settings file outlives the adapter that wrote it. `findAdapter` answers
  // claude for an id nothing declares, so an unchecked one would open a draft
  // wearing a name whose config it is not running.
  it("falls back when no adapter answers to the remembered one", async () => {
    bridge.prefs = { agent: "ghost" };
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.agent).toBe("claude");
  });
});

// And on which account, which is the same question one layer down: a model
// belongs to an account, so a draft that opened on the right agent and the
// wrong login would offer a list the send cannot run.
describe("which account a new session opens on", () => {
  const TWO = [
    { id: "default", label: "Default", signIn: "signedIn", account: null, apiKeySource: null },
    { id: "fonn", label: "Fonn", signIn: "signedIn", account: null, apiKeySource: null },
  ];

  it("is the one this project last used", async () => {
    bridge.profiles = TWO;
    bridge.prefs = { agent: "claude", profile: "fonn" };
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.profile).toBe("fonn");
  });

  // The agent tab reads the same memory: it runs as an account the way a chat
  // does, and a terminal that ignored the project's answer would be a second
  // rule for one question.
  it("is that account for the next agent tab too", async () => {
    bridge.profiles = TWO;
    bridge.prefs = { agent: "claude", profile: "fonn" };
    await mountLoaded();
    await menuItem("Claude (yolo)");

    await waitFor(() =>
      expect(
        bridge.calls.some(
          ({ cmd, args }) => cmd === "profile_spawn_env" && args?.profileId === "fonn",
        ),
      ).toBe(true),
    );
  });

  it("is this agent's Settings default for a project that has never chatted", async () => {
    bridge.profiles = TWO;
    bridge.defaultProfiles = { claude: "fonn" };
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.profile).toBe("fonn");
  });

  // The project's own answer wins, including when that answer is the login the
  // user already had: the two are told apart on disk for exactly this case.
  it("keeps a project on the inherited login over the Settings default", async () => {
    bridge.profiles = TWO;
    bridge.defaultProfiles = { claude: "fonn" };
    bridge.prefs = { agent: "claude", profile: "default" };
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.profile).toBe("");
  });

  // Removing an account leaves every project that named it pointing at nothing.
  // The draft falls through to the layer below rather than opening on an id no
  // home answers to.
  it("falls back when the remembered account is gone", async () => {
    bridge.profiles = TWO;
    bridge.prefs = { agent: "claude", profile: "removed-since" };
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.profile).toBe("");
  });

  // An install with one login says nothing about accounts anywhere else, and
  // this is the same rule at the spawn boundary: no account, no env.
  it("names no account on an install with one login", async () => {
    bridge.prefs = { agent: "claude", profile: "default" };
    await mountLoaded();
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.profile).toBe("");
  });
});

// The other half of the memory: a spawn writes what the next one reads. An
// agent tab records only the account, never the agent - which agent a project
// uses is what locking a chat answers, and a terminal opened beside one should
// not move it.
describe("what an agent tab remembers", () => {
  it("records the account it started on", async () => {
    bridge.profiles = [
      { id: "default", label: "Default", signIn: "signedIn", account: null, apiKeySource: null },
      { id: "fonn", label: "Fonn", signIn: "signedIn", account: null, apiKeySource: null },
    ];
    await mountLoaded();
    await menuItem("Claude (Fonn, terminal)");

    await waitFor(() => expect(bridge.remembered).toHaveLength(1));
    expect(bridge.remembered[0].prefs).toEqual({ profile: "fonn" });
    expect(bridge.remembered[0].prefs).not.toHaveProperty("agent");
  });

  // One slot per project, so an agent with nothing to tell apart must not
  // answer in it: "the default account" from a codex tab would be read back as
  // claude's answer and move the project off the login it had chosen.
  it("says nothing for an agent with one account", async () => {
    await mountLoaded();
    await menuItem("Claude (terminal)");

    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(1));
    expect(bridge.remembered).toEqual([]);
  });
});

// A Topic is the one workspace whose key and whose folder are different
// strings, so it is the only place "read it back where it was written" can be
// wrong. A chat lock has only the tab's workspace to write under, so that is
// the key every reader asks.
describe("where a project's memory is kept", () => {
  it("reads a Topic's under its workspace key, not its active root", async () => {
    await mountLoaded(topicSelection);
    fireEvent.click(screen.getByLabelText("New chat in repo"));

    await screen.findByTestId("draft");
    expect(bridge.prefsAsked).toContain("topic:f1");
    expect(bridge.prefsAsked).not.toContain(`${REPO}/.tori/worktrees/f1`);
  });

  it("writes an agent tab's under the same key", async () => {
    bridge.profiles = [
      { id: "default", label: "Default", signIn: "signedIn", account: null, apiKeySource: null },
      { id: "fonn", label: "Fonn", signIn: "signedIn", account: null, apiKeySource: null },
    ];
    await mountLoaded(topicSelection);
    await menuItem("Claude (Fonn, terminal)");

    await waitFor(() => expect(bridge.remembered).toHaveLength(1));
    expect(bridge.remembered[0].path).toBe("topic:f1");
  });
});
