import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import LinksBanner from "./LinksBanner";
import { setChatCall } from "./chatCalls";

const handlers: (() => void)[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_: string, handler: () => void) => {
    handlers.push(handler);
    return () => {};
  }),
}));

let links: [string, string][] = [];

beforeEach(() => {
  links = [["chat-a", "chat-b"]];
  handlers.length = 0;
  setChatCall(async <T,>(command: string, args: Record<string, unknown>) => {
    if (command === "session_links_of") {
      const me = args.session as string;
      return links.flatMap(([a, b]) => (a === me ? [b] : b === me ? [a] : [])) as T;
    }
    if (command === "session_unlink") links = [];
    return undefined as T;
  });
});

describe("LinksBanner", () => {
  it("shows the chat this one is linked with", async () => {
    const { findByText } = render(() => <LinksBanner sessionId="chat-a" />);
    expect(await findByText("Linked with chat-b")).toBeTruthy();
  });

  it("unlinks, and the other chat drops its line once told", async () => {
    const mine = render(() => <LinksBanner sessionId="chat-a" />);
    const theirs = render(() => <LinksBanner sessionId="chat-b" />);
    expect(await theirs.findByText("Linked with chat-a")).toBeTruthy();

    fireEvent.click(await mine.findByText("Unlink"));
    await waitFor(() => expect(mine.queryByText(/Linked with/)).toBeNull());

    handlers.forEach((h) => h());
    await waitFor(() => expect(theirs.queryByText(/Linked with/)).toBeNull());
  });
});
