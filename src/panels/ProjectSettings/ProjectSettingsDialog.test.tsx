import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";

const saves: { worktree: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_settings") {
      saves.push(args!.settings as { worktree: Record<string, unknown> });
      return Promise.resolve(args!.settings);
    }
    if (cmd === "get_config") {
      return Promise.resolve({
        spaces: [
          {
            name: "work",
            projects: [{ name: "p", path: "/p", branchUnits: [{ folderPath: "/p/main", kind: "worktree" }] }],
          },
        ],
      });
    }
    if (cmd === "shared_overview") {
      return Promise.resolve({ dir: "/p/.shared", exists: false, worktrees: [], entries: [] });
    }
    return Promise.resolve(null);
  },
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: ProjectSettingsDialog } = await import("./ProjectSettingsDialog");

afterEach(cleanup);

describe("Project settings dialog, Worktrees section", () => {
  it("saves the setup command under the container and shows it on reopen", async () => {
    render(() => <ProjectSettingsDialog path="/p" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Worktrees" }));

    const field = screen.getByLabelText("Setup command") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "  pnpm install  " } });
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].worktree["/p"]).toEqual({ setupCommand: "pnpm install", setupWait: false });

    cleanup();
    render(() => <ProjectSettingsDialog path="/p" section="worktrees" onClose={() => {}} />);
    await screen.findByRole("tab", { name: "Worktrees" });
    expect((screen.getByLabelText("Setup command") as HTMLInputElement).value).toBe("pnpm install");
  });
});
