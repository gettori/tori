// The shell on a restored Shells selection: the locked pane is there from
// startup, and the file-tree flag is left alone so a folder gets the tree back
// as the user had it. The tree's own suppression is shellsChrome.test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";

const invoke = vi.fn();
const bridge = vi.hoisted(() => ({
  /** The sidebar's `onSelect`, so a test can move the selection like a click would. */
  select: null as ((s: unknown) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("./panels/Terminal/Terminal", () => ({
  default: () => <div data-testid="terminal-panel" />,
}));
vi.mock("./panels/Editor/Editor", () => ({
  default: (props: { showFiletree?: boolean }) => (
    <div data-testid="editor-panel" data-filetree={String(props.showFiletree)} />
  ),
}));
vi.mock("./panels/LeftSidebar/LeftSidebar", () => ({
  default: (props: { onSelect: (s: unknown) => void }) => {
    bridge.select = props.onSelect;
    return <div />;
  },
}));
vi.mock("./panels/Settings/Settings", () => ({ default: () => <div /> }));
vi.mock("./components/Toolbar/Toolbar", () => ({ default: () => <div /> }));
vi.mock("./components/UpdatePill/UpdatePill", () => ({ default: () => <div /> }));
vi.mock("./components/Omnibox/Omnibox", () => ({ default: () => <div /> }));

import { DEFAULT_SETTINGS } from "./panels/Settings/settingsStore";

const { default: App } = await import("./App");
const { emit, TOGGLE_FILETREE } = await import("./utils/events");
const { SHELLS_KEY, shellsSelection } = await import("./utils/features");
const { paneLock } = await import("./layout/tabPlacement");
const { layoutRoot } = await import("./layout/layoutStore");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const unit = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "sway.layout.v1",
    JSON.stringify({ sidebar: 280, editor: 350, showSidebar: true, showTerminal: true, showEditor: true, showFiletree: true }),
  );
  localStorage.setItem("sway.selection.v1", JSON.stringify(shellsSelection()));
  bridge.select = null;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return DEFAULT_SETTINGS;
    if (cmd === "onboarding_should_show") return false;
    if (cmd === "list_user_themes") return { themes: [], errors: [] };
    return null;
  });
});

describe("the shell on the Shells selection", () => {
  it("seeds the locked Shells pane at startup", () => {
    render(() => <App />);
    expect(layoutRoot(SHELLS_KEY)).toBeTruthy();
    expect(paneLock(SHELLS_KEY, "main")).toBe("command");
  });

  it("draws one pane, and it is a terminal rather than the editor column", () => {
    const { container } = render(() => <App />);
    const panes = container.querySelectorAll(".work-split .pane");
    expect(panes).toHaveLength(1);
    // `homePane` hands a kind the first pane when every pane is locked away
    // from it, so without a guard the one command pane would wear both roles.
    expect(panes[0].classList.contains("terminal")).toBe(true);
    expect(panes[0].classList.contains("editor")).toBe(false);
  });

  it("leaves the file-tree flag alone in Shells and hands it back untouched on leaving", () => {
    const { container } = render(() => <App />);
    const flag = () => container.querySelector<HTMLElement>('[data-testid="editor-panel"]')!.dataset.filetree;
    expect(flag()).toBe("true");

    // The hotkey's event lands while Shells is on screen: nothing visible would
    // flip, so the flag does not either.
    emit(TOGGLE_FILETREE);
    expect(flag()).toBe("true");

    bridge.select!(unit);
    expect(flag()).toBe("true");
    // Back in a folder the same toggle is live again, which is what says the
    // guard was about Shells and not a dead hotkey.
    emit(TOGGLE_FILETREE);
    expect(flag()).toBe("false");
  });
});
