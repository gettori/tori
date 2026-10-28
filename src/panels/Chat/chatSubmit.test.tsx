// A message sent from outside the composer as a turn (held hunk comments). It
// runs the real panel, since the queue, the flush driver and the ceiling live
// in `ChatView`.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { wholeHistory } from "../../test/history";
import { clearComposer } from "../../utils/chatCompose";
import { emitWith, onWith, CHAT_SUBMIT, SEND_TO_SESSION_RESULT, type SendToSessionResult } from "../../utils/events";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let channel: { onmessage?: (raw: unknown) => void } | null = null;
let recorded = { tokens: 0, costUsd: 0, turns: 0 };
let budgetSettings: unknown = null;
let steerReply: () => Promise<unknown> = () => Promise.resolve(null);
let queueLoadReply: () => Promise<unknown> = () => Promise.resolve([]);

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
        return Promise.resolve(wholeHistory([]));
      case "chat_steer":
        return steerReply();
      case "chat_queue_load":
        return queueLoadReply();
      case "chat_usage_totals":
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
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  },
  emit: () => Promise.resolve(),
}));

const spendRecorded = (sessionId: string) =>
  listeners.get("usage://changed")?.({
    payload: { sessionId, cwd: "/work/repo", totals: { session: recorded, project: recorded } },
  });
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

const TAB = "chat:submit-1";
const SESSION = "s-chat-submit";

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
  steerReply = () => Promise.resolve(null);
  queueLoadReply = () => Promise.resolve([]);
  clearComposer(TAB);
  budgetSettings = {
    ...DEFAULT_SETTINGS,
    budgets: { sessionUsd: 1, projectUsd: null, contextPercent: null, itemUsd: null, warnAtFraction: 0.8 },
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
      profile={null}
      title="chat"
      active={true}
      resume={false}
      started={isStarted()}
      onStart={() => setStarted(true)}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
      onProfileResolved={() => {}}
    />
  ));
}

function goLive() {
  channel!.onmessage!({
    type: "sessionReady",
    sessionId: SESSION,
    slashCommands: [],
    models: [],
    modes: [],
    account: null,
    capabilities: null,
  });
}

const sends = () => invokes.filter((i) => i.cmd === "chat_send");
const BLOCKS = [
  { type: "fileRef", path: "/work/repo/a.ts", startLine: 1, endLine: 2, text: null },
  { type: "text", text: "why" },
];

/** Hand the panel a submit and wait for its answer to the original request. */
function submit(): Promise<SendToSessionResult["result"]> {
  return new Promise((resolve) => {
    const off = onWith<SendToSessionResult>(SEND_TO_SESSION_RESULT, (r) => {
      if (r.requestId !== "r1") return;
      off();
      resolve(r.result);
    });
    emitWith(CHAT_SUBMIT, { requestId: "r1", sessionId: SESSION, blocks: BLOCKS });
  });
}

async function live() {
  mount();
  await waitFor(() => expect(channel).not.toBeNull());
  goLive();
  await waitFor(() => expect(invokes.some((i) => i.cmd === "chat_queue_load")).toBe(true));
}

describe("a submit from outside the composer", () => {
  it("sends one turn to an idle chat", async () => {
    await live();
    expect(await submit()).toBe("sent");
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].args.blocks).toEqual(BLOCKS);
  });

  it("queues behind a running turn", async () => {
    await live();
    channel!.onmessage!(turnStarted("turn-1", false));
    expect(await submit()).toBe("sent");
    await screen.findByRole("button", { name: /Remove from the queue/ });
    expect(sends()).toHaveLength(0);
  });

  it("refuses a chat stopped at its spend limit", async () => {
    await live();
    recorded = { tokens: 15, costUsd: 5, turns: 1 };
    channel!.onmessage!(turnStarted("turn-2", true));
    channel!.onmessage!(turnCompleted("turn-2", 5));
    spendRecorded(SESSION);
    await screen.findByText(/will not start another turn/);
    expect(await submit()).toBe("blocked");
    expect(sends()).toHaveLength(0);
  });

  it("refuses a parked queue", async () => {
    queueLoadReply = () => Promise.resolve([{ id: "q1", blocks: [{ type: "text", text: "saved" }] }]);
    await live();
    await screen.findByRole("button", { name: "Remove from the queue: saved" });
    expect(await submit()).toBe("blocked");
    expect(sends()).toHaveLength(0);
  });
});
