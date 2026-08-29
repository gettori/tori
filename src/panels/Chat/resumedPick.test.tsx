// What a resumed session is opened on.
//
// The bug this pins: a chat came back from a reload on the CLI's own defaults
// for two of its three settings. Measured on claude 2.1.251, `--resume` brings
// the model back and reports it on `system/init`, while `--permission-mode` and
// `--effort` are per-process flags a resume does not restore - init came back
// `permissionMode: "default"` for a session started in `plan`, and no frame
// mentions effort at any point. Sway passed neither on resume, so the model
// looked like it persisted and the other two silently reset.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (raw: unknown) => void;
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
  model_args: ["--model", "{model}"],
  effort_args: ["--effort", "{effort}"],
  mode_args: ["--permission-mode", "{mode}"],
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
const { setDraftPick, clearDraftPick } = await import("../../utils/chatDraftPick");
const { ensureAdaptersLoaded } = await import("../../utils/agents");

const TAB = "chat:resumed-1";
const SESSION = "s-1";

const spawn = () => invokes.find((i) => i.cmd === "chat_spawn")?.args;

beforeEach(async () => {
  invokes.length = 0;
  clearDraftPick(TAB);
  await ensureAdaptersLoaded();
});

function mount(resume: boolean) {
  return render(() => (
    <ChatView
      sessionId={SESSION}
      tabId={TAB}
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="claude"
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
