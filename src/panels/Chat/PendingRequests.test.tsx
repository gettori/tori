import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import PendingRequests, { type ChatRequest } from "./PendingRequests";
import { setChatCall } from "./chatCalls";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const request: ChatRequest = { id: "req-1", from: "other-chat-id", text: "please rebase", attach: [], at: 1 };

let held: ChatRequest[] = [];
const calls: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  held = [request];
  calls.length = 0;
  setChatCall(async <T,>(command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command === "chat_requests_list") return held as T;
    held = [];
    return true as T;
  });
});

describe("PendingRequests", () => {
  it("accepts a message and then shows it no more", async () => {
    const { findByText, queryByText } = render(() => <PendingRequests sessionId="me" />);
    fireEvent.click(await findByText("Accept"));
    await waitFor(() => expect(queryByText(/please rebase/)).toBeNull());
    expect(calls).toContainEqual(["chat_request_accept", { session: "me", id: "req-1" }]);
  });

  it("discards a message without delivering it", async () => {
    const { findByText, queryByText } = render(() => <PendingRequests sessionId="me" />);
    fireEvent.click(await findByText("Discard"));
    await waitFor(() => expect(queryByText(/please rebase/)).toBeNull());
    expect(calls).toContainEqual(["chat_request_discard", { session: "me", id: "req-1" }]);
    expect(calls.some(([c]) => c === "chat_request_accept")).toBe(false);
  });
});
