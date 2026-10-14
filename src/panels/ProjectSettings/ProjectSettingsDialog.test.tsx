import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";

const saves: { worktree: Record<string, unknown>; reviewRequested?: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_settings") {
      saves.push(args!.settings as (typeof saves)[number]);
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
    if (cmd === "review_rule_state") {
      return Promise.resolve({ paused: false, defaultPrompt: "Review this pull request." });
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

describe("Project settings dialog, left alone", () => {
  it("saves nothing", async () => {
    saves.length = 0;
    render(() => <ProjectSettingsDialog path="/p" onClose={() => {}} />);
    await screen.findByRole("tab", { name: "Automations" });
    await new Promise((r) => setTimeout(r, 200));
    expect(saves).toHaveLength(0);
  });
});

describe("Project settings dialog, Automations section", () => {
  it("saves the review rule and its prompt, and search finds it by review", async () => {
    saves.length = 0;
    render(() => <ProjectSettingsDialog path="/p" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Automations" }));

    pointerClick(screen.getByRole("button", { name: /When your review is requested/ }));
    pointerClick(await screen.findByRole("option", { name: "Create a worktree and review it" }));
    await waitFor(() => expect(saves[saves.length - 1]?.reviewRequested?.["/p"]).toMatchObject({ action: "review" }));

    const prompt = (await screen.findByLabelText("Review prompt")) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "  Check the migrations.  " } });
    await waitFor(() =>
      expect(saves[saves.length - 1]?.reviewRequested?.["/p"]).toEqual({
        action: "review",
        prompt: "Check the migrations.",
        maxPerHour: 5,
        agent: null,
        account: null,
        model: null,
        effort: null,
        mode: null,
      }),
    );

    fireEvent.input(screen.getByLabelText("Search project settings"), { target: { value: "review" } });
    await waitFor(() =>
      expect(screen.getByText("When your review is requested").closest("section")?.hidden).toBe(false),
    );
  });
});
