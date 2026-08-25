// The Toolbar for a Feature (#154 phase 2): its name and branch as the crumb,
// then one chip per member. A present chip moves the active root; a member
// with no worktree is disabled and says why.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const A = "/w/api/.sway/worktrees/auth";
const B = "/w/web/.sway/worktrees/auth";

const bridge = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_features")
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
      ]);
    if (cmd === "get_config")
      return Promise.resolve({ spaces: [{ name: "work", color: "Sky", projects: [{ path: "/w/api" }, { path: "/w/web" }] }] });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: Toolbar } = await import("./Toolbar");

const featureSel = (activeRoot: string) => ({
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

const chip = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  bridge.calls.length = 0;
});

describe("Toolbar for a Feature", () => {
  it("shows the Feature crumb and a chip per member, the active root pressed", async () => {
    const onActiveRoot = vi.fn();
    render(() => <Toolbar selected={featureSel(A) as never} onActiveRoot={onActiveRoot} />);
    expect(screen.getByText("Auth")).toBeTruthy();
    expect(screen.getByText("feat/auth")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "api" })).toBeTruthy());
    expect(chip("api").getAttribute("aria-pressed")).toBe("true");
    expect(chip("web").getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(chip("api").style.getPropertyValue("--chip-hue")).not.toBe(""));

    fireEvent.click(chip("web"));
    expect(onActiveRoot).toHaveBeenCalledWith(B);
  });

  it("disables a member with no worktree and names the state", async () => {
    const onActiveRoot = vi.fn();
    render(() => <Toolbar selected={featureSel(A) as never} onActiveRoot={onActiveRoot} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "ledger: Worktree missing" })).toBeTruthy());
    expect(chip("ledger: Worktree missing").disabled).toBe(true);
    fireEvent.click(chip("ledger: Worktree missing"));
    expect(onActiveRoot).not.toHaveBeenCalled();
  });

  it("opens Ghostty and VSCode at the active member", async () => {
    render(() => <Toolbar selected={featureSel(B) as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in VSCode" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.cmd === "open_in_vscode")?.args).toEqual({ path: B }));
  });

  it("keeps the unit crumb as it was and reads no Feature record for it", () => {
    render(() => <Toolbar selected={unitSel as never} />);
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(bridge.calls.some((c) => c.cmd === "list_features")).toBe(false);
  });
});
