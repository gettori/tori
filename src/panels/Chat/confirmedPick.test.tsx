// When an ACP chat records a mode pick as the tab's and the project's: on the
// agent's answer, not on the invoke, which resolves on staging. Recording there
// wrote a refused mode into every later draft in the project (issue 164).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { wholeHistory } from "../../test/history";
import { pointerClick } from "../../test/menus";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let channel: { onmessage?: (raw: unknown) => void } | null = null;

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
const { draftPick, clearDraftPick } = await import("../../utils/chatDraftPick");
const { ensureAdaptersLoaded } = await import("../../utils/agents");

const TAB = "chat:confirmed-1";
const SESSION = "s-1";

const MODES = [
  { id: "agent", label: "Agent", hint: "Edits inside the workspace." },
  { id: "read-only", label: "Read only", hint: "Never writes." },
];

/** The session opening, with the modes the agent publishes and the one in force. */
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
    modes: MODES,
    fastModeState: null,
    fastModeDisabledReason: null,
    account: null,
  });
}

/** The agent's answer to a switch: its whole option set, mode included. */
function answer(mode: string) {
  channel?.onmessage?.({
    type: "configOptions",
    sessionId: SESSION,
    options: [
      {
        id: "approval_policy",
        name: "Mode",
        description: "",
        category: "mode",
        disabled: false,
        note: "",
        kind: "select",
        current: mode,
        choices: MODES.map((m) => ({ value: m.id, label: m.label, description: "" })),
      },
    ],
  });
}

function pick(getByLabelText: (t: string) => HTMLElement, label: string) {
  pointerClick(getByLabelText("Permission mode"));
  const menus = document.querySelectorAll('[role="menu"]');
  const menu = menus[menus.length - 1] as HTMLElement;
  const row = [...menu.querySelectorAll('[role="menuitem"]')].find((r) => r.textContent?.includes(label));
  pointerClick(row as HTMLElement);
}

const setModes = () => invokes.filter((i) => i.cmd === "chat_set_mode").map((i) => i.args.mode);

beforeEach(async () => {
  invokes.length = 0;
  channel = null;
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

describe("an ACP mode pick reaching the tab's record", () => {
  it("is written only once the agent's answer names it", async () => {
    const { getByLabelText } = mount();
    await waitFor(() => expect(channel).not.toBeNull());
    open();
    await waitFor(() => expect(getByLabelText("Permission mode").textContent).toContain("Agent"));

    pick(getByLabelText, "Read only");
    await waitFor(() => expect(setModes()).toEqual(["read-only"]));
    // The invoke has resolved by now, and that is not the acceptance here.
    expect(draftPick(TAB).mode).toBe(null);

    answer("read-only");
    await waitFor(() => expect(draftPick(TAB).mode).toBe("read-only"));
    expect(getByLabelText("Permission mode").textContent).toContain("Read only");
  });

  it("is not written for a mode the agent refused", async () => {
    const { getByLabelText } = mount();
    await waitFor(() => expect(channel).not.toBeNull());
    open();
    await waitFor(() => expect(getByLabelText("Permission mode").textContent).toContain("Agent"));

    pick(getByLabelText, "Read only");
    await waitFor(() => expect(setModes()).toEqual(["read-only"]));
    channel?.onmessage?.({ type: "modeRefused", sessionId: SESSION, mode: "read-only", reason: "not here" });
    // The refusal settles the pick and the answer that follows names the old
    // mode, so nothing is recorded for the pick that did not take.
    answer("agent");
    await waitFor(() => expect(getByLabelText("Permission mode").textContent).toContain("Agent"));
    expect(draftPick(TAB).mode).toBe(null);
  });
});
