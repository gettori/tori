// What a chat shows about its account's quota.
//
// The thing under test is the account/session split: a quota window belongs to
// the login, not to a conversation, so a chat that has never run a turn still
// has to say a sibling chat hit the wall. The predecessor read this session's
// own last `rate_limit_event`, which made the answer depend on which tab you
// happened to be looking at.
//
// `ChatView` is mounted for real, like `openedChat.test.tsx`: the wiring from
// the event to the account store to the surface *is* the thing being asserted.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
/** Every `Channel` a mounted ChatView opened, newest last, so a test can push a
 *  frame down one chat and assert on the other. */
const channels: { onmessage?: (raw: unknown) => void }[] = [];

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
        return Promise.resolve({ ownership: { type: "granted", contested: false }, spawned: "started", profileId: "default" });
      case "chat_history":
        return Promise.resolve([]);
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
  },
];

const { default: ChatView } = await import("./ChatView");
const { ensureAdaptersLoaded } = await import("../../utils/agents");
const { DEFAULT_SETTINGS, loadSettings } = await import("../Settings/settingsStore");
const { resetUsageStoreForTests } = await import("../../utils/usageStore");
const { default: styles } = await import("./Chat.module.css");

/** Far enough out that nothing under test expires by accident. */
const RESETS_AT = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
const PASSED = Math.floor(Date.now() / 1000) - 60;

const rateLimit = (sessionId: string, utilization: number, resetsAt = RESETS_AT, status = "allowed") => ({
  type: "rateLimit",
  sessionId,
  status,
  resetsAt,
  limitType: "five_hour",
  utilization,
  windows: [{ kind: "five_hour", utilization, resetsAt }],
  overageStatus: null,
});

beforeEach(async () => {
  invokes.length = 0;
  channels.length = 0;
  resetUsageStoreForTests();
  await ensureAdaptersLoaded();
  await loadSettings();
});

function mount(sessionId: string, tabId: string) {
  return render(() => (
    <ChatView
      sessionId={sessionId}
      tabId={tabId}
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

/** Both chats mounted on one account, and both channels wired. */
async function mountTwo() {
  const a = mount("s-a", "chat:a");
  const b = mount("s-b", "chat:b");
  await waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(2));
  return { a, b, chanA: channels[0], chanB: channels[1] };
}

describe("the reached banner", () => {
  // The account/session split, stated as plainly as it can be: the chat that
  // renders the banner never saw a frame.
  it("shows in a chat with no turns when a sibling on the account reported it", async () => {
    const { chanA } = await mountTwo();

    chanA.onmessage!(rateLimit("s-a", 1));

    const banners = await screen.findAllByText(/rolling 5-hour limit has been reached/);
    expect(banners).toHaveLength(2);
    for (const b of banners) expect(b.closest("div")!.className).toContain(styles.bannerReached);
  });

  it("shows nothing while the account is under the threshold", async () => {
    const { chanA } = await mountTwo();

    chanA.onmessage!(rateLimit("s-a", 0.15));

    await waitFor(() => expect(invokes.filter((i) => i.cmd === "chat_spawn")).toHaveLength(2));
    expect(screen.queryByText(/limit has been reached/)).toBeNull();
    expect(screen.queryByText(/You have used/)).toBeNull();
  });

  // The transition nothing sends an event for. A reached limit refuses turns, so
  // no further `rate_limit_event` arrives; a banner recomputed only when a
  // reading lands would still say "reached" hours after the reset cleared it.
  it("comes down on the clock when the window resets, with no event to say so", async () => {
    vi.useFakeTimers();
    try {
      const soon = Math.floor(Date.now() / 1000) + 30;
      const { chanA } = await mountTwo();

      chanA.onmessage!(rateLimit("s-a", 1, soon));
      await waitFor(() => expect(screen.getAllByText(/has been reached/)).toHaveLength(2));

      // Past the reset, and past one tick of the panel's own clock. Nothing else
      // happens: no frame, no send, no re-render from anywhere.
      await vi.advanceTimersByTimeAsync(90_000);

      expect(screen.queryByText(/has been reached/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Past its reset the level is a memory. A banner drawn from it would sit on a
  // quota that has since emptied, with no event coming to take it down.
  it("shows nothing for a full window whose reset has passed", async () => {
    const { chanA } = await mountTwo();

    chanA.onmessage!(rateLimit("s-a", 1, PASSED, "rejected"));

    await waitFor(() => expect(invokes.filter((i) => i.cmd === "chat_spawn")).toHaveLength(2));
    expect(screen.queryByText(/limit has been reached/)).toBeNull();
    expect(screen.queryByText(/has reset/)).toBeNull();
  });
});

describe("the approaching notice", () => {
  // Once per chat, not once per event: a frame fires on every turn boundary, so
  // an undeduped notice would fill the transcript with the same sentence.
  it("lands once in every open chat however many events repeat it", async () => {
    const { chanA } = await mountTwo();

    chanA.onmessage!(rateLimit("s-a", 0.85));
    await waitFor(() => expect(screen.getAllByText(/You have used 85% of your rolling 5-hour limit/)).toHaveLength(2));

    chanA.onmessage!(rateLimit("s-a", 0.86));
    chanA.onmessage!(rateLimit("s-a", 0.87));

    // One notice per chat, and the newer levels do not add a second: the notice
    // is about the window, and the window has not reset.
    await waitFor(() => expect(invokes.length).toBeGreaterThan(0));
    expect(screen.getAllByText(/You have used 85% of your rolling 5-hour limit/)).toHaveLength(2);
    expect(screen.queryByText(/You have used 87%/)).toBeNull();
  });

  it("is an attention notice rather than an error", async () => {
    const { chanA } = await mountTwo();

    chanA.onmessage!(rateLimit("s-a", 0.85));

    const [line] = await screen.findAllByText(/You have used 85% of your rolling 5-hour limit/);
    const box = line.closest("div")!;
    expect(box.className).toContain(styles.noticeAttention);
    expect(box.className).not.toContain(styles.noticeError);
  });

  it("says nothing at ok or once the window has reset", async () => {
    const { chanA } = await mountTwo();

    chanA.onmessage!(rateLimit("s-a", 0.15));
    chanA.onmessage!(rateLimit("s-a", 0.85, PASSED));

    await waitFor(() => expect(invokes.filter((i) => i.cmd === "chat_spawn")).toHaveLength(2));
    expect(screen.queryByText(/You have used/)).toBeNull();
    expect(screen.queryByText(/has reset/)).toBeNull();
  });
});

/** The default threshold the notices above are measured against, so a change to
 *  it fails here rather than silently moving every assertion's meaning. */
it("measures against the shipped warn threshold", () => {
  expect(DEFAULT_SETTINGS.budgets.warnAtFraction).toBe(0.8);
});
