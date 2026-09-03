// A background subagent finishing makes the CLI open a turn of its own, with no
// user message in front of it. That turn spends money Sway never authorised, so
// the ceiling has to be checked when it *completes* - a stop armed only at the
// next user message would let an agent-opened turn run past the limit.
//
// `ChatView` is mounted for real, like `openedChat.test.tsx`: the trigger is the
// panel's own event handler, so a stand-in would fake the thing under test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let channel: { onmessage?: (raw: unknown) => void } | null = null;
/** What `chat_record_usage` reports back, which is what the ceiling measures. */
let recorded = { tokens: 0, costUsd: 0, turns: 0 };
let budgetSettings: unknown = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (raw: unknown) => void;
  },
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "chat_spawn":
        channel = args.onEvent as { onmessage?: (raw: unknown) => void };
        return Promise.resolve({ ownership: { type: "granted", contested: false } });
      case "chat_history":
        return Promise.resolve([]);
      case "chat_record_usage":
        return Promise.resolve({ session: recorded, project: recorded });
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
  },
];

const { default: ChatView } = await import("./ChatView");
const { ensureAdaptersLoaded } = await import("../../utils/agents");
const { DEFAULT_SETTINGS, loadSettings } = await import("../Settings/settingsStore");

const TAB = "chat:ceiling-1";
const SESSION = "s-ceiling";

const recordings = () => invokes.filter((i) => i.cmd === "chat_record_usage");

const turnStarted = (turnId: string, agentInitiated: boolean) => ({
  type: "turnStarted",
  sessionId: SESSION,
  turnId,
  model: "claude-sonnet-5",
  permissionMode: "default",
  agentInitiated,
});

const turnCompleted = (turnId: string, costUsd: number) => ({
  type: "turnCompleted",
  sessionId: SESSION,
  turnId,
  outcome: "completed",
  stopReason: null,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
  costUsd,
  permissionDenials: [],
});

beforeEach(async () => {
  invokes.length = 0;
  channel = null;
  recorded = { tokens: 0, costUsd: 0, turns: 0 };
  budgetSettings = {
    ...DEFAULT_SETTINGS,
    budgets: { sessionUsd: 1, projectUsd: null, contextPercent: null, warnAtFraction: 0.8 },
  };
  await ensureAdaptersLoaded();
  await loadSettings();
});

function mount() {
  const [isStarted, setStarted] = createSignal(true);
  return render(() => (
    <ChatView
      sessionId={SESSION}
      tabId={TAB}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="claude"
      title="chat"
      active={true}
      resume={false}
      started={isStarted()}
      onStart={() => setStarted(true)}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
    />
  ));
}

describe("the spend ceiling and a turn the agent opened", () => {
  it("stops the chat when a turn nothing asked for pushes it over", async () => {
    mount();
    await waitFor(() => expect(channel).not.toBeNull());

    recorded = { tokens: 15, costUsd: 5, turns: 1 };
    channel!.onmessage!(turnStarted("turn-2", true));
    channel!.onmessage!(turnCompleted("turn-2", 5));

    // Recorded, so a reopened tab still knows what the session spent...
    await waitFor(() => expect(recordings()).toHaveLength(1));
    // ...and acted on, rather than left for the next user message that may
    // never come.
    await screen.findByText(/will not start another turn/);
  });

  it("leaves it alone when the same turn stays under the ceiling", async () => {
    mount();
    await waitFor(() => expect(channel).not.toBeNull());

    recorded = { tokens: 15, costUsd: 0.2, turns: 1 };
    channel!.onmessage!(turnStarted("turn-2", true));
    channel!.onmessage!(turnCompleted("turn-2", 0.2));

    await waitFor(() => expect(recordings()).toHaveLength(1));
    expect(screen.queryByText(/will not start another turn/)).toBeNull();
  });
});
