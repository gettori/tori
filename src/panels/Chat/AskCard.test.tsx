import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];

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

import AskCard from "./AskCard";
import type { AskApproval, SocketAsk } from "../../utils/socketAsks";

const approvalAsk = (approval: AskApproval): SocketAsk => ({
  id: "ask-1",
  session: "worker",
  question: "Post this?",
  options: ["Approve", "Reject"],
  approval,
  shown_in: ["worker", "autopilot"],
});

beforeEach(() => {
  invokes.length = 0;
});

describe("an approval card", () => {
  it("shows the pull request it would open", () => {
    render(() => (
      <AskCard
        here="worker"
        ask={approvalAsk({
          project: "/work/repo",
          action: "pr.create",
          head: "203-gate",
          base: "main",
          title: "Gate outward actions",
          body: "Closes the gap.",
          draft: true,
          head_sha: "abc123",
        })}
      />
    ));
    expect(screen.getByText("Gate outward actions")).toBeTruthy();
    expect(screen.getByText(/203-gate at abc123 into main, as a draft/)).toBeTruthy();
    expect(screen.getByText("Closes the gap.")).toBeTruthy();
    expect(screen.getByText("/work/repo")).toBeTruthy();
  });

  it("shows the review verdict, body and every line comment", () => {
    render(() => (
      <AskCard
        here="worker"
        ask={approvalAsk({
          project: "/work/repo",
          action: "review.submit",
          number: 42,
          event: "requestChanges",
          body: "Two things.",
          comments: [
            { path: "src/a.rs", line: 7, side: "RIGHT", startLine: null, startSide: null, body: "Name this." },
            { path: "src/b.rs", line: 18, side: "LEFT", startLine: 12, startSide: "LEFT", body: "Why drop these?" },
          ],
          head_sha: "abc123",
        })}
      />
    ));
    expect(screen.getByText("Request changes on pull request 42")).toBeTruthy();
    expect(screen.getByText("at abc123")).toBeTruthy();
    expect(screen.getByText("Two things.")).toBeTruthy();
    expect(screen.getByText("src/a.rs:7")).toBeTruthy();
    expect(screen.getByText("src/b.rs:12-18 (base)")).toBeTruthy();
    expect(screen.getByText("Name this.")).toBeTruthy();
  });

  it("shows the merge, its method and the head it pins", () => {
    render(() => (
      <AskCard here="worker" ask={approvalAsk({ project: "/work/repo", action: "pr.merge", number: 42, method: "squash", head_sha: "abc123" })} />
    ));
    expect(screen.getByText("Merge pull request 42")).toBeTruthy();
    expect(screen.getByText("squash at abc123")).toBeTruthy();
  });

  it("names the asking session when mirrored into another panel", () => {
    render(() => (
      <AskCard here="autopilot" ask={approvalAsk({ project: "/work/repo", action: "pr.merge", number: 42, method: "squash", head_sha: "abc123" })} />
    ));
    expect(screen.getByText(/worker asks:/)).toBeTruthy();
  });

  it("still answers with the option picked", async () => {
    render(() => (
      <AskCard here="worker" ask={approvalAsk({ project: "/work/repo", action: "pr.merge", number: 42, method: "squash", head_sha: "abc123" })} />
    ));
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(invokes).toContainEqual({ cmd: "rpc_ask_answer", args: { id: "ask-1", answer: "Approve" } }));
  });
});
