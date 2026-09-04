// The draft's option picks reaching the session it grew into. `ChatView` is
// mounted for real here, unlike everywhere else, because what is under test is
// *when* the apply fires rather than what it sends.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let channel: { onmessage?: (raw: unknown) => void } | null = null;
let refuseSet = false;

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
      case "chat_set_config_option":
        return refuseSet ? Promise.reject("no such option") : Promise.resolve(null);
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
const { setDraftOption, clearDraftPick } = await import("../../utils/chatDraftPick");
const { ensureAdaptersLoaded } = await import("../../utils/agents");
const { onWith, TOAST } = await import("../../utils/events");

const TAB = "chat:opening-1";
const SESSION = "s-1";

const sets = () => invokes.filter((i) => i.cmd === "chat_set_config_option");

const WEB_SEARCH = {
  id: "web_search",
  name: "Web search",
  description: "",
  category: "",
  kind: "boolean",
  value: false,
};

/** Let the session say it can take a turn, which is the gate the apply waits
 *  on, and publish the levers it is actually running. */
function goLive(options: unknown[] = [WEB_SEARCH]) {
  channel?.onmessage?.({
    type: "sessionReady",
    sessionId: SESSION,
    slashCommands: [],
    models: [],
    modes: [],
    account: null,
    capabilities: null,
  });
  channel?.onmessage?.({ type: "configOptions", sessionId: SESSION, options });
}

beforeEach(async () => {
  invokes.length = 0;
  channel = null;
  refuseSet = false;
  clearDraftPick(TAB);
  await ensureAdaptersLoaded();
});

function mount() {
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
      started={true}
      onStart={() => {}}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
    />
  ));
}

describe("a draft's option picks, once it has a session", () => {
  it("waits for the session to be able to take a turn", async () => {
    setDraftOption(TAB, "web_search", true);
    mount();
    await waitFor(() => expect(channel).not.toBeNull());

    expect(sets()).toEqual([]);
    goLive();

    await waitFor(() =>
      expect(sets().map((i) => i.args)).toEqual([
        { sessionId: SESSION, configId: "web_search", value: true },
      ]),
    );
  });

  it("asks for nothing when the draft picked nothing", async () => {
    const { findByLabelText } = mount();
    await waitFor(() => expect(channel).not.toBeNull());
    goLive();
    // The mirror drawing the agent's own lever is the session being live: an
    // apply that was going to happen would have happened by then.
    await findByLabelText("Web search");

    expect(sets()).toEqual([]);
  });

  // A refused option is a toast, not a held message: the mirror keeps showing
  // what the agent says is in force, which is the pick failing visibly.
  it("says a refusal out loud and leaves the mirror on the agent's own truth", async () => {
    refuseSet = true;
    const toasts: string[] = [];
    const off = onWith<{ message: string }>(TOAST, (d) => toasts.push(d.message));
    setDraftOption(TAB, "web_search", true);
    const { getByLabelText } = mount();
    await waitFor(() => expect(channel).not.toBeNull());
    goLive();

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toContain("no such option");
    expect(getByLabelText("Web search").getAttribute("aria-pressed")).toBe("false");
    off();
  });
});
