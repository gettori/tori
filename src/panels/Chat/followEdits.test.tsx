// Follow-live-edits used to sit in the editor's own toolbar, which is the panel
// that acts on it but not the one you are looking at when you decide: what it
// follows is a session's edits, so it belongs on the bar the session's other
// levers are on. `ChatView` is mounted for real, like `openedChat.test.tsx`,
// because where the control sits in that bar is the whole of what is under test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (raw: unknown) => void;
  },
  invoke: (cmd: string) => {
    if (cmd === "chat_spawn") return Promise.resolve({ ownership: { type: "granted", contested: false } });
    if (cmd === "chat_history") return Promise.resolve([]);
    if (cmd === "list_agents") return Promise.resolve(ADAPTERS);
    if (cmd === "model_catalogs") return Promise.resolve([]);
    return Promise.resolve(null);
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
const { followEdits, setFollowEdits } = await import("../../utils/followPref");

beforeEach(async () => {
  setFollowEdits(false);
  await ensureAdaptersLoaded();
});

function mount(tabId = "chat:follow-1") {
  return render(() => (
    <ChatView
      sessionId={`s-${tabId}`}
      tabId={tabId}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="claude"
      title="chat"
      active={true}
      resume={true}
      started={true}
      onStart={() => {}}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
    />
  ));
}

describe("following live edits from the composer bar", () => {
  it("is the last lever on the bar, after the ones the agent published", async () => {
    const { container } = mount();
    const pill = await screen.findByLabelText("Follow live edits");

    const bar = pill.parentElement as HTMLElement;
    const buttons = [...within(bar).getAllByRole("button")];
    const send = within(bar).getByLabelText("Send");
    // Everything before the spacer belongs to the session; the send button is
    // on the far side of it and is not one of the levers.
    expect(buttons.indexOf(pill)).toBe(buttons.indexOf(send) - 1);
    expect(container.contains(pill)).toBe(true);
  });

  it("is a toggle, off until it is pressed", async () => {
    mount();
    const pill = await screen.findByLabelText("Follow live edits");
    expect(pill.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pill);

    expect(pill.getAttribute("aria-pressed")).toBe("true");
    // The editor is a different panel, and this signal is the whole of what
    // reaches it.
    expect(followEdits()).toBe(true);
  });

  it("says the same thing in every chat that is open", async () => {
    // Why the setting is a module-level signal rather than one per view: two
    // composers disagreeing about whether the editor is following is a lie in
    // one of them.
    mount("chat:follow-a");
    mount("chat:follow-b");
    const pills = await screen.findAllByLabelText("Follow live edits");
    expect(pills).toHaveLength(2);

    fireEvent.click(pills[0]);

    for (const pill of pills) expect(pill.getAttribute("aria-pressed")).toBe("true");
  });
});
