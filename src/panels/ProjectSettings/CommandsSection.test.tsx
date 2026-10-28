import { describe, it, expect, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";

const accepted = (digest: string, setupCommand: string) => ({ state: "accepted", digest, values: { setupCommand } });

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return Promise.resolve(args.settings);
    if (cmd === "proposal_for") {
      if (args.worktree === "/work/app/one") return Promise.resolve(accepted("d1", "pnpm i"));
      if (args.worktree === "/work/app/two") return Promise.resolve(accepted("d2", "pnpm i && pnpm db:seed"));
      return Promise.resolve({ state: "none" });
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: CommandsSection } = await import("./CommandsSection");
const { createProposals } = await import("../../utils/proposals");

describe("a command the user left empty", () => {
  it("lists each accepted repo value with the worktrees running it, until the user types one", async () => {
    const project = {
      path: "/work/app",
      branchUnits: [
        { folderPath: "/work/app/one", kind: "worktree" },
        { folderPath: "/work/app/two", kind: "worktree" },
      ],
    } as never;
    render(() => {
      const answered = createProposals(() => project);
      return <CommandsSection projectPath="/work/app" answered={answered()} />;
    });

    await waitFor(() => expect(screen.getByText("pnpm i && pnpm db:seed")).toBeTruthy());
    const rows = () =>
      [...document.querySelectorAll("[data-repo-values] li")].map((li) =>
        [...li.children].map((c) => c.textContent).join(" "),
      );
    expect(rows()).toEqual(["repo pnpm i in one", "repo pnpm i && pnpm db:seed in two"]);

    fireEvent.change(screen.getByLabelText("Setup command"), { target: { value: "make setup" } });
    await waitFor(() => expect(rows()).toEqual([]));
    expect(screen.queryByText("repo")).toBeNull();
  });
});
