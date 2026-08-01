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
const { publishEditorState, clearEditorState } = await import("../../utils/editorState");
const { refreshStatus } = await import("../../utils/gitActions");
const { NEW_SESSION, SET_RIGHT_MODE, TOGGLE_TERMINAL, STOP_CHAT, EDITOR_SAVE } = await import(
  "../../utils/events"
);

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

beforeEach(async () => {
  bridge.calls.length = 0;
  onOpenSettings.mockClear();
  // Both stores are module-level and outlive any one palette, so each test says
  // what the editor and the index hold rather than inheriting the last one's.
  clearEditorState();
  await refreshStatus(null);
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
    // Labelled from the canonical table now, which is the same string the
    // Cmd+/ sheet shows: one command cannot be called two things.
    ["Show or hide the terminal", TOGGLE_TERMINAL, FIRED],
  ])("%s still runs", (label, event, want) => {
    open();
    expect(fire(label, event)).toEqual(want);
  });

  it("shows the key chips of a command that also carries a binding", () => {
    open();
    const row = screen.getByText("Show or hide the terminal").parentElement!;
    expect([...row.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["⌘", "⌥", "J"]);
  });

  it("lists an unavailable command with its reason, and refuses to run it", () => {
    // Nothing published means no file is open, so "Save file" has to say why
    // rather than either vanishing (you would never learn it exists) or running
    // and saving nothing.
    open();
    const row = screen.getByText("Save file").parentElement!;
    expect(row.textContent).toContain("No file open");
    expect(row.getAttribute("aria-disabled")).toBe("true");

    // Filtered down first, so the row Enter would take is unambiguously this
    // one rather than whatever happened to be at the top of the full list.
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "Save file" } });
    expect(rowLabels()[0]).toBe("Save file");

    let fired = false;
    const on = () => (fired = true);
    window.addEventListener(EDITOR_SAVE, on);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByText("Save file"));
    window.removeEventListener(EDITOR_SAVE, on);
    expect(fired).toBe(false);
  });

  it("runs a command once its requirement is met", () => {
    publishEditorState({ activePath: `${REPO}/src/a.ts`, dirty: true, tabCount: 1, projectRoot: REPO });
    open();
    expect(screen.getByText("Save file").parentElement!.textContent).not.toContain("No file open");
    expect(fire("Save file", EDITOR_SAVE)).toEqual(FIRED);
  });

  it("closes before the command runs", () => {
    // Load-bearing for the commands whose handler opens a prompt (go to line,
    // commit): Editor is the prompt host, and a prompt raised while the palette
    // was still up would open behind it and take the palette's focus fight.
    const order: string[] = [];
    mounted = render(() => (
      <CommandPalette
        selected={selection}
        onOpenSettings={onOpenSettings}
        onClose={() => order.push("closed")}
      />
    ));
    const on = () => order.push("ran");
    window.addEventListener(SET_RIGHT_MODE, on);
    fireEvent.click(screen.getByText("Show Changes"));
    window.removeEventListener(SET_RIGHT_MODE, on);
    expect(order).toEqual(["closed", "ran"]);
  });

  it("refuses Commit and Push by naming what is missing", () => {
    publishEditorState({ activePath: `${REPO}/src/a.ts`, dirty: false, tabCount: 1, projectRoot: REPO });
    open();
    expect(screen.getByText("Commit staged changes").parentElement!.textContent).toContain("Nothing staged");
    expect(screen.getByText("Push to origin").parentElement!.textContent).toContain("Nothing to push");
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
    const all = rowLabels().length;
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "sidebar" } });
    // fuzzyScore matches subsequences, so the narrowed list is not only exact
    // substring hits; what it must do is narrow, and rank both sidebar rows in.
    expect(rowLabels().length).toBeLessThan(all);
    expect(rowLabels()).toContain("Show or hide the sidebar");
    expect(rowLabels()).toContain("Filter the sidebar");
  });
});
