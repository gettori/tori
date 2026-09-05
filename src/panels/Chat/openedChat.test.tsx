// A restored chat opened to read, and the first send that starts it (plan
// phase 3). `ChatView` is mounted for real, like `openingOptions.test.tsx`,
// because what is under test is the split between the surface and the child:
// a stand-in would have to fake exactly the thing being asserted.
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
/** What the claim answers. A refusal is a value on this path, never a throw. */
let claim: unknown = { type: "granted", contested: false };
/** The turns `chat_history` replays for the session under test. */
let history: unknown[] = [];
/** Set to make the replay reject, which is a thing that happens to real
 *  transcripts and used to leave no trace at all. */
let historyFails: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (raw: unknown) => void;
  },
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "chat_spawn":
        channel = args.onEvent as { onmessage?: (raw: unknown) => void };
        return Promise.resolve({ ownership: claim });
      case "chat_history":
        return historyFails ? Promise.reject(historyFails) : Promise.resolve(history);
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
const { clearComposer, draftFor, takeAutoSend } = await import("../../utils/chatCompose");

const TAB = "chat:restored-1";
const SESSION = "s-restored";

const spawns = () => invokes.filter((i) => i.cmd === "chat_spawn");
const sends = () => invokes.filter((i) => i.cmd === "chat_send");
const historyCalls = () => invokes.filter((i) => i.cmd === "chat_history");

/** A finished user turn, as the transcript replays one. */
const userTurn = (text: string) => ({
  type: "userMessage",
  sessionId: SESSION,
  blocks: [{ type: "text", text }],
});

/** Let the spawned session say it can take a turn, which is the gate the held
 *  first message waits on. */
function goLive() {
  channel?.onmessage?.({
    type: "sessionReady",
    sessionId: SESSION,
    slashCommands: [],
    models: [],
    modes: [],
    account: null,
    capabilities: null,
  });
}

beforeEach(async () => {
  invokes.length = 0;
  channel = null;
  claim = { type: "granted", contested: false };
  history = [];
  historyFails = null;
  // Both halves: the composer's text and anything a previous test left held for
  // a first send that never happened.
  clearComposer(TAB);
  takeAutoSend(TAB);
  await ensureAdaptersLoaded();
});

/**
 * Mount the chat the way the panel does, with `started` under the test's
 * control: the panel flips it on `onStart`, and so does this.
 */
function mount(started = false) {
  const [isStarted, setStarted] = createSignal(started);
  const r = render(() => (
    <ChatView
      sessionId={SESSION}
      tabId={TAB}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="claude"
      profile={null}
      title="chat"
      active={true}
      // A restored chat, which is the only shape that opens unstarted.
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
  return { ...r, started: isStarted };
}

/** Type into the composer and press Enter, the way a person starts one. */
async function send(text: string) {
  const box = await screen.findByRole("textbox");
  fireEvent.input(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("a restored chat opened to read", () => {
  it("replays its transcript and starts nothing", async () => {
    history = [userTurn("what did we decide")];
    mount();

    await screen.findByText("what did we decide");
    expect(historyCalls()).toHaveLength(1);
    // The whole of the phase: a conversation on screen with no child behind it.
    expect(spawns()).toEqual([]);
  });

  it("says so when it cannot read the transcript, rather than looking empty", async () => {
    // A session whose turns are on disk and a session with no turns render the
    // same empty panel, and the one fact that tells them apart used to go to a
    // swallowed rejection. Whatever went wrong, the reader gets to see that
    // something did.
    historyFails = "no such file";
    mount();

    await screen.findByText(/Could not read this session's earlier turns/);
    // Still an enhancement and not a precondition: the panel is usable.
    expect(await screen.findByRole("textbox")).toBeTruthy();
  });

  it("starts on its own session id, resuming rather than beginning", async () => {
    mount();
    await waitFor(() => expect(historyCalls()).toHaveLength(1));

    await send("carry on");

    await waitFor(() => expect(spawns()).toHaveLength(1));
    expect(spawns()[0]!.args.sessionId).toBe(SESSION);
    expect(spawns()[0]!.args.resume).toBe(true);
  });

  it("sends the held message once the session can take a turn, and only then", async () => {
    mount();
    await waitFor(() => expect(historyCalls()).toHaveLength(1));

    await send("carry on");
    await waitFor(() => expect(spawns()).toHaveLength(1));
    // A spawned child is not yet a session that can answer.
    expect(sends()).toEqual([]);

    goLive();

    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0]!.args.blocks).toEqual([{ type: "text", text: "carry on" }]);
  });

  it("does not replay its transcript a second time when it starts", async () => {
    history = [userTurn("what did we decide")];
    mount();
    await screen.findByText("what did we decide");

    await send("carry on");
    await waitFor(() => expect(spawns()).toHaveLength(1));
    goLive();
    await waitFor(() => expect(sends()).toHaveLength(1));

    // One read, at mount. Starting the child does not remount the surface, so
    // the turns on screen are the ones that were already there.
    expect(historyCalls()).toHaveLength(1);
    expect(screen.getAllByText("what did we decide")).toHaveLength(1);
  });

  // The surface mounts over a session id it never claimed, and that id can be
  // live in another tab. Closing the reader must not end somebody else's child.
  it("closes no session it never started", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(historyCalls()).toHaveLength(1));

    unmount();

    expect(invokes.filter((i) => i.cmd === "chat_close")).toEqual([]);
  });

  // A refused claim on a *restored* tab has nowhere to go back to: it is not a
  // draft, so it keeps its own surface, its refusal banner and its text.
  it("keeps the message and says why, when the session is held elsewhere", async () => {
    claim = { type: "heldByOther", surface: "chat", tabId: "chat:other" };
    mount();
    await waitFor(() => expect(historyCalls()).toHaveLength(1));

    await send("carry on");

    await screen.findByText(/already open in a chat/);
    // Handed back, not lost with the session that never opened.
    await waitFor(() => expect(draftFor(TAB)).toBe("carry on"));
    expect(sends()).toEqual([]);
  });
});

describe("a chat that is already started", () => {
  it("spawns at mount, the way every live chat always has", async () => {
    mount(true);

    await waitFor(() => expect(spawns()).toHaveLength(1));
    expect(spawns()[0]!.args.sessionId).toBe(SESSION);
  });

  // The control for the case above: a tab that did start one still ends it, or
  // every closed chat would leave its child behind.
  it("closes the session it started", async () => {
    const { unmount } = mount(true);
    await waitFor(() => expect(spawns()).toHaveLength(1));

    unmount();

    expect(invokes.filter((i) => i.cmd === "chat_close")).toHaveLength(1);
  });

  it("sends straight to its child rather than holding the message", async () => {
    mount(true);
    await waitFor(() => expect(spawns()).toHaveLength(1));
    goLive();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    await send("go");

    await waitFor(() => expect(sends()).toHaveLength(1));
    // One spawn, not two: `onStart` is never reached on this path.
    expect(spawns()).toHaveLength(1);
  });
});
