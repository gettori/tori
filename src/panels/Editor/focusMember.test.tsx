// The panes that follow the file in front, inside a Feature (#160 phase 2).
//
// Calls, Session and Debug are about one repo, and inside a Feature the
// one they are about is the active tab's, not the member you last clicked in the
// tree. What is asserted here is that they say which repo, that a run launches
// in it, and that moving the active member no longer kills the run.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import PaneView from "../../tabs/PaneView";
import { installAnimationFrame } from "../../test/frames";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

const A = "/r/a/.tori/worktrees/auth";
const B = "/r/b/.tori/worktrees/auth";

const FEATURE = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [
    { repoPath: "/r/a", displayName: "api", worktreePath: A, state: { kind: "present" }, order: 0 },
    { repoPath: "/r/b", displayName: "web", worktreePath: B, state: { kind: "present" }, order: 1 },
  ],
};

type Handle = { server: string; session: string };
type Invoke = { cmd: string; args: Record<string, unknown> };

const calls: Invoke[] = [];
const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
let sessionCounter = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    switch (cmd) {
      case "list_topics":
        return Promise.resolve([FEATURE]);
      case "get_config":
        return Promise.resolve({ spaces: [] });
      case "git_status":
      case "list_branches":
      case "list_project_files":
      case "fs_read_dir_compact":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      case "file_exists":
        return Promise.resolve(true);
      case "fs_read_dir":
        return Promise.resolve([{ name: "package.json" }]);
      case "fs_read_file":
        return Promise.resolve(JSON.stringify({ scripts: { dev: "vite" } }));
      // The backend's walk, faked at the seam: whichever root it is asked
      // about is the one it answers with, so a launch names the member it
      // actually started from.
      case "dap_root_for":
        return Promise.resolve(args!.projectPath);
      case "dap_launch_env":
        return Promise.resolve({ PATH: "/usr/bin" });
      case "dap_start":
      case "dap_connect": {
        const handle: Handle = {
          server: cmd === "dap_connect" ? (args!.server as string) : "dap0",
          session: `sess${sessionCounter++}`,
        };
        channels.set(handle.session, args!.onMessage as { onmessage: ((m: string) => void) | null });
        return Promise.resolve(handle);
      }
      case "dap_send": {
        const handle = args!.handle as Handle;
        const frame = JSON.parse(args!.message as string) as Record<string, unknown>;
        if (frame.type === "request") {
          void Promise.resolve().then(() =>
            channels.get(handle.session)?.onmessage?.(
              JSON.stringify({
                seq: 9000,
                type: "response",
                request_seq: frame.seq,
                command: frame.command,
                success: true,
                body: {},
              }),
            ),
          );
        }
        return Promise.resolve();
      }
      default:
        return Promise.resolve(null);
    }
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR, DEBUG_PICK, SET_RIGHT_MODE } = await import("../../utils/events");
const { publishCallRoots } = await import("../../utils/callHierarchy");
const dap = await import("../../utils/dapSessions");
const store = await import("../../utils/debugStore");

const featureSel = (activeRoot: string) => ({
  kind: "feature" as const,
  featureId: "f1",
  featureName: "Auth",
  roots: [A, B],
  activeRoot,
  spaceName: "",
  projectName: "Auth",
  projectPath: activeRoot,
  folderPath: activeRoot,
  branch: "feat/auth",
  projectKind: "feature",
});

const unitSel = {
  kind: "unit",
  spaceName: "space",
  projectName: "a",
  projectPath: "/r/a",
  folderPath: A,
  branch: "main",
  projectKind: "plain",
};

const withSession = (sel: Record<string, unknown>) => ({
  ...sel,
  sessionId: "s1",
  agent: "claude",
  sessionPath: null,
  sessionCwd: null,
});

let setSel: ((s: unknown) => void) | null = null;

