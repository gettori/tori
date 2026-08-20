import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { installAnimationFrame } from "../../test/frames";
import { pointerClick } from "../../test/menus";

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
  annotations: [],
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
  prefs: {} as { agent?: string | null },
}));

vi.mock("../Settings/settingsStore", async (orig) => {
  const actual = await orig<typeof import("../Settings/settingsStore")>();
  return { ...actual, chatPrefs: () => bridge.prefs };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.invoked.push(cmd);
    if (cmd === "list_agents") return Promise.resolve(ADAPTERS);
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    if (cmd === "chat_orphans") return Promise.resolve([]);
    if (cmd === "refresh_agent_health") return Promise.resolve([]);
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
  default: (props: { agentId: string }) => <div data-testid="draft" data-agent={props.agentId} />,
}));

const { default: Terminal } = await import("./Terminal");
const { default: PaneView } = await import("../../tabs/PaneView");
const { agents } = await import("../../utils/agents");

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

function mount() {
  return render(() => (
    <>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Terminal selected={branchSelection as any} onOpenChange={() => {}} />
      <PaneView pinKind="shell" />
    </>
  ));
}

/** Open the launch menu and pick one of its rows by name. */
async function menuItem(name: string) {
  pointerClick(screen.getByLabelText("Launch an agent session"));
  pointerClick(await screen.findByRole("menuitem", { name }));
}

beforeEach(() => {
  bridge.invoked.length = 0;
  bridge.listeners.clear();
  bridge.prefs = {};
  localStorage.clear();
});

/** Mount, and wait for the adapters the draft's default is checked against. */
async function mountLoaded() {
  const r = mount();
  await waitFor(() => expect(agents()).toHaveLength(ADAPTERS.length));
  return r;
}

describe("the launch control", () => {
  it("opens a chat draft from the main half, spawning nothing", async () => {
    mount();
    fireEvent.click(screen.getByLabelText(`New chat in repo`));

    await waitFor(() => expect(screen.getAllByTestId("draft")).toHaveLength(1));
    // The draft surface, not the session one: a chat with a session id would
    // have mounted `ChatView` and taken a claim.
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(bridge.invoked).not.toContain("chat_spawn");
    expect(bridge.invoked).not.toContain("pty_spawn");
  });

  it("still opens a shell, from the menu the main half used to be", async () => {
    mount();
    await menuItem("Terminal");

    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(1));
    expect(screen.queryByTestId("draft")).toBeNull();
  });

  it("opens a draft from the menu's chat row too, on no named agent", async () => {
    mount();
    await menuItem("New chat");

    await waitFor(() => expect(screen.getAllByTestId("draft")).toHaveLength(1));
    expect(screen.queryByTestId("chat")).toBeNull();
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
