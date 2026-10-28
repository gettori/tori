import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import type { SendResult, SessionTarget } from "../../utils/safeSend";

let result: SendResult = { kind: "sent" };
const sent: { sessionId: string; text: string; submit?: boolean }[] = [];

vi.mock("../../utils/safeSend", async (orig) => ({
  ...(await orig<typeof import("../../utils/safeSend")>()),
  requestSend: (req: { sessionId: string; text: string; submit?: boolean }) => {
    sent.push(req);
    return Promise.resolve(result);
  },
}));

import SendReply from "./SendReply";

const PARENT: SessionTarget = { sessionId: "parent", agent: "claude", profile: null, folderPath: "/repo" };

describe("SendReply", () => {
  afterEach(() => {
    sent.length = 0;
    result = { kind: "sent" };
  });

  it("submits the reply to the chat it forked from, marked as from a side chat", async () => {
    render(() => <SendReply target={PARENT} text="There is a retry in client.ts." />);
    fireEvent.click(screen.getByRole("button", { name: "Send to chat" }));
    expect(await screen.findByRole("button", { name: "Sent" })).toHaveProperty("disabled", true);
    expect(sent).toEqual([
      {
        ...PARENT,
        text: "From a side chat:\n\nThere is a retry in client.ts.",
        submit: true,
      },
    ]);
  });

  it("says why the chat refused it, in place", async () => {
    result = { kind: "blocked", reason: "This chat is stopped at its spend limit, so nothing was sent." };
    render(() => <SendReply target={PARENT} text="answer" />);
    fireEvent.click(screen.getByRole("button", { name: "Send to chat" }));
    expect(await screen.findByText("This chat is stopped at its spend limit, so nothing was sent.")).toBeTruthy();
  });
});
