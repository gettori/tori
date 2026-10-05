import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { wholeHistory } from "../../test/history";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
const channels: { onmessage?: (raw: unknown) => void }[] = [];
let recorded = { tokens: 0, costUsd: 0, turns: 0 };
let sendFails = false;
let budgetSettings: unknown = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (raw: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "chat_spawn":
        return Promise.resolve({
          ownership: { type: "granted", contested: false },
          spawned: "started",
          profileId: "default",
        });
      case "chat_history":
        return Promise.resolve(wholeHistory([]));
      case "chat_record_usage":
        return Promise.resolve({ session: recorded, project: recorded });
      case "chat_send":
        return sendFails ? Promise.reject(new Error("locked")) : Promise.resolve(null);
      case "get_settings":
        return Promise.resolve(budgetSettings);
      case "list_agents":
        return Promise.resolve(ADAPTERS);
      case "model_catalogs":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));

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

const ADAPTERS = [
  {
    id: "claude",
    label: "Claude",
    program: "claude",
    base_args: [],
    yolo_args: [],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat,
    usage: { sources: ["sessions"] },
  },
];

const { default: ChatView } = await import("./ChatView");
const { ensureAdaptersLoaded } = await import("../../utils/agents");
const { DEFAULT_SETTINGS, loadSettings } = await import("../Settings/settingsStore");
const { resetUsageStoreForTests } = await import("../../utils/usageStore");
const { FIRE_GRACE_MS, RESUME_ARMED, RESUME_STOPPED, armedFor, resetResumeAtResetForTests } =
  await import("./resumeAtReset");

// Spelled out in full: the settings store proxies `DEFAULT_SETTINGS` itself, so
// one test's switch would otherwise carry into the next.
const settingsWith = (o: { resumeAtReset?: boolean; sessionUsd?: number }) => ({
  ...DEFAULT_SETTINGS,
  chatDefaults: { ...DEFAULT_SETTINGS.chatDefaults, resumeAtReset: o.resumeAtReset ?? false },
  budgets: { sessionUsd: o.sessionUsd ?? null, projectUsd: null, contextPercent: null, warnAtFraction: 0.8 },
});

const HOURS = 3;
let resetsAt = 0;

const limited = (sessionId: string) => [
  {
    type: "turnStarted",
    sessionId,
    turnId: "t1",
    model: "claude-opus-5",
    permissionMode: "default",
    agentInitiated: false,
  },
  {
    type: "rateLimit",
    sessionId,
    status: "rejected",
    resetsAt,
    limitType: "five_hour",
    utilization: 1,
    windows: [{ kind: "five_hour", utilization: 1, resetsAt }],
    overageStatus: "rejected",
  },
  {
    type: "turnCompleted",
    sessionId,
    turnId: "t1",
    outcome: "errored",
    stopReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
    costUsd: 0,
    permissionDenials: [],
  },
];

beforeEach(async () => {
  invokes.length = 0;
  channels.length = 0;
  recorded = { tokens: 0, costUsd: 0, turns: 0 };
  sendFails = false;
  budgetSettings = settingsWith({});
  resetsAt = Math.floor(Date.now() / 1000) + HOURS * 60 * 60;
  resetUsageStoreForTests();
  resetResumeAtResetForTests();
  await ensureAdaptersLoaded();
  await loadSettings();
});
afterEach(() => vi.useRealTimers());

function mount(sessionId: string) {
  return render(() => (
    <ChatView
      sessionId={sessionId}
      tabId={`chat:${sessionId}`}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="claude"
      profile={null}
      title="chat"
      active={true}
      resume={false}
      started={true}
      onStart={() => {}}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
      onProfileResolved={() => {}}
    />
  ));
}

const sends = () => invokes.filter((i) => i.cmd === "chat_send");
const pastReset = () => vi.advanceTimersByTimeAsync(HOURS * 60 * 60 * 1000 + FIRE_GRACE_MS);

describe("the limit banner", () => {
  it("offers Resume at reset only in the chat whose own turn hit the limit", async () => {
    mount("s-a");
    mount("s-b");
    await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(2));
    for (const ev of limited("s-a")) channels[0].onmessage!(ev);

    await waitFor(() => expect(screen.getAllByText(/has been reached/)).toHaveLength(2));
    expect(screen.getAllByRole("button", { name: "Resume at reset" })).toHaveLength(1);
  });

  it("arms by itself with the setting on", async () => {
    budgetSettings = settingsWith({ resumeAtReset: true });
    await loadSettings();
    mount("s-a");
    await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(1));
    for (const ev of limited("s-a")) channels[0].onmessage!(ev);

    await screen.findByText(new RegExp(RESUME_ARMED));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("arms on the button, reads as armed, and disarms on cancel", async () => {
    mount("s-a");
    await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(1));
    for (const ev of limited("s-a")) channels[0].onmessage!(ev);

    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));
    await screen.findByText(new RegExp(RESUME_ARMED));
    expect(armedFor("s-a")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Resume at reset" });
    expect(armedFor("s-a")).toBeNull();
  });
});

describe("at the reset", () => {
  it("sends one limit-reset note", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount("s-a");
    await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(1));
    for (const ev of limited("s-a")) channels[0].onmessage!(ev);
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));

    await pastReset();

    await waitFor(() => expect(sends()).toHaveLength(1));
    const [block] = sends()[0].args.blocks as { text: string }[];
    expect(block.text).toMatch(/^<tori kind="limit-reset">\n/);
    // A Tori row, not words in the user's bubble.
    await screen.findByText("Tori continued after the usage limit reset");
    expect(screen.queryByText(/Continue where you left off/)).toBeNull();
  });

  it("does not send into a chat over its spend ceiling, and says so", async () => {
    budgetSettings = settingsWith({ sessionUsd: 1 });
    await loadSettings();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount("s-a");
    await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(1));
    recorded = { tokens: 10, costUsd: 5, turns: 1 };
    for (const ev of limited("s-a")) channels[0].onmessage!(ev);
    await screen.findByText(/will not start another turn/);
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));

    await pastReset();

    await screen.findByText(RESUME_STOPPED);
    expect(sends()).toHaveLength(0);
    expect(armedFor("s-a")).toBeNull();
  });

  it("drops the arm when the send is refused", async () => {
    sendFails = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount("s-a");
    await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(1));
    for (const ev of limited("s-a")) channels[0].onmessage!(ev);
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));

    await pastReset();

    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(armedFor("s-a")).toBeNull();
  });
});

describe("cancelling from the chat", () => {
  async function armed() {
    mount("s-a");
    await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(1));
    for (const ev of limited("s-a")) channels[0].onmessage!(ev);
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));
    await waitFor(() => expect(armedFor("s-a")).not.toBeNull());
  }

  it("clears the arm when the user sends", async () => {
    await armed();
    const box = await screen.findByRole("textbox");
    fireEvent.input(box, { target: { value: "never mind" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(armedFor("s-a")).toBeNull());
  });

  it("clears the arm when the session ends", async () => {
    await armed();
    channels[0].onmessage!({ type: "sessionEnded", sessionId: "s-a", reason: null });
    await waitFor(() => expect(armedFor("s-a")).toBeNull());
  });
});
