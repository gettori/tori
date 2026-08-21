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
const { envelopeFor, resetPaneLayoutModel, seedTwoPane } = await import("../layout/layoutStore");
const { paneOfTab, resetTabPlacement } = await import("../layout/tabPlacement");
const { visibleId } = await import("../panels/Terminal/terminalTabStore");

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
  resetPaneLayoutModel();
  resetTabPlacement();
});

/** A stored workspace, saved just now so nothing prunes it. */
const storeTabs = (tabs: unknown[], over: Record<string, unknown> = {}) =>
  localStorage.setItem(
    "sway.terminalTabs",
    JSON.stringify({ [REPO]: { tabs, active: 0, savedAt: Date.now(), ...over } }),
  );

const shell = (over: Record<string, unknown> = {}) => ({
  title: "shell",
  cwd: REPO,
  kind: "shell",
  program: "",
  args: [],
  ...over,
});

const restore = async () => {
  render(() => (
    <div>
      <Terminal selected={selection as never} onOpenChange={() => {}} />
      <PaneView pinKind="shell" />
    </div>
  ));
  fireEvent.click(await screen.findByText("Restore"));
};

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
  // shell to respawn. What comes back is what was in it, and the text and the
  // pick travel in the stored record rather than staying in the stores they
  // were typed into, since a restore that had to mint a fresh id could not
  // reach them there.
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
    expect(draftPick(draft.dataset.tab!)).toEqual({
      model: "sonnet",
      mode: "plan",
      effort: null,
      optionValues: {},
    });
    // Restored, not started: a draft that spawned on restore would be the eager
    // path back, with a process and a claim nobody asked for.
    expect(invokes.some((i) => i.cmd === "chat_spawn")).toBe(false);
    expect(screen.queryByTestId("chat")).toBeNull();
  });
});

// A restored tab comes back as *itself*, under the id it was stored with. That
// id is what `sway.tabpanes.v1` keys placement on and what the backend's
// liveness listing answers in, so minting a fresh one on every restore threw
// both away.
describe("restore reuses the stored tab id", () => {
  it("brings a shell back under its own id rather than a fresh one", async () => {
    storeTabs([shell({ id: "sh:stored" })]);

    await restore();

    const pty = await screen.findByTestId("pty");
    expect(pty.dataset.id).toBe("sh:stored");
  });

  it("mints a fresh id for a store written before ids were kept", async () => {
    storeTabs([shell()]);

    await restore();

    const pty = await screen.findByTestId("pty");
    expect(pty.dataset.id).toMatch(/^sh:/);
  });

  // A store naming one id twice must still produce two tabs. `pty_spawn`
  // delivers a tab's `init` exactly once per id, so a second tab sharing one
  // would be seeded nothing and come back an empty shell.
  it("refuses a duplicate id within one restore, giving each entry its own tab", async () => {
    storeTabs([shell({ id: "sh:same", title: "one" }), shell({ id: "sh:same", title: "two" })]);

    await restore();

    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(2));
    const ids = screen.getAllByTestId("pty").map((el) => el.dataset.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("sh:same");
  });

  // Placement is keyed by tab id and nothing prunes it, so reusing the id is
  // the whole of what puts a hand-moved tab back in the pane it was moved to.
  it("puts a hand-moved tab back in the pane it was moved to", async () => {
    localStorage.setItem("sway.tabpanes.v1", JSON.stringify({ [REPO]: { tabs: { "sh:moved": "right" } } }));
    resetTabPlacement();
    storeTabs([shell({ id: "sh:moved" })]);

    await restore();

    const pty = await screen.findByTestId("pty");
    const root = envelopeFor(REPO, () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true })).layout;
    expect(paneOfTab(REPO, { id: pty.dataset.id!, kind: "shell" }, root)).toBe("right");
    // The pin rule sends a shell leftmost, so "right" is only reachable through
    // the stored entry: a fresh id would have gone home.
    expect(paneOfTab(REPO, { id: "sh:fresh", kind: "shell" }, root)).toBe("left");
  });

  it("refocuses by the stored active id, not by its position in the stored order", async () => {
    // The index deliberately disagrees: it is what an older build reads, and
    // the id has to win where both are present.
    storeTabs([shell({ id: "sh:a" }), shell({ id: "sh:b" })], { active: 0, activeId: "sh:b" });

    await restore();

    await waitFor(() => expect(visibleId()).toBe("sh:b"));
  });

  it("refocuses by the index for a store carrying no active id", async () => {
    storeTabs([shell({ id: "sh:a" }), shell({ id: "sh:b" })], { active: 1 });

    await restore();

    await waitFor(() => expect(visibleId()).toBe("sh:b"));
  });
});
