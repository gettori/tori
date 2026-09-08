// A restored chat for an agent that keeps its own conversation.
//
// Two sources describe one conversation here, which is what makes this worth a
// test file of its own: Sway's log, read by `chat_history` before anything is
// spawned, and the agent's own `session/load` replay once the chat starts. The
// log is a cache of the replay, so the replay replaces what it drew rather than
// being folded on top of it - and a replay that brings nothing must leave it
// alone. `ChatView` is mounted for real, like `openedChat.test.tsx`, because the
// seam under test is between the panel and the child.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let channel: { onmessage?: (raw: unknown) => void } | null = null;
/** What `chat_history` reads back out of the log. */
let history: unknown[] = [];
/** What `chat_prompt_count` answers, per call, so a re-read is observable. */
let promptCounts: number[] = [];

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
        return Promise.resolve(history);
      case "chat_prompt_count":
        return Promise.resolve(promptCounts.shift() ?? 0);
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

const ADAPTERS = [
  {
    id: "codex",
    label: "Codex",
    program: "codex",
    base_args: [],
    yolo_args: [],
    resume_args: [],
    // No parser and no discovery: the whole reason this agent has a log.
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: {
      transport: "acp",
      program: "npx",
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
const { clearComposer, takeAutoSend } = await import("../../utils/chatCompose");

const TAB = "chat:acp-1";
const SESSION = "s-codex";

const countCalls = () => invokes.filter((i) => i.cmd === "chat_prompt_count");

/** One finished turn, in the shape the log stores and the replay re-sends. */
const turn = (text: string, id: string) => [
  { type: "userMessage", sessionId: SESSION, turnId: id, blocks: [{ type: "text", text }] },
  { type: "textDelta", sessionId: SESSION, turnId: id, text: `answer to ${text}`, agentId: null },
];

const turns = (texts: string[]) => texts.flatMap((t, i) => turn(t, `t${i}`));

/** The frame that closes the replay window and opens the session. */
const sessionStarted = () => ({
  type: "sessionStarted",
  sessionId: SESSION,
  cwd: "/work/repo",
  model: "gpt-5.6-terra",
  permissionMode: "default",
  tools: [],
  slashCommands: [],
  mcpServers: [],
  models: [],
  modes: [],
  fastModeState: null,
  fastModeDisabledReason: null,
  account: null,
});

beforeEach(async () => {
  invokes.length = 0;
  channel = null;
  history = [];
  promptCounts = [];
  clearComposer(TAB);
  takeAutoSend(TAB);
  await ensureAdaptersLoaded();
});

function mount() {
  const [isStarted, setStarted] = createSignal(false);
  const r = render(() => (
    <ChatView
      sessionId={SESSION}
      tabId={TAB}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="codex"
      profile={null}
      title="chat"
      active={true}
      resume={true}
      started={isStarted()}
      onStart={() => setStarted(true)}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
      onProfileResolved={() => {}}
    />
  ));
  return r;
}

/** Push frames down the live channel the way the transport does. */
function push(...frames: unknown[]) {
  for (const frame of frames) channel?.onmessage?.(frame);
}

/** Type into the composer and press Enter, which is what starts a restored tab:
 *  an inert one spawns nothing until asked ([[adr_lazy_tab_attachment]]). */
async function send(text: string) {
  const box = await screen.findByRole("textbox");
  fireEvent.input(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

/** Reach the live channel, which only exists once the tab has spawned. */
async function connect() {
  mount();
  await waitFor(() => expect(invokes.some((i) => i.cmd === "chat_history")).toBe(true));
  await send("carry on");
  await waitFor(() => expect(channel).not.toBeNull());
}

describe("a restored ACP chat reading its own log", () => {
  it("shows the log's turns before anything is spawned", async () => {
    history = turns(["what did we decide", "and then"]);
    mount();

    await screen.findByText("what did we decide");
    await screen.findByText("and then");
    expect(invokes.filter((i) => i.cmd === "chat_spawn")).toEqual([]);
  });

  it("replaces the log's turns with the replay rather than showing both", async () => {
    history = turns(["one", "two", "three"]);
    await connect();
    await screen.findByText("one");

    // The agent hands the same conversation back on the live channel.
    push(...turns(["one", "two", "three"]), sessionStarted());

    await waitFor(() => {
      expect(screen.getAllByText("one")).toHaveLength(1);
      expect(screen.getAllByText("three")).toHaveLength(1);
    });
  });

  it("keeps the log's turns when the replay brings nothing but a refusal", async () => {
    history = turns(["one", "two", "three"]);
    await connect();
    await screen.findByText("one");

    // A `session/load` the agent would not answer: non-fatal, then the session
    // opens anyway. Neither frame is a conversation, so neither may clear one.
    push(
      {
        type: "sessionError",
        sessionId: SESSION,
        message: "this agent would not hand the conversation back",
        fatal: false,
      },
      sessionStarted(),
    );

    await screen.findByText(/would not hand the conversation back/);
    expect(screen.getAllByText("one")).toHaveLength(1);
    expect(screen.getAllByText("three")).toHaveLength(1);
  });

  it("re-reads the prompt count once the session has reloaded itself", async () => {
    promptCounts = [3, 5];
    await connect();
    await waitFor(() => expect(countCalls()).toHaveLength(1));

    push(sessionStarted());

    // The figure read at open predates the reload that just rewrote it.
    await waitFor(() => expect(countCalls()).toHaveLength(2));
  });
});

describe("a restored ACP chat with nothing saved yet", () => {
  it("says the conversation loads on start, rather than looking empty", async () => {
    history = [];
    mount();

    await screen.findByText(/keeps the conversation itself/);
  });

  it("drops that notice once the chat is open", async () => {
    history = [];
    await connect();
    await screen.findByText(/keeps the conversation itself/);

    push(sessionStarted());

    await waitFor(() =>
      expect(screen.queryByText(/keeps the conversation itself/)).toBeNull(),
    );
  });

  it("says nothing when there are turns to show", async () => {
    history = turns(["what did we decide"]);
    mount();

    await screen.findByText("what did we decide");
    expect(screen.queryByText(/keeps the conversation itself/)).toBeNull();
  });
});
