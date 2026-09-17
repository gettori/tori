// The Toolbar for a Topic (#154 phase 2): its name and branch as the crumb,
// then one chip per member. A present chip moves the active root; a member
// with no worktree is disabled and says why.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const A = "/w/api/.tori/worktrees/auth";
const B = "/w/web/.tori/worktrees/auth";

const bridge = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_topics")
      return Promise.resolve([
        {
          id: "f1",
          name: "Auth",
          branch: "feat/auth",
          createdAt: 1,
          members: [
            { repoPath: "/w/api", displayName: "api", worktreePath: A, state: { kind: "present" }, order: 0 },
            { repoPath: "/w/web", displayName: "web", worktreePath: B, state: { kind: "present" }, order: 1 },
            { repoPath: "/w/ledger", displayName: "ledger", worktreePath: null, state: { kind: "worktree-missing" }, order: 2 },
          ],
        },
        // A second record rather than a second mock: `topicMembers` reads once
        // per generation module-wide, so a test that swapped this payload would
        // be served the first one from the cache.
        {
          id: "f2",
          name: "Broken",
          branch: "feat/broken",
          createdAt: 2,
          members: [
            { repoPath: "/w/api", displayName: "api", worktreePath: null, state: { kind: "worktree-missing" }, order: 0 },
          ],
        },
      ]);
    if (cmd === "get_config")
      return Promise.resolve({ spaces: [{ name: "work", color: "Sky", projects: [{ path: "/w/api" }, { path: "/w/web" }] }] });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: Toolbar } = await import("./Toolbar");

const topicSel = (activeRoot: string) => ({
  kind: "feature",
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
  spaceName: "work",
  projectName: "api",
  projectPath: "/w/api",
  folderPath: "/w/api",
  branch: "main",
  projectKind: "plain",
};

const sessionSel = {
  ...unitSel,
  branch: "bugfix-260903",
  agent: "claude",
  sessionId: "s1",
  sessionPath: "/w/api/s1.jsonl",
  sessionCwd: "/w/api",
  sessionTitle: "For a log prompt, when sent pressing enter it goes under the input field",
  sessionName: null,
};

const brokenSel = {
  kind: "feature",
  featureId: "f2",
  featureName: "Broken",
  roots: [],
  activeRoot: null,
  spaceName: "",
  projectName: "Broken",
  projectPath: "",
  folderPath: "",
  branch: "feat/broken",
  projectKind: "feature",
};

const chip = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const crumbs = () =>
  [...document.querySelectorAll("nav[aria-label='location'] > span")].map((s) => s.textContent);

beforeEach(() => {
  bridge.calls.length = 0;
});

describe("Toolbar for a Feature", () => {
  it("shows the Feature crumb and a chip per member, the active root pressed", async () => {
    const onActiveRoot = vi.fn();
    render(() => <Toolbar selected={topicSel(A) as never} onActiveRoot={onActiveRoot} />);
    expect(screen.getByText("Auth")).toBeTruthy();
    expect(screen.getByText("feat/auth")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "api" })).toBeTruthy());
    expect(chip("api").getAttribute("aria-pressed")).toBe("true");
    expect(chip("web").getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(chip("api").style.getPropertyValue("--chip-hue")).not.toBe(""));

    fireEvent.click(chip("web"));
    expect(onActiveRoot).toHaveBeenCalledWith(B);
  });

  it("names the active member between the Feature and its branch", async () => {
    // Three crumbs, and the middle one follows the chip row: the crumb says
    // where you are, the chips are what move it (#158).
    const onActiveRoot = vi.fn();
    render(() => <Toolbar selected={topicSel(B) as never} onActiveRoot={onActiveRoot} />);
    await waitFor(() => expect(crumbs()).toEqual(["Auth", "web", "feat/auth"]));

    fireEvent.click(chip("api"));
    expect(onActiveRoot).toHaveBeenCalledWith(A);
  });

  it("falls back to two crumbs when no member is open, with no dangling separator", async () => {
    render(() => <Toolbar selected={brokenSel as never} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /api/ })).toBeTruthy());
    // Not an empty middle crumb: the separator leaves with the name it followed.
    expect(crumbs()).toEqual(["Broken", "feat/broken"]);
    expect(document.querySelectorAll("nav[aria-label='location'] svg").length).toBe(1);
  });

  it("disables a member with no worktree and names the state", async () => {
    const onActiveRoot = vi.fn();
    render(() => <Toolbar selected={topicSel(A) as never} onActiveRoot={onActiveRoot} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "ledger: Worktree missing" })).toBeTruthy());
    expect(chip("ledger: Worktree missing").disabled).toBe(true);
    fireEvent.click(chip("ledger: Worktree missing"));
    expect(onActiveRoot).not.toHaveBeenCalled();
  });

  // The two hand-offs moved to the right end of the topbar
  // (`components/HandOffs`), so the crumb row carries no launch buttons at all
  // now. Asserted rather than assumed: a crumb that grew one back would put a
  // second Ghostty button on the bar.
  it("carries no launch buttons, only the crumb and its chips", async () => {
    render(() => <Toolbar selected={topicSel(B) as never} />);
    await waitFor(() => expect(chip("web")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /Ghostty/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /VSCode/ })).toBeNull();
  });

  it("keeps the unit crumb as it was and reads no Feature record for it", () => {
    render(() => <Toolbar selected={unitSel as never} />);
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(bridge.calls.some((c) => c.cmd === "list_topics")).toBe(false);
  });

  it("ends the crumb at the branch when a chat is focused", () => {
    // Focusing a chat tab puts its sessionId on the Selection, which used to add
    // a fourth crumb repeating the tab's own agent mark and title.
    render(() => <Toolbar selected={sessionSel as never} />);
    expect(crumbs()).toEqual(["work", "api", "bugfix-260903"]);
    expect(screen.queryByText(sessionSel.sessionTitle)).toBeNull();
    expect(document.querySelector("nav[aria-label='location'] .claude-icon")).toBeNull();
  });
});
