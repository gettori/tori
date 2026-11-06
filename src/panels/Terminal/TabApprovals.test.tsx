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

import TabApprovals from "./TabApprovals";
import { showAsk, type SocketAsk } from "../../utils/socketAsks";

const onTab = (id: string, tab: string): SocketAsk => ({
  id,
  session: tab,
  question: "Open this pull request?",
  options: ["Approve", "Reject"],
  approval: {
    project: "/work/repo",
    action: "pr.create",
    head: "203-gate",
    base: "main",
    title: "Gate outward actions",
    body: "Closes the gap.",
    draft: false,
    head_sha: "abc123",
  },
  shown_in: [],
  surface: { kind: "tab", id: tab },
});

describe("an approval asked from a terminal tab", () => {
  it("draws in that tab only, with Reject focused, and sends the answer", async () => {
    showAsk(onTab("ask-1", "t1"));
    showAsk(onTab("ask-2", "t2"));
    render(() => <TabApprovals tab="t1" active />);

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByText("Gate outward actions")).toBeTruthy();
    const reject = screen.getByRole("button", { name: "Reject" });
    await waitFor(() => expect(document.activeElement).toBe(reject));

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(invokes).toContainEqual({ cmd: "rpc_ask_answer", args: { id: "ask-1", answer: "Approve" } }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
