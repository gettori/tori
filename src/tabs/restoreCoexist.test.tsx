// The two restore ceremonies, side by side (plan phase 6): a relaunch offers
// last run's terminal tabs (never spawning them unasked) while the same
// workspace's files come back silently. Both panels mount into one tree, the
// shape the two-pane shell gives them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "file_exists":
        return Promise.resolve(true);
      case "fs_read_dir":
        return Promise.resolve([]);
      case "list_sessions":
        return Promise.resolve([]);
      case "session_running":
        return Promise.resolve(false);
      case "chat_orphans":
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
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("../panels/Terminal/TerminalView", () => ({
  default: (props: { id: string }) => <div data-testid="pty" data-id={props.id} />,
}));
vi.mock("../panels/Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("../panels/Chat/ChatDraft", () => ({
  default: (props: { tabId: string; agentId: string }) => (
    <div data-testid="draft" data-tab={props.tabId} data-agent={props.agentId} />
  ),
}));
vi.mock("../panels/Editor/CodeEditor", () => ({ default: () => null }));
vi.mock("../panels/Editor/lspClient", () => ({ stopAllLsp: () => Promise.resolve(), retainLspRoots: () => Promise.resolve() }));

const { default: Terminal } = await import("../panels/Terminal/Terminal");
const { default: PaneView } = await import("./PaneView");
const { default: Editor } = await import("../panels/Editor/Editor");
const { open } = await import("../panels/Terminal/terminalTabStore");
const { emitWith, GIT_STAGE_ACTIVE } = await import("../utils/events");
const { draftFor } = await import("../utils/chatCompose");
const { draftPick } = await import("../utils/chatDraftPick");

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

beforeEach(() => {
  localStorage.clear();
  invokes.length = 0;
});

describe("restore, per pane", () => {
  it("offers last run's terminals and restores last run's files silently", async () => {
    const now = Date.now();
    localStorage.setItem(
      "sway.terminalTabs",
      JSON.stringify({
        [REPO]: {
          tabs: [
            { title: "shell", cwd: REPO, kind: "shell", program: "", args: [] },
            { title: "claude", cwd: REPO, kind: "agent", program: "claude", args: [], sessionId: "s-1" },
          ],
          active: 0,
          savedAt: now,
        },
      }),
    );
    localStorage.setItem(
      "sway.editor.tabs.v1",
      JSON.stringify({
        [REPO]: { paths: [`${REPO}/src/a.ts`], active: `${REPO}/src/a.ts`, savedAt: now },
      }),
    );

    render(() => (
      <div>
        <Terminal selected={selection as never} onOpenChange={() => {}} />
        <Editor selected={selection as never} />
        <PaneView pinKind="shell" />
        <PaneView pinKind="file" />
      </div>
    ));

    // The terminal pane offers; nothing spawned until the user answers.
    await screen.findByText("2 terminal tabs from last time");
    expect(open()).toHaveLength(0);

    // The file pane restored on its own: no banner, the stored file is open
    // and active (read through staging, which names the active tab).
    await waitFor(() => expect(screen.queryByText(/Open a file from the tree/)).toBeNull());
    emitWith(GIT_STAGE_ACTIVE, null);
    await waitFor(() => {
      const staged = invokes.filter((i) => i.cmd === "git_stage");
      expect(staged.length).toBe(1);
      expect(staged[0].args).toEqual({ projectPath: REPO, paths: ["src/a.ts"] });
    });
  });

  // A draft is the one tab with nothing behind it: no session to resume, no
  // shell to respawn. What comes back is what was in it, under a fresh tab id -
  // which is why the text and the pick travel in the stored record rather than
  // staying in the stores they were typed into.
  it("brings an unsent draft back with its text and its pick, still unstarted", async () => {
    localStorage.setItem(
      "sway.terminalTabs",
      JSON.stringify({
        [REPO]: {
          tabs: [
            {
              title: "proj",
              cwd: REPO,
              kind: "chat",
              program: "claude",
              args: [],
              text: "half a thought",
              pick: { model: "sonnet", mode: "plan", effort: null },
            },
          ],
          active: 0,
          savedAt: Date.now(),
        },
      }),
    );

    render(() => (
      <div>
        <Terminal selected={selection as never} onOpenChange={() => {}} />
        <PaneView pinKind="shell" />
      </div>
    ));

    fireEvent.click(await screen.findByText("Restore"));

    const draft = await screen.findByTestId("draft");
    expect(draft.dataset.agent).toBe("claude");
    expect(draftFor(draft.dataset.tab!)).toBe("half a thought");
    expect(draftPick(draft.dataset.tab!)).toEqual({ model: "sonnet", mode: "plan", effort: null });
    // Restored, not started: a draft that spawned on restore would be the eager
    // path back, with a process and a claim nobody asked for.
    expect(invokes.some((i) => i.cmd === "chat_spawn")).toBe(false);
    expect(screen.queryByTestId("chat")).toBeNull();
  });
});
