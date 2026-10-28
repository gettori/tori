import { describe, it, expect, vi } from "vite-plus/test";
import { fireEvent, render, screen } from "@solidjs/testing-library";

import { TOAST } from "../../utils/events";

const bridge = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));

const declined = {
  state: "declined",
  digest: "d1",
  content: '{ "setupCommand": "pnpm i" }',
  values: { setupCommand: "pnpm i" },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "proposal_for") {
      return Promise.resolve(args.worktree === "/work/app/feature" ? declined : { state: "none" });
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: ProposalsSection } = await import("./ProposalsSection");
const { noticeProposal } = await import("../../utils/proposals");

describe("a declined proposal", () => {
  it("never toasts, and the project's Tooling section still accepts it", async () => {
    const toasts: unknown[] = [];
    const count = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener(TOAST, count);
    await noticeProposal("/work/app/feature");
    await noticeProposal("/work/app/feature");
    window.removeEventListener(TOAST, count);
    expect(toasts).toHaveLength(0);

    render(() => (
      <ProposalsSection
        project={
          {
            path: "/work/app",
            branchUnits: [{ folderPath: "/work/app/feature", kind: "worktree" }],
          } as never
        }
      />
    ));
    await vi.waitFor(() => expect(screen.getByText("feature")).toBeTruthy());
    expect(screen.queryByText("app")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await vi.waitFor(() =>
      expect(bridge.calls.find((c) => c.cmd === "accept_proposal")?.args).toEqual({
        worktree: "/work/app/feature",
        digest: "d1",
      }),
    );
  });
});
