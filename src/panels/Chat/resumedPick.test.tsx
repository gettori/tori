// What a resumed session is opened on, and what its controls say about it.
//
// The bug this pins: a chat came back from a reload on the CLI's own defaults
// for two of its three settings. Measured on claude 2.1.251, `--resume` brings
// the model back and reports it on `system/init`, while `--permission-mode` and
// `--effort` are per-process flags a resume does not restore - init came back
// `permissionMode: "default"` for a session started in `plan`, and no frame
// mentions effort at any point. Sway passed neither on resume, so the model
// looked like it persisted and the other two silently reset.
//
// Re-measured on 2.1.259 for issue 163 and unchanged: `--resume` with no mode
// flag still answers `permissionMode: "default"`. So the pick is the only thing
// that knows what the child was started on, and the second half of this file
// pins that the controls actually say so - `system/init` re-declares the mode
// and the model per *turn*, which leaves the pills describing nobody from mount
// until the first turn lands.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
/** Every `Channel` ChatView opened, so a test can push a frame down the newest. */
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
        return Promise.resolve({ ownership: { type: "granted", contested: false } });
      case "chat_history":
        return Promise.resolve([]);
      case "list_agents":
        return Promise.resolve(ADAPTERS);
      case "model_catalogs":
        return Promise.resolve(CATALOGS);
      // The transcript scan. It names the model the session's last turn ran,
      // which is the honest answer only while nothing rode argv.
      case "chat_session_detail":
        return Promise.resolve(DETAIL);
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

const MODES = [
  { id: "default", label: "Ask", hint: "Prompts for dangerous operations.", args: [], default: true },
  { id: "plan", label: "Plan", hint: "Planning mode.", args: [] },
  { id: "acceptEdits", label: "Accept edits", hint: "Auto-accept edits.", args: [] },
];

const chat = {
  transport: "claude_stream_json",
  program: "claude",
  base_args: [],
  session_id_args: [],
  resume_args: [],
  model_args: ["--model", "{model}"],
  effort_args: ["--effort", "{effort}"],
  mode_args: ["--permission-mode", "{mode}"],
  add_dir_args: [],
  modes: MODES,
  effort: [],
  acp: { serve_client_fs: false },
};

// An ACP adapter declares no modes and no `model_args`: there a pick is a
// request made after the session opens, not a flag, which is why nothing may be
// seeded from it.
const acpChat = { ...chat, transport: "acp", program: "codexy", model_args: [], mode_args: [], modes: [] };

const agent = (id: string, c: unknown) => ({
  id,
  label: id,
  program: c === chat ? "claude" : "codexy",
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: null,
  pty_quiet_ms: 2000,
  chat: c,
});

const ADAPTERS = [agent("claude", chat), agent("codexy", acpChat)];

// A catalogue with no `default` alias row, so the pill names whichever model is
// actually selected rather than collapsing onto the alias.
const model = (value: string, resolvedModel: string, displayName: string) => ({
  value,
  resolvedModel,
  displayName,
  description: "",
  supportsEffort: false,
  supportedEffortLevels: [],
  supportsAutoMode: false,
  supportsFastMode: false,
  supportsAdaptiveThinking: false,
});

const CATALOGS = [
  {
    agentId: "claude",
    state: "ready",
    lastFailure: null,
    catalogue: {
      version: null,
      shape: 6,
      probedAtMs: 0,
      models: [model("sonnet", "claude-sonnet-5", "Sonnet"), model("opus", "claude-opus-5", "Opus")],
      modes: [],
      account: null,
    },
  },
];

const DETAIL = {
  prompt_count: 1,
  turn_count: 1,
  tool_count: 0,
  output_tokens: 0,
  context_tokens: 0,
  model: "claude-opus-5",
  compaction_count: 0,
  compaction_reclaimed: 0,
  touched_count: 0,
};

const { default: ChatView } = await import("./ChatView");
const { setDraftPick, clearDraftPick } = await import("../../utils/chatDraftPick");
const { ensureAdaptersLoaded } = await import("../../utils/agents");
const { ensureModelCatalogsLoaded } = await import("../../utils/modelCatalog");

const TAB = "chat:resumed-1";
const SESSION = "s-1";

const spawn = () => invokes.find((i) => i.cmd === "chat_spawn")?.args;

beforeEach(async () => {
  invokes.length = 0;
  channels.length = 0;
  clearDraftPick(TAB);
  await ensureAdaptersLoaded();
  await ensureModelCatalogsLoaded();
});

