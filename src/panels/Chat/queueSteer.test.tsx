// Steering and editing a queued message. These run the real panel: the flush
// driver, the ceiling and the composer swap during an edit live in `ChatView`,
// not in the store.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { wholeHistory } from "../../test/history";
import { offerToComposer } from "../../utils/chatCompose";

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
let steerReply: () => Promise<unknown> = () => Promise.resolve(null);

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

const TAB = "chat:queue-steer-1";
const SESSION = "s-queue-steer";

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

const steers = () => invokes.filter((i) => i.cmd === "chat_steer");
const sends = () => invokes.filter((i) => i.cmd === "chat_send");
const input = () => document.querySelector("textarea") as HTMLTextAreaElement;

async function runningWithQueued(text: string) {
  mount();
  await waitFor(() => expect(channel).not.toBeNull());
  channel!.onmessage!(turnStarted("turn-1", false));
  fireEvent.input(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: "Enter", altKey: true });
  await screen.findByRole("button", { name: `Remove from the queue: ${text}` });
}

const steerOldest = () => fireEvent.keyDown(input(), { key: "Enter", metaKey: true, shiftKey: true });

describe("steering a queued message", () => {
  it("steers the oldest entry and takes it off the queue once it lands", async () => {
    await runningWithQueued("later");
    steerOldest();
    await waitFor(() => expect(steers()).toHaveLength(1));
    expect(steers()[0].args.blocks).toEqual([{ type: "text", text: "later" }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove from the queue: later" })).toBeNull());
  });

  it("does not steer the same entry twice or flush it while the steer is in flight", async () => {
    let land!: () => void;
    steerReply = () => new Promise((r) => (land = () => r(null)));
    await runningWithQueued("later");
    steerOldest();
    steerOldest();
    await waitFor(() => expect(steers()).toHaveLength(1));
    channel!.onmessage!(turnCompleted("turn-1", 0));
    await Promise.resolve();
    expect(sends()).toHaveLength(0);
    land();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove from the queue: later" })).toBeNull());
    expect(sends()).toHaveLength(0);
  });

  it("keeps a refused steer queued and steerable again", async () => {
    steerReply = () => Promise.reject(new Error("refused"));
    await runningWithQueued("later");
    steerOldest();
    await waitFor(() => expect(steers()).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole("button", { name: "Steer now: later" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("button", { name: "Remove from the queue: later" })).toBeTruthy();
  });

  it("refuses under a spend ceiling", async () => {
    mount();
    await waitFor(() => expect(channel).not.toBeNull());
    recorded = { tokens: 15, costUsd: 5, turns: 1 };
    channel!.onmessage!(turnStarted("turn-2", true));
    channel!.onmessage!(turnCompleted("turn-2", 5));
    await screen.findByText(/will not start another turn/);
    channel!.onmessage!(turnStarted("turn-3", true));
    fireEvent.input(input(), { target: { value: "later" } });
    fireEvent.keyDown(input(), { key: "Enter", altKey: true });
    await screen.findByRole("button", { name: "Remove from the queue: later" });
    steerOldest();
    await Promise.resolve();
    expect(steers()).toHaveLength(0);
  });
});

const row = (text: string) => screen.getByRole("button", { name: `Remove from the queue: ${text}` }).closest("div")!;

async function editing(text: string, draft = "") {
  await runningWithQueued(text);
  fireEvent.input(input(), { target: { value: draft } });
  fireEvent.click(screen.getByRole("button", { name: `Edit: ${text}` }));
  await waitFor(() => expect(input().value).toBe(text));
}

describe("editing a queued message", () => {
  it("opens the entry in the composer and marks its row", async () => {
    const { default: styles } = await import("./Chat.module.css");
    await editing("later", "half a draft");
    expect(row("later").className).toContain(styles.queueItemEditing);
  });

  it("saves in place on Enter and brings the draft back", async () => {
    await editing("later", "half a draft");
    fireEvent.input(input(), { target: { value: "sooner" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByRole("button", { name: "Remove from the queue: sooner" });
    expect(input().value).toBe("half a draft");
    expect(steers()).toHaveLength(0);
  });

  it("leaves the row unchanged on Escape and brings the draft back", async () => {
    await editing("later", "half a draft");
    fireEvent.input(input(), { target: { value: "sooner" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(input().value).toBe("half a draft"));
    expect(screen.getByRole("button", { name: "Remove from the queue: later" })).toBeTruthy();
  });

  it("saves a chip added during the edit into the entry", async () => {
    await editing("later");
    offerToComposer(TAB, [{ type: "fileRef", path: "/work/repo/a.ts", startLine: null, endLine: null, text: null, label: "File 1" }]);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(row("later").textContent).toContain("File 1"));
  });

  it("saves on Cmd+Enter without sending, and ignores Option+Enter", async () => {
    await editing("later");
    fireEvent.input(input(), { target: { value: "sooner" } });
    fireEvent.keyDown(input(), { key: "Enter", altKey: true });
    expect(input().value).toBe("sooner");
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await screen.findByRole("button", { name: "Remove from the queue: sooner" });
    expect(screen.getAllByRole("button", { name: /^Remove from the queue/ })).toHaveLength(1);
    expect(steers()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  it("keeps the changed text as the draft when the entry goes and nothing was stashed", async () => {
    await editing("later");
    fireEvent.input(input(), { target: { value: "sooner" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove from the queue: later" }));
    await waitFor(() => expect(screen.queryByText("Editing a queued message")).toBeNull());
    expect(input().value).toBe("sooner");
  });

  it("brings the stash back and files the changed text in recall when the entry goes", async () => {
    await editing("later", "half a draft");
    fireEvent.input(input(), { target: { value: "sooner" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove from the queue: later" }));
    await waitFor(() => expect(input().value).toBe("half a draft"));
    expect(screen.queryByText("Editing a queued message")).toBeNull();
    fireEvent.input(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input().value).toBe("sooner");
  });

  it("edits the last entry on Option+Up and recalls on plain Up", async () => {
    await runningWithQueued("later");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input().value).toBe("later");
    expect(screen.queryByText("Editing a queued message")).toBeNull();
    fireEvent.input(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "ArrowUp", altKey: true });
    await screen.findByText("Editing a queued message");
    expect(input().value).toBe("later");
  });
});
