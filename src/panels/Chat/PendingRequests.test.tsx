import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, fireEvent, waitFor } from "../../test/harness";
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
    expect(calls).toContainEqual(["chat_request_accept", { session: "me", id: "req-1", link: false }]);
  });

  it("discards a message without delivering it", async () => {
    const { findByText, queryByText } = render(() => <PendingRequests sessionId="me" />);
    fireEvent.click(await findByText("Discard"));
    await waitFor(() => expect(queryByText(/please rebase/)).toBeNull());
    expect(calls).toContainEqual(["chat_request_discard", { session: "me", id: "req-1" }]);
    expect(calls.some(([c]) => c === "chat_request_accept")).toBe(false);
  });

  it("links the two chats when a person presses Link, delivering once", async () => {
    const { findByText, queryByText } = render(() => <PendingRequests sessionId="me" />);
    fireEvent.click(await findByText("Link"));
    await waitFor(() => expect(queryByText(/please rebase/)).toBeNull());
    const accepts = calls.filter(([c]) => c === "chat_request_accept");
    expect(accepts).toEqual([["chat_request_accept", { session: "me", id: "req-1", link: true }]]);
  });
});

describe("the waiting list", () => {
  function hold() {
    let resolve!: (value: ChatRequest[]) => void;
    const promise = new Promise<ChatRequest[]>((yes) => (resolve = yes));
    return { promise, resolve };
  }

  it("shows no banner until the list is read, then one per message", async () => {
    const list = hold();
    setChatCall(async <T,>(command: string) => (command === "chat_requests_list" ? (list.promise as T) : (true as T)));
    const { container, findByText } = render(() => <PendingRequests sessionId="me" />);
    expect(container.textContent).toBe("");

    list.resolve([request]);
    expect(await findByText(/please rebase/)).toBeTruthy();
  });

  // A refresh after a change elsewhere asks the same question again, so the
  // banner stays until the new answer is in.
  it("keeps the banner while the list is read again", async () => {
    let next: () => Promise<ChatRequest[]> = async () => [request];
    setChatCall(async <T,>(command: string) =>
      command === "chat_requests_list" ? ((await next()) as T) : (true as T),
    );
    const { findByText, getByText, queryByText } = render(() => <PendingRequests sessionId="me" />);
    await findByText(/please rebase/);

    const again = hold();
    next = () => again.promise;
    fireEvent.click(getByText("Discard"));
    await waitFor(() => expect(getByText("Discard").closest("button")?.disabled).toBe(false));
    expect(getByText(/please rebase/)).toBeTruthy();

    again.resolve([]);
    await waitFor(() => expect(queryByText(/please rebase/)).toBeNull());
  });

  it("says the list could not be read, in place, and can ask again", async () => {
    let fail = true;
    setChatCall(async <T,>(command: string) => {
      if (command !== "chat_requests_list") return true as T;
      if (fail) throw "store locked";
      return [request] as T;
    });
    const { findByText, getByText } = render(() => <PendingRequests sessionId="me" />);
    expect(await findByText(/could not be read: store locked/)).toBeTruthy();

    fail = false;
    fireEvent.click(getByText("Try again"));
    expect(await findByText(/please rebase/)).toBeTruthy();
  });
});
