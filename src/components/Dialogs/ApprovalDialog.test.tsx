import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const invokes = vi.hoisted(() => [] as { cmd: string; args: Record<string, unknown> }[]);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args });
    return Promise.resolve(true);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import ApprovalDialog from "./ApprovalDialog";
import { showAsk, type SocketAsk } from "../../utils/socketAsks";

const outside = (id: string, number: number): SocketAsk => ({
  id,
  session: "outside",
  question: `Merge pull request ${number}?`,
  options: ["Approve", "Reject"],
  approval: { project: "/work/repo", action: "pr.merge", number, method: "squash", head_sha: "abc123" },
  shown_in: [],
  surface: { kind: "window" },
});

describe("an approval asked by a shell outside Tori", () => {
  it("shows one at a time, naming the caller, and the next once answered", async () => {
    render(() => <ApprovalDialog />);
    showAsk(outside("ask-1", 7));
    showAsk(outside("ask-2", 8));

    expect(await screen.findByText("A shell outside Tori asks")).toBeTruthy();
    expect(screen.getByText("Merge pull request 7?")).toBeTruthy();
    expect(screen.queryByText("Merge pull request 8?")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reject" })));

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(invokes).toContainEqual({ cmd: "rpc_ask_answer", args: { id: "ask-1", answer: "Reject" } }),
    );
    expect(await screen.findByText("Merge pull request 8?")).toBeTruthy();
  });
});
