import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import { expectNoAxeViolations } from "../../test/axe";
import { emit, TOGGLE_SIDEBAR_MODE } from "../../utils/events";

// The fan-out group is a rendering claim, so it is asserted against the real
// tree rather than against the grouping function alone (see attempts.test.ts for
// that half). Everything the sidebar reaches for on mount is stubbed; only
// `get_config` and `list_project_attempts` carry the fixture, which is exactly
// the pair the tree joins to decide what is a group and what is a worktree.
const ROOT = "/root/work/repo";
const GOAL = "make the parser faster";

const attempts = [
  { path: `${ROOT}/.sway-attempts/try-1`, groupId: "g1", goal: GOAL },
  { path: `${ROOT}/.sway-attempts/try-2`, groupId: "g1", goal: GOAL },
  { path: `${ROOT}/.sway-attempts/try-3`, groupId: "g1", goal: GOAL },
];

const unit = (folderPath: string, branch: string) => ({
  label: branch,
  folderPath,
  branch,
  kind: "worktree",
  isCurrent: false,
});

const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      external: false,
      projects: [
        {
          name: "repo",
          path: ROOT,
          external: false,
          // A worktree container lists its worktrees, so the attempts arrive
          // here as ordinary units alongside `main`. Lifting them out is the
          // half that would otherwise render each attempt twice.
          branchUnits: [
            unit(`${ROOT}/main`, "main"),
            unit(`${ROOT}/.sway-attempts/try-1`, "try-1"),
            unit(`${ROOT}/.sway-attempts/try-2`, "try-2"),
            unit(`${ROOT}/.sway-attempts/try-3`, "try-3"),
          ],
        },
      ],
    },
  ],
};

// Every call the tree makes, so a test can assert which command an action
// actually reached. `create_attempt` and `promote_attempt` shipped registered
// and callerless once already; that they are invoked at all is the claim.
const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  promoteProblems: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_project_attempts") return Promise.resolve(attempts);
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    if (cmd === "create_attempt") {
      return Promise.resolve({ path: "/made", branch: String(args.branch), uncloned: [] });
    }
    if (cmd === "promote_attempt") return Promise.resolve(bridge.promoteProblems);
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
// The toast stack lives in App, not in the sidebar (#105), so a test that
// asserts on a toast has to mount the region the sidebar's setError writes to.
const { default: ToastRegion } = await import("../../components/Toasts/Toasts");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");

