import { describe, it, expect, vi } from "vite-plus/test";
import { fireEvent, render, screen } from "@solidjs/testing-library";

const bridge = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));

const PREVIOUS = '{\n  "setupCommand": "pnpm i"\n}';
const CONTENT = '{\n  "setupCommand": "pnpm i && pnpm db:seed",\n  "ports": 3\n}';

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "proposal_for") {
      return Promise.resolve({
        state: "unaccepted",
        digest: "d2",
        content: CONTENT,
        values: { setupCommand: "pnpm i && pnpm db:seed", ports: 3 },
        previous: PREVIOUS,
      });
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: ProposalDialog } = await import("./ProposalDialog");
const { openReview } = await import("../../utils/proposals");

describe("reviewing a repo's proposal", () => {
  it("shows the fields and the diff against the last accepted content, and accepts by digest", async () => {
    render(() => <ProposalDialog />);
    await openReview("/work/app/feature");

    await vi.waitFor(() => expect(screen.getByText("pnpm i && pnpm db:seed")).toBeTruthy());
    expect(screen.getByText("3")).toBeTruthy();
    const rows = [...document.querySelectorAll("[data-proposal-diff] [data-kind]")].map(
      (row) => `${row.getAttribute("data-kind")} ${row.textContent}`,
    );
    expect(rows).toContain('del -   "setupCommand": "pnpm i"');
    expect(rows).toContain('add +   "setupCommand": "pnpm i && pnpm db:seed",');
    expect(rows).toContain('add +   "ports": 3');

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await vi.waitFor(() =>
      expect(bridge.calls.find((c) => c.cmd === "accept_proposal")?.args).toEqual({
        worktree: "/work/app/feature",
        digest: "d2",
      }),
    );
    expect(document.querySelector("[data-proposal-diff]")).toBeNull();
  });
});
