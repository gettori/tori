import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";

const saves = vi.hoisted(() => [] as { worktree: Record<string, { ports?: number }> }[]);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_settings") {
      saves.push(args!.settings as (typeof saves)[number]);
      return Promise.resolve(args!.settings);
    }
    if (cmd === "get_config") {
      const plain = { name: "p", path: "/p", branchUnits: [{ folderPath: "/p", kind: "plain" }] };
      const bare = { name: "b", path: "/b", branchUnits: [{ folderPath: "/b/main", kind: "worktree" }] };
      return Promise.resolve({ spaces: [{ name: "work", projects: [plain, bare] }] });
    }
    if (cmd === "review_rule_state") {
      return Promise.resolve({ paused: false, defaultPrompt: "Review this pull request." });
    }
    if (cmd === "proposal_for") return Promise.resolve({ state: "none" });
    if (cmd === "verification_commands" || cmd === "verification_defaults") return Promise.resolve([]);
    return Promise.resolve(null);
  },
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: ProjectSettingsDialog } = await import("./ProjectSettingsDialog");

afterEach(cleanup);

const tooling = () => document.querySelector('[data-pane="tooling"]')!;

describe("Tooling's command rows", () => {
  it("are a plain repo's, since it has no Worktrees section", async () => {
    render(() => <ProjectSettingsDialog path="/p" section="tooling" onClose={() => {}} />);
    await screen.findByRole("tab", { name: "Tooling" });
    expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
    expect(tooling().querySelector('[aria-label="Setup command"]')).not.toBeNull();
  });

  it("stay in a bare container's Worktrees section", async () => {
    render(() => <ProjectSettingsDialog path="/b" section="tooling" onClose={() => {}} />);
    await screen.findByRole("tab", { name: "Worktrees" });
    expect(tooling().querySelector('[aria-label="Setup command"]')).toBeNull();
    expect(document.querySelector('[data-pane="worktrees"] [aria-label="Setup command"]')).not.toBeNull();
  });
});

describe("the port width row", () => {
  it("saves the width under the project", async () => {
    render(() => <ProjectSettingsDialog path="/p" section="tooling" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Decrease Ports per worktree" }));
    await waitFor(() => expect(saves[saves.length - 1]?.worktree["/p"].ports).toBe(9));
  });
});
