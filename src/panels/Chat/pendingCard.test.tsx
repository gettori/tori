// The Inbox opening a chat at the approval or question it is waiting on.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, waitFor } from "@solidjs/testing-library";
import { wholeHistory } from "../../test/history";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let channel: { onmessage?: (raw: unknown) => void } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (raw: unknown) => void;
  },
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "chat_spawn":
        channel = args.onEvent as { onmessage?: (raw: unknown) => void };
        return Promise.resolve({ ownership: { type: "granted", contested: false } });
      case "chat_history":
        return Promise.resolve(wholeHistory([]));
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

// An ACP adapter declares no modes: the session publishes its own on open.
const ADAPTERS = [
  {
    id: "codexy",
    label: "codexy",
    program: "codexy",
    base_args: [],
    yolo_args: [],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: {
      transport: "acp",
      program: "codexy",
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
    },
  },
];

const { default: ChatView } = await import("./ChatView");
const { ensureAdaptersLoaded } = await import("../../utils/agents");
const { pendingCard, setPendingCard } = await import("../../utils/pendingCard");

const TAB = "chat:pending-1";
const SESSION = "s-pending";

function open() {
  channel?.onmessage?.({
    type: "sessionStarted",
    sessionId: SESSION,
    cwd: "/work/repo",
    model: "gpt-5.6",
    permissionMode: "agent",
    tools: [],
    slashCommands: [],
    mcpServers: [],
    models: [],
    modes: [],
    fastModeState: null,
    fastModeDisabledReason: null,
    account: null,
  });
}

function ask() {
  channel?.onmessage?.({
    type: "permissionRequest",
    sessionId: SESSION,
    toolUseId: "toolu_1",
    toolName: "Bash",
    input: { command: "rm -rf build" },
    requestId: "r1",
    autoDenyAtMs: null,
    agentId: null,
  });
}

const scrolled: Element[] = [];

beforeEach(async () => {
  channel = null;
  scrolled.length = 0;
  setPendingCard(null);
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  await ensureAdaptersLoaded();
});

function mount() {
  return render(() => (
    <ChatView
      sessionId={SESSION}
      tabId={TAB}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="codexy"
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

describe("opening a chat at its waiting card", () => {
  it("brings the approval into view and drops the ask", async () => {
    const { container } = mount();
    await waitFor(() => expect(channel).not.toBeNull());
    open();
    ask();
    await waitFor(() => expect(container.querySelector("[data-pending-card]")).not.toBeNull());

    setPendingCard(SESSION);
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]).toBe(container.querySelector("[data-pending-card]"));
    expect(pendingCard()).toBeNull();
  });

  it("drops an ask for a chat with nothing waiting, without scrolling", async () => {
    mount();
    await waitFor(() => expect(channel).not.toBeNull());
    open();
    setPendingCard(SESSION);
    await waitFor(() => expect(pendingCard()).toBeNull());
    await Promise.resolve();
    expect(scrolled).toHaveLength(0);
  });

  it("leaves another session's ask alone", async () => {
    mount();
    await waitFor(() => expect(channel).not.toBeNull());
    open();
    ask();
    setPendingCard("s-other");
    await Promise.resolve();
    expect(pendingCard()).toBe("s-other");
    expect(scrolled).toHaveLength(0);
  });
});