function mount(resume: boolean, agentId = "claude") {
  return render(() => (
    <ChatView
      sessionId={SESSION}
      tabId={TAB}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId={agentId}
      title="chat"
      active={true}
      resume={resume}
      started={true}
      onStart={() => {}}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
    />
  ));
}

/** The first `system/init` of a turn, which is where the child declares both. */
const initFrame = (over: { model?: string; permissionMode?: string } = {}) => ({
  type: "sessionStarted",
  sessionId: SESSION,
  cwd: "/work/repo",
  model: "claude-sonnet-5",
  permissionMode: "default",
  tools: [],
  slashCommands: [],
  mcpServers: [],
  models: [],
  modes: [],
  fastModeState: null,
  fastModeDisabledReason: null,
  account: null,
  ...over,
});

describe("a chat restored from the store", () => {
  it("opens the resumed session on what the tab was running", async () => {
    setDraftPick(TAB, { model: "sonnet", mode: "plan", effort: "high" });
    mount(true);

    await waitFor(() => expect(spawn()).toBeTruthy());
    expect(spawn()).toMatchObject({ resume: true, model: "sonnet", mode: "plan", effort: "high" });
  });

  it("asserts nothing for a tab that was running nothing", async () => {
    // No pick is the CLI's own defaults rather than an assertion of them, which
    // is the same rule a first-run draft follows.
    mount(true);

    await waitFor(() => expect(spawn()).toBeTruthy());
    expect(spawn()).toMatchObject({ model: null, mode: null, effort: null });
  });
});

// The pills, at the one moment nothing has told the panel anything: the child
// is spawned but no turn has run, so `system/init` has not been seen.
describe("the controls of a tab whose pick rode argv", () => {
  it("name the mode and the model the child was started on, on a restore", async () => {
    setDraftPick(TAB, { model: "sonnet", mode: "plan", effort: "high" });
    const { getByLabelText } = mount(true);

    await waitFor(() => expect(getByLabelText("Permission mode").textContent).toContain("Plan"));
    expect(getByLabelText("Model").textContent).toContain("Sonnet");
  });

  it("do the same for a draft promoted into a live chat", async () => {
    // The pick survives the tab record being replaced, which is what promotion
    // is, so the pill must not flip back to "Ask" the moment the draft becomes
    // a session.
    setDraftPick(TAB, { model: "sonnet", mode: "plan", effort: "high" });
    const { getByLabelText } = mount(false);

    await waitFor(() => expect(getByLabelText("Permission mode").textContent).toContain("Plan"));
    expect(getByLabelText("Model").textContent).toContain("Sonnet");
  });

  it("yield to the child's own report the moment it arrives", async () => {
    // A seed is what this tab handed the child; init is what the child says it
    // is running. The second wins, or a mode the agent left by itself (or a
    // model changed by `/model`) would be misnamed for the life of the tab.
    setDraftPick(TAB, { model: "sonnet", mode: "plan" });
    const { getByLabelText } = mount(true);

    await waitFor(() => expect(channels.length).toBeGreaterThan(0));
    channels[channels.length - 1].onmessage?.(
      initFrame({ model: "claude-opus-5", permissionMode: "acceptEdits" }),
    );

    await waitFor(() => expect(getByLabelText("Permission mode").textContent).toContain("Accept edits"));
    expect(getByLabelText("Model").textContent).toContain("Opus");
  });
});

describe("the controls of a tab with no pick", () => {
  it("fall back to the adapter's mode and the transcript's model", async () => {
    // Nothing rode argv, so the CLI resumed on its own default (measured) and
    // the transcript's last turn is the best thing left to name a model with.
    const { getByLabelText } = mount(true);

    await waitFor(() => expect(getByLabelText("Permission mode").textContent).toContain("Ask"));
    expect(getByLabelText("Model").textContent).toContain("Opus");
  });
});

describe("the controls of an ACP tab", () => {
  it("seed nothing, because there the pick is a request and not a flag", async () => {
    // `chat_set_mode` goes out after the session opens and can be refused, so a
    // seeded pill would name a mode nothing has applied yet.
    setDraftPick(TAB, { model: "sonnet", mode: "plan" });
    const { getByLabelText } = mount(true, "codexy");

    await waitFor(() => expect(spawn()).toBeTruthy());
    expect(getByLabelText("Permission mode").textContent).toContain("Mode");
    expect(getByLabelText("Permission mode").textContent).not.toContain("Plan");
  });
});
