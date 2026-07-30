import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

// The palette is actions and nothing else. Session navigation belongs to the
// terminal pane's History dropdown, so what is pinned here is both halves of
// that: no session ever reaches a row (not even a live one, which used to be
// listed as "Focus"), and every action the palette still owns still runs.
const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.calls.push(cmd);
    return Promise.resolve(null);
  },
}));

const { default: CommandPalette } = await import("./CommandPalette");
const { setLiveChat, dropLiveChat } = await import("../../utils/chatSessions");
const { NEW_SESSION, SET_RIGHT_MODE, TOGGLE_TERMINAL, STOP_CHAT } = await import("../../utils/events");

const selection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

// The palette portals to <body>, which the shared `cleanup` does not reach.
let mounted: ReturnType<typeof render> | null = null;
const onOpenSettings = vi.fn();

function open() {
  mounted = render(() => (
    <CommandPalette selected={selection} onOpenSettings={onOpenSettings} onClose={() => {}} />
  ));
}

/** Every row's label, in order. */
function rowLabels(): string[] {
  return screen.getAllByRole("option").map((el) => el.firstElementChild?.textContent ?? "");
}

// Click the row named `label` and hand back what it put on the bus. A payload-
// less `emit()` carries `detail: null`, so `fired` (rather than the detail)
// is what says the event happened at all.
const FIRED = Symbol("fired");
function fire(label: string, event: string): unknown {
  let payload: unknown;
  const on = (e: Event) => (payload = (e as CustomEvent).detail ?? FIRED);
  window.addEventListener(event, on);
  fireEvent.click(screen.getByText(label));
  window.removeEventListener(event, on);
  return payload;
}

beforeEach(() => {
  bridge.calls.length = 0;
  onOpenSettings.mockClear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  dropLiveChat("chat-1");
});

describe("CommandPalette", () => {
  it("lists no sessions, live or resumable", () => {
    // A chat mid-turn: live, named, and in the selected folder, which is
    // exactly what the old palette listed at the top as a "Focus" row.
    setLiveChat({
      sessionId: "chat-1",
      sessionName: "the running chat",
      folderPath: REPO,
      tabId: "tab-1",
      status: "executing",
      visible: false,
    });
    open();

    // The one row that names it is the stop action, not a jump-to-session row.
    expect(rowLabels().filter((l) => l.includes("the running chat"))).toEqual(["Stop the running chat"]);
    // And nothing asks the backend for a folder's sessions any more.
    expect(bridge.calls).not.toContain("list_sessions");
  });

  it.each([
    ["New Claude session", NEW_SESSION, { folderPath: REPO, projectName: "repo", agent: "claude" }],
    ["Show Changes", SET_RIGHT_MODE, { mode: "changes" }],
    ["View: Toggle Terminal", TOGGLE_TERMINAL, FIRED],
  ])("%s still runs", (label, event, want) => {
    open();
    expect(fire(label, event)).toEqual(want);
  });

  it("stops a running chat", () => {
    setLiveChat({
      sessionId: "chat-1",
      sessionName: "the running chat",
      folderPath: REPO,
      tabId: "tab-1",
      status: "waitingForApproval",
      visible: false,
    });
    open();
    expect(fire("Stop the running chat", STOP_CHAT)).toEqual({ sessionId: "chat-1" });
  });

  it("opens settings", () => {
    open();
    fireEvent.click(screen.getByText("Open Settings"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("filters to the actions that match", () => {
    open();
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "toggle" } });
    expect(rowLabels().every((l) => l.startsWith("View: Toggle"))).toBe(true);
  });
});
