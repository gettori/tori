// The filter is behind a toggle now, sharing one row with the tree's title.
// Whether it opens beside it or under it is the row's own wrap (see the
// `.searchInput` basis, guarded in scripts/check-tokens.mjs), so what is left
// here is when it exists at all and what closing it does.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const WORK = "/root/work/proj";

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [
        {
          name: "proj",
          path: WORK,
          branchUnits: [
            { label: "main", folderPath: `${WORK}/main`, branch: "main", kind: "worktree", isCurrent: true },
          ],
        },
      ],
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    isFocused: () => Promise.resolve(true),
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { emit, on: onEvent, FOCUS_SEARCH, NEW_TOPIC, TOGGLE_SIDEBAR_MODE } = await import("../../utils/events");

const mount = () => render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
const toggle = () => screen.getByRole("button", { name: "Filter" });
const noToggle = () => screen.queryByRole("button", { name: "Filter" });
const field = () => screen.queryByPlaceholderText(/Filter projects/) as HTMLInputElement | null;

describe("the sidebar filter", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.sidebar-mode.v1", "spaces");
  });

  it("costs the header nothing until it is asked for", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    expect(field()).toBeNull();

    fireEvent.click(toggle());
    await waitFor(() => expect(field()).toBeTruthy());
    // The field is the affordance now; a second one beside it would only be
    // taking the room the field wants.
    expect(noToggle()).toBeNull();
  });

  // The one thing the column makes, moved out of the Topic list and into the
  // row the filter shares: the list owns the dialog, the head owns the button,
  // and the bus is what joins them.
  it("offers a New Topic button in Topics mode only, before the filter", async () => {
    const asked: number[] = [];
    const off = onEvent(NEW_TOPIC, () => asked.push(1));
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "New Topic" })).toBeNull();

    emit(TOGGLE_SIDEBAR_MODE);
    const add = await screen.findByRole("button", { name: "New Topic" });
    // Before the filter in the DOM, which is also the order a keyboard reaches
    // them in.
    expect(add.compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(add);
    expect(asked).toHaveLength(1);
    off();
  });

  it("takes the caret when it opens", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    fireEvent.click(toggle());
    // Focused from a frame callback, so the assertion waits for one.
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it("gives the rows back when it closes", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.input(field()!, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.queryByText("proj")).toBeNull());

    // A filter you cannot see is a tree missing rows for no stated reason, so
    // closing clears rather than hides.
    fireEvent.keyDown(field()!, { key: "Escape" });
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    expect(field()).toBeNull();
    expect(toggle()).toBeTruthy();
  });

  it("closes on Escape, which is where a filter is abandoned", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.input(field()!, { target: { value: "zzz" } });

    fireEvent.keyDown(field()!, { key: "Escape" });
    await waitFor(() => expect(field()).toBeNull());
    expect(screen.getByText("proj")).toBeTruthy();
  });

  it("closes when focus goes somewhere else", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.input(field()!, { target: { value: "zzz" } });

    fireEvent.focusOut(field()!, { relatedTarget: document.body });
    await waitFor(() => expect(field()).toBeNull());
    expect(screen.getByText("proj")).toBeTruthy();
  });

  it("opens on the palette's own shortcut", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    emit(FOCUS_SEARCH);
    await waitFor(() => expect(field()).toBeTruthy());
  });
});