async function mountEditor(initial: unknown = featureSel(A)) {
  const [sel, set] = createSignal<unknown>(initial);
  setSel = set;
  render(() => (
    <>
      <Editor selected={sel() as never} />
      <PaneView pinKind="file" />
    </>
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

/** Arrive at a file, the way the tree or a picker does. */
async function openFile(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  const name = path.split("/").pop()!;
  await waitFor(() => expect(screen.getAllByText(name).length).toBeGreaterThan(0));
}

/** Calls appears only once a server has answered for the file, and Debug only
 *  while something is running, so each pane is reached the way the app reaches
 *  it rather than by clicking a tab that is not there. */
const showCalls = async (path: string) => {
  publishCallRoots(path, []);
  const tab = await waitFor(() => screen.getByRole("tab", { name: "Calls" }));
  fireEvent.click(tab);
};
const showMode = (mode: string) => emitWith(SET_RIGHT_MODE, { mode });

/** The member line above the pane, which is the only place these panes say
 *  which repo they are answering for. */
const focusLine = () => document.querySelector<HTMLElement>("[data-focus-member]");

/** The root a launch reached the backend with. */
const launchedRoots = () =>
  calls.filter((c) => c.cmd === "dap_root_for").map((c) => c.args.projectPath as string);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  channels.clear();
  sessionCounter = 0;
  localStorage.clear();
  listening.ready = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  store.clearDebugConsole();
  cleanup();
  setSel = null;
  warn.mockRestore();
});

describe("the member line above the panes that follow the file", () => {
  it("names the active tab's member above Calls", async () => {
    const file = `${B}/src/b.ts`;
    await mountEditor();
    await openFile(file);

    await showCalls(file);
    await waitFor(() => expect(focusLine()?.textContent).toContain("web"));
  });

  it("names it above Debug and Session too", async () => {
    await mountEditor(withSession(featureSel(A)));
    await openFile(`${B}/src/b.ts`);

    showMode("debug");
    await waitFor(() => expect(focusLine()?.textContent).toContain("web"));

    showMode("session");
    await waitFor(() => expect(focusLine()?.textContent).toContain("web"));
  });

  it("names the active member with nothing open", async () => {
    // The tree is focused and no tab exists. The member you last worked in is
    // the only honest answer.
    await mountEditor();
    showMode("debug");
    await waitFor(() => expect(focusLine()?.textContent).toContain("api"));
  });

  it("follows the tab, not the active member", async () => {
    await mountEditor();
    await openFile(`${A}/src/a.ts`);
    showMode("debug");
    await waitFor(() => expect(focusLine()?.textContent).toContain("api"));

    await openFile(`${B}/src/b.ts`);
    await waitFor(() => expect(focusLine()?.textContent).toContain("web"));
  });

  it("is absent for a branch unit, which has one repo and nothing to say", async () => {
    await mountEditor(unitSel);
    await openFile(`${A}/src/a.ts`);
    showMode("debug");
    await waitFor(() => expect(screen.getByText(/Nothing is being debugged/)).toBeTruthy());
    // Nothing to disambiguate: there is only one repo on screen.
    expect(focusLine()).toBeNull();
  });
});

describe("starting a run inside a Feature", () => {
  it("launches in the active tab's member, not in the active root", async () => {
    await mountEditor();
    await openFile(`${B}/src/b.ts`);
    emitWith(DEBUG_PICK, { kind: "script" });
    await waitFor(() => expect(launchedRoots()).toContain(B));
    expect(launchedRoots()).not.toContain(A);
  });

  it("launches in the active root when the tree is focused and nothing is open", async () => {
    await mountEditor();
    emitWith(DEBUG_PICK, { kind: "script" });
    await waitFor(() => expect(launchedRoots()).toContain(A));
  });

  it("remembers a target per member", async () => {
    await mountEditor();
    await openFile(`${A}/src/a.ts`);
    emitWith(DEBUG_PICK, { kind: "script" });
    // Not `dev`: the Files tab's Scripts section lists it too, before the dialog
    // is up. The dialog is handed its scripts, so Start arrives with them.
    fireEvent.click(await screen.findByText("Start"));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tori.debugLastTarget") ?? "{}")).toHaveProperty(A),
    );
    // Under the member's own folder, not under `feature:f1`: two members of one
    // Feature debug two different programs.
    const stored = JSON.parse(localStorage.getItem("tori.debugLastTarget") ?? "{}");
    expect(stored).not.toHaveProperty("feature:f1");
    expect(stored).not.toHaveProperty(B);
  });
});

describe("what the Debug pane writes", () => {
  it("files a watch under the member the file in front is in", async () => {
    // The watch store keys on the member root, and a paused session's own
    // `projectPath` is compared against it: keeping a Feature's members apart
    // is the whole reason it is not keyed on `feature:<id>`.
    await mountEditor();
    await openFile(`${B}/src/b.ts`);
    showMode("debug");
    const input = await waitFor(() => screen.getByLabelText("Watch expression"));
    fireEvent.input(input, { target: { value: "req.body" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("tori.watches") ?? "{}");
      expect(stored[B]).toEqual(["req.body"]);
    });
    const stored = JSON.parse(localStorage.getItem("tori.watches") ?? "{}");
    expect(stored).not.toHaveProperty(A);
    expect(stored).not.toHaveProperty("feature:f1");
  });
});

describe("moving the active member", () => {
  it("leaves a live run alone, and its console with it", async () => {
    // The old sweep keyed on the active member, so clicking another repo in the
    // tree stopped the debuggee and blanked the transcript. Inside a Feature the
    // run belongs to the Feature.
    await mountEditor();
    store.noteConsoleLine("tori", "console", "server listening");
    const stop = vi.spyOn(dap, "stopAllDap");

    setSel!(featureSel(B));
    await waitFor(() => expect(screen.queryByText("server listening")).toBeDefined());

    expect(stop).not.toHaveBeenCalled();
    expect(store.consoleLines().some((l) => l.text === "server listening")).toBe(true);
    stop.mockRestore();
  });
});
