// The app shell's pane layout (plan phase 5): the work-split renders from the
// per-workspace envelope and the Cmd+Alt+J/E toggles resolve their pane through
// it.
//
// The panels themselves are stubbed: what phase 5 changed is the shell around
// them (which pane shows, how wide, which one a toggle acts on), and the
// panels' own suites cover their insides.
//
// Every case here is about *two* panes, which a workspace no longer starts with
// (plan phase 12), so the layout is stored the way one that had been split
// would have it. The single-pane default has its own suite, appOnePane.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("./panels/Terminal/Terminal", () => ({
  default: () => <div data-testid="terminal-panel" />,
}));
vi.mock("./panels/Editor/Editor", () => ({ default: () => <div data-testid="editor-panel" /> }));
vi.mock("./panels/LeftSidebar/LeftSidebar", () => ({ default: () => <div /> }));
vi.mock("./panels/Settings/Settings", () => ({ default: () => <div /> }));
vi.mock("./components/Toolbar/Toolbar", () => ({ default: () => <div /> }));
vi.mock("./components/UpdatePill/UpdatePill", () => ({ default: () => <div /> }));
vi.mock("./components/Omnibox/Omnibox", () => ({ default: () => <div /> }));

import { DEFAULT_SETTINGS } from "./panels/Settings/settingsStore";
import { seedTwoPane } from "./layout/layoutStore";
import { setPaneHidden } from "./layout/paneLayout";

const { default: App } = await import("./App");
const { storeTwoPanes } = await import("./test/panes");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// What the legacy key stores. It still describes the sidebar and the chrome;
// the pane tree has its own envelope, so nothing here reads the editor width.
const LEGACY = {
  sidebar: 280,
  editor: 350,
  showSidebar: true,
  showTerminal: true,
  showEditor: true,
  showFiletree: true,
};

const chord = (code: string) =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", { metaKey: true, altKey: true, code, bubbles: true }),
  );

const pane = (root: HTMLElement, which: "terminal" | "editor") =>
  root.querySelector<HTMLElement>(`.pane.${which}`)!;

beforeEach(() => {
  localStorage.clear();
  storeTwoPanes("");
  localStorage.setItem("tori.layout.v1", JSON.stringify(LEGACY));
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return DEFAULT_SETTINGS;
    if (cmd === "list_user_themes") return { themes: [], errors: [] };
    return null;
  });
});

describe("the two-pane shell", () => {
  it("draws a pane apiece, with the panels beside them", () => {
    const { container } = render(() => <App />);
    expect(container.querySelector(".work-split")).toBeTruthy();
    const terminal = pane(container, "terminal");
    const editor = pane(container, "editor");
    expect(terminal.classList.contains("hidden")).toBe(false);
    expect(editor.classList.contains("hidden")).toBe(false);
    // Both panels are service hosts since phase 7 and sit beside the tree since
    // phase 8, so the panes hold strips and stages rather than panel DOM.
    expect(container.querySelector('[data-testid="terminal-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="editor-panel"]')).toBeTruthy();
    expect(terminal.querySelector('[role="tablist"]')).toBeTruthy();
    expect(editor.querySelector('[role="tablist"]')).toBeTruthy();
  });

  it("renders a pane hidden in the stored envelope hidden after relaunch", () => {
    const env = seedTwoPane({ rightShare: 40, showLeft: true, showRight: true });
    env.layout = setPaneHidden(env.layout, "right", true)!;
    localStorage.setItem("tori.panes.v1", JSON.stringify({ "": env }));
    const { container } = render(() => <App />);
    expect(pane(container, "editor").classList.contains("hidden")).toBe(true);
    expect(pane(container, "terminal").classList.contains("hidden")).toBe(false);
  });
});

describe("the pane toggles", () => {
  it("Cmd+Alt+J hides the terminal pane and brings it back", () => {
    const { container } = render(() => <App />);
    chord("KeyJ");
    expect(pane(container, "terminal").classList.contains("hidden")).toBe(true);
    chord("KeyJ");
    expect(pane(container, "terminal").classList.contains("hidden")).toBe(false);
  });

  it("refuses to hide the last visible pane", () => {
    const { container } = render(() => <App />);
    chord("KeyE");
    expect(pane(container, "editor").classList.contains("hidden")).toBe(true);
    chord("KeyJ");
    expect(pane(container, "terminal").classList.contains("hidden")).toBe(false);
  });

  it("reveals the pin pane when no tab of the kind exists", () => {
    // No editor tabs are open anywhere in this suite (the panel is a stub and
    // the stores are empty), so Cmd+Alt+E resolves by pin rule alone.
    const env = seedTwoPane({ rightShare: 40, showLeft: true, showRight: true });
    env.layout = setPaneHidden(env.layout, "right", true)!;
    localStorage.setItem("tori.panes.v1", JSON.stringify({ "": env }));
    const { container } = render(() => <App />);
    expect(pane(container, "editor").classList.contains("hidden")).toBe(true);
    chord("KeyE");
    expect(pane(container, "editor").classList.contains("hidden")).toBe(false);
  });
});