describe("fan-out groups in the tree", () => {
  beforeEach(() => {
    // The session map is a module-level store now, so it outlives a render.
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.promoteProblems = [];
    // jsdom has no layout, so the picker's keyboard-nav scroll is a no-op here.
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    // Open the project, so its branch-units and groups render at all.
    localStorage.setItem("sway.expanded.v1", JSON.stringify(["p:work/repo"]));
    localStorage.setItem("sway.active-space.v1", "work");
  });

  it("renders three attempts as one group and leaves the ordinary worktree alone", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} />);

    // The group is one row, named by the goal git never recorded.
    const groupRow = await screen.findByText(GOAL);
    expect(screen.getByText("3 attempts")).toBeTruthy();

    // The ordinary worktree still renders, and outside the group.
    const main = screen.getByText("main");
    expect(main).toBeTruthy();
    const groupNode = groupRow.closest(".node")!;
    expect(groupNode.contains(main)).toBe(false);

    // Each attempt is inside the group, and nowhere else: a collapsed group
    // shows none of them, and opening it shows all three.
    expect(screen.queryByText("try-1")).toBeNull();
    fireEvent.click(groupRow);
    await waitFor(() => expect(screen.getByText("try-1")).toBeTruthy());
    for (const name of ["try-1", "try-2", "try-3"]) {
      expect(groupNode.contains(screen.getByText(name))).toBe(true);
    }
  });

  // Expanding a group loads its units' sessions so the group can roll them up.
  // That is a listing, not a surface that shows the Historical section, and it
  // must not reach the verdict: `folder_historical` auto-adopts and writes
  // adopted.json, so a fetch that adopted would strip ghost protection from
  // folders the user never opened, before they ever saw them.
  it("loads an attempt group's sessions without adopting their folders", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} />);

    fireEvent.click(await screen.findByText(GOAL));
    await waitFor(() => expect(screen.getByText("try-1")).toBeTruthy());

    expect(bridge.calls.some((c) => c.cmd === "list_sessions")).toBe(true);
    expect(bridge.calls.filter((c) => c.cmd === "folder_historical")).toEqual([]);
  });

  it("creates one group of attempts from the project's own action", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} />);
    const project = (await screen.findByText("repo")).parentElement!;

    fireEvent.contextMenu(project);
    pointerClick(await screen.findByText("Fan out…"));

    // Reached through the accessibility tree: since the prompt moved onto
    // `Dialog`, its title is the panel's heading and the input is no longer a
    // sibling of it. The role narrows it to the field, since the dialog carries
    // the same name as its heading.
    const input = await screen.findByRole("textbox", {
      name: /what are these attempts for/,
    });
    fireEvent.input(input, { target: { value: "Make the parser faster!" } });
    fireEvent.click(screen.getByText("OK"));

    // The second question is the whole rest of the decision.
    fireEvent.click(await screen.findByText("3"));

    await waitFor(() =>
      expect(bridge.calls.filter((c) => c.cmd === "create_attempt")).toHaveLength(3),
    );
    const made = bridge.calls.filter((c) => c.cmd === "create_attempt").map((c) => c.args);
    // One group, one goal, three branches off one stem: the group is what makes
    // three worktrees read as three answers to one question.
    expect(new Set(made.map((a) => a.groupId)).size).toBe(1);
    expect(new Set(made.map((a) => a.goal))).toEqual(new Set(["Make the parser faster!"]));
    expect(made.map((a) => a.branch)).toEqual([
      "make-the-parser-faster-1",
      "make-the-parser-faster-2",
      "make-the-parser-faster-3",
    ]);
    expect(new Set(made.map((a) => a.root))).toEqual(new Set([ROOT]));
  });

  it("promotes a winner by its recorded path, and says what did not go", async () => {
    bridge.promoteProblems = [`${ROOT}/.sway-attempts/try-3: worktree removed, but branch stayed`];
    render(() => (
      <>
        <LeftSidebar selected={null} onSelect={() => {}} />
        <ToastRegion />
      </>
    ));

    fireEvent.click(await screen.findByText(GOAL));
    const winner = await screen.findByText("try-2");

    fireEvent.contextMenu(winner.parentElement!);
    pointerClick(await screen.findByText("Promote this attempt"));

    // The confirm says what promotion costs before it happens: the other two go
    // outright, and nothing is merged.
    expect(await screen.findByText(/other 2 attempts/)).toBeTruthy();
    fireEvent.click(screen.getByText("Promote"));

    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "promote_attempt")).toBe(true));
    const call = bridge.calls.find((c) => c.cmd === "promote_attempt")!;
    // The recorded path, which is what resolves the group backend-side.
    expect(call.args).toEqual({ root: ROOT, winnerPath: `${ROOT}/.sway-attempts/try-2` });
    // A loser that only half went is surfaced, not swallowed.
    expect(await screen.findByText(/did not fully go/)).toBeTruthy();
  });

  it("does not promote when the confirm is declined", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} />);
    fireEvent.click(await screen.findByText(GOAL));
    fireEvent.contextMenu((await screen.findByText("try-2")).parentElement!);
    pointerClick(await screen.findByText("Promote this attempt"));
    fireEvent.click(await screen.findByText("Cancel"));

    await waitFor(() => expect(screen.queryByText(/other 2 attempts/)).toBeNull());
    expect(bridge.calls.some((c) => c.cmd === "promote_attempt")).toBe(false);
  });
});

describe("the Spaces | Features mode", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
  });

  const sidebar = () => render(() => <LeftSidebar selected={null} onSelect={() => {}} />);
  const segment = (name: string) => screen.getByRole("button", { name });
  const pressed = (name: string) => segment(name).getAttribute("aria-pressed") === "true";

  it("defaults to Spaces and keeps the tree mounted", async () => {
    const { container } = sidebar();
    await screen.findByText("repo");
    expect(pressed("Spaces")).toBe(true);
    expect(container.querySelector("[data-feature-list]")).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("persists Features mode across a remount and unmounts the tree there", async () => {
    const first = sidebar();
    await screen.findByText("repo");
    fireEvent.click(segment("Features"));
    await waitFor(() => expect(pressed("Features")).toBe(true));
    expect(localStorage.getItem("sway.sidebar-mode.v1")).toBe("features");
    expect(screen.queryByText("repo")).toBeNull();
    expect(first.container.querySelector("[data-feature-list]")).not.toBeNull();
    await screen.findByText("No Features yet.");
    await expectNoAxeViolations(first.container);
    first.unmount();

    const second = sidebar();
    await waitFor(() => expect(pressed("Features")).toBe(true));
    expect(second.container.querySelector("[data-feature-list]")).not.toBeNull();
    expect(screen.queryByText("repo")).toBeNull();
  });

  it("steps through all three on the palette's toggle event", async () => {
    sidebar();
    await screen.findByText("repo");
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(pressed("Features")).toBe(true));
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(pressed("Shells")).toBe(true));
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(pressed("Spaces")).toBe(true));
    await screen.findByText("repo");
  });
});
