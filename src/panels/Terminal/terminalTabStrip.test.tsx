import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { tab, tabs } from "../../test/tabs";
import { installAnimationFrame } from "../../test/frames";

// The terminal tab strip, characterized before it moves onto Kobalte Tabs
// (skarif2/sway#111).
//
// Every other terminal suite mounts this panel to watch what gets *spawned*;
// none of them ever reached a tab. So the two gestures the strip exists for,
// clicking one to bring its session forward and closing one to take it away,
// were pinned nowhere, and a migration could have lost either in silence.
//
// Deliberately about the strip and nothing else: what a session *is* belongs to
// the suites that already own it.

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  /** Which pty ids are mounted, in mount order. The stage renders the visible
   *  one, so this is how "which session is forward" is observable here. */
  mounted: [] as string[],
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    if (cmd === "chat_orphans") return Promise.resolve([]);
    if (cmd === "refresh_agent_health") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    bridge.listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

vi.mock("./TerminalView", () => ({
  default: (props: { id: string }) => {
    bridge.mounted.push(props.id);
    return <div data-testid="pty" data-id={props.id} />;
  },
}));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));

const { default: Terminal } = await import("./Terminal");
const { emitWith, OPEN_TERMINAL } = await import("../../utils/events");
type OpenTerminal = import("../../utils/events").OpenTerminal;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The strip corrects its visible count in a frame, and these read the row it
// draws rather than its measuring ghost.
installAnimationFrame();

const branchSelection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

function mount() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(() => <Terminal selected={branchSelection as any} onOpenChange={() => {}} />);
}

/** Open a plain shell tab, the way the New button does. The title is what the
 *  tab is named, so these are reachable by name rather than by position. */
async function openShell(id: string) {
  emitWith<OpenTerminal>(OPEN_TERMINAL, {
    id,
    title: id,
    cwd: REPO,
    program: "bash",
    args: [],
  });
  await waitFor(() => expect(tabs(id)).toHaveLength(1));
}

beforeEach(() => {
  bridge.mounted.length = 0;
  bridge.listeners.clear();
  localStorage.clear();
});

describe("the terminal tab strip", () => {
  it("draws a tab per open session", async () => {
    mount();
    await openShell("one");
    await openShell("two");

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
  });

  it("brings a session forward when its tab is clicked", async () => {
    mount();
    await openShell("one");
    await openShell("two");
    // Asserted before the click as well as after: the newest tab is the one
    // showing, so without this the assertion below could hold for a click that
    // did nothing at all.
    expect(tab("one").getAttribute("aria-selected")).toBe("false");
    fireEvent.click(tab("one"));

    await waitFor(() => expect(tab("one").getAttribute("aria-selected")).toBe("true"));
    expect(tab("two").getAttribute("aria-selected")).toBe("false");
  });

  it("takes a tab away when its close is clicked", async () => {
    mount();
    await openShell("one");
    await openShell("two");
    fireEvent.click(within(tab("two")).getByLabelText("Close"));

    await waitFor(() => expect(tabs("two")).toHaveLength(0));
    expect(tabs("one")).toHaveLength(1);
  });
});

