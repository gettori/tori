// The bug this pins: clicking a space tile switched the tree and nothing else.
// The chat, the files and git stayed on the previous space's worktree until you
// clicked a row, so the sidebar and every pane beside it disagreed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { Selection } from "./LeftSidebar";

const WORK = "/root/work/proj";
const MAIN = `${WORK}/main`;
const WAVE = `${WORK}/wave-3`;
const SIDE = "/root/side/lab";
const TRUNK = `${SIDE}/trunk`;
const REPO = "/root/side/repo";

const unit = (label: string, folderPath: string) => ({
  label,
  folderPath,
  branch: label,
  kind: "worktree",
  isCurrent: false,
});

// A plain repo's branch-units: every one of them lives in the repo folder, which
// is the whole reason a bookmark cannot be a folder alone.
const branchUnit = (label: string, isCurrent = false) => ({
  label,
  folderPath: REPO,
  branch: label,
  kind: "plain",
  isCurrent,
});

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
          branchUnits: [unit("main", MAIN), unit("wave-3", WAVE)],
        },
      ],
    },
    {
      name: "side",
      path: "/root/side",
      projects: [
        { name: "lab", path: SIDE, branchUnits: [unit("trunk", TRUNK)] },
        {
          name: "repo",
          path: REPO,
          branchUnits: [branchUnit("main", true), branchUnit("feat"), branchUnit("old")],
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

function mount() {
  const [sel, setSel] = createSignal<Selection | null>(null);
  const onSelect = vi.fn((s: Selection | null) => setSel(s));
  render(() => <LeftSidebar selected={sel()} onSelect={onSelect} liveTabs={[]} />);
  return { sel, onSelect };
}

const click = (name: string) => fireEvent.click(screen.getByText(name));
const clickSpace = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("switching spaces", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/proj", "p:side/lab"]));
  });

  it("comes back to the unit that space was left on", async () => {
    const { sel } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());

    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));

    clickSpace("side");
    await waitFor(() => expect(screen.getByText("trunk")).toBeTruthy());
    click("trunk");
    await waitFor(() => expect(sel()?.folderPath).toBe(TRUNK));

    clickSpace("work");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));
    expect(sel()).toMatchObject({
      kind: "unit",
      spaceName: "work",
      projectName: "proj",
      projectPath: WORK,
      branch: "wave-3",
      projectKind: "worktree",
    });
  });

  it("comes back to the branch a plain repo was left on, not to its first row", async () => {
    // The bookmark is re-read against the tree by folder, and a plain repo's
    // branches all answer to the same one. Without the branch, coming back lands
    // on whichever branch happens to be listed first, and the row lights up there.
    localStorage.setItem(
      "tori.expanded.v1",
      JSON.stringify(["p:work/proj", "p:side/lab", "p:side/repo"]),
    );
    localStorage.setItem(
      "tori.selection-memory.v1",
      JSON.stringify({
        spaces: {
          side: {
            kind: "unit",
            spaceName: "side",
            projectName: "repo",
            projectPath: REPO,
            folderPath: REPO,
            branch: "feat",
            projectKind: "plain",
            profile: null,
          },
        },
      }),
    );
    const { sel } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));

    clickSpace("side");

    await waitFor(() => expect(sel()?.folderPath).toBe(REPO));
    expect(sel()?.branch).toBe("feat");
    // And the row that lights up is that one, since the highlight reads the
    // selection back off the tree.
    expect(screen.getByText("feat").closest("[aria-current]")).toBeTruthy();
    expect(screen.getByText("main").closest("[aria-current]")).toBeNull();
  });

  it("selects nothing in a space that has never been opened", async () => {
    const { sel } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));

    clickSpace("side");
    await waitFor(() => expect(sel()).toBeNull());
  });

  it("selects nothing when the remembered folder is gone", async () => {
    // A worktree removed while it was the space's bookmark. The entry is a hint
    // re-read against the tree, so it cannot resurrect a folder that is gone.
    localStorage.setItem(
      "tori.selection-memory.v1",
      JSON.stringify({
        spaces: { work: { kind: "unit", spaceName: "work", folderPath: `${WORK}/deleted`, branch: "deleted" } },
      }),
    );
    localStorage.setItem("tori.active-space.v1", "side");
    const { sel } = mount();
    await waitFor(() => expect(screen.getByText("trunk")).toBeTruthy());
    click("trunk");
    await waitFor(() => expect(sel()?.folderPath).toBe(TRUNK));

    clickSpace("work");
    await waitFor(() => expect(sel()).toBeNull());
  });
});
