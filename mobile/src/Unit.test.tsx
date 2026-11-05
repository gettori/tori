import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import UnitScreen from "./Unit";
import { RpcError, type RemoteClient } from "./remote";

const REFUSAL = "This worktree holds ignored files that look like work, which removing it would delete: apps/web/.env.";

describe("removing a worktree from the phone", () => {
  it("shows Tori's refusal and keeps the worktree", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "worktree.remove") throw new RpcError(REFUSAL, -32001);
      return null;
    });
    const client = {
      status: () => "open",
      update: () => null,
      generation: () => 1,
      request,
      subscribe: () => () => {},
    } as unknown as RemoteClient;
    const onRemoved = vi.fn();
    render(() => (
      <UnitScreen
        client={client}
        unit={{ label: "web", folder: "/s/web/web", branch: "web", kind: "worktree", isCurrent: false }}
        project="/s/web"
        back="web"
        live={() => []}
        crew={() => ({ sessions: new Set(), worktrees: new Set() })}
        autopilotOn={false}
        onOpen={() => {}}
        onBack={() => {}}
        onRemoved={onRemoved}
        topics={[]}
        onChanged={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
