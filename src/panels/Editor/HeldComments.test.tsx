import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

let result: "sent" | "blocked" | "timeout" = "sent";
const sent: { text: string; blocks?: unknown[]; submit?: boolean }[] = [];

vi.mock("../../utils/safeSend", async (orig) => ({
  ...(await orig<typeof import("../../utils/safeSend")>()),
  requestSend: (req: { text: string; blocks?: unknown[]; submit?: boolean }) => {
    sent.push(req);
    return Promise.resolve({ kind: result });
  },
}));

import HeldComments from "./HeldComments";
import { clearHeld, heldFor, holdComment } from "../../utils/heldComments";
import type { SessionTarget } from "../../utils/safeSend";

const KEY = "/proj";
const TARGET: SessionTarget = {
  sessionId: "s1",
  agent: "claude",
  profile: null,
  folderPath: "/proj",
  sessionCwd: "/proj",
};

function mountWithTwo() {
  holdComment(KEY, { path: "/proj/a.ts", startLine: 1, endLine: 2, text: "x" });
  holdComment(KEY, { path: "/proj/b.ts", startLine: 4, endLine: 4, text: "y" });
  render(() => <HeldComments heldKey={KEY} folder="/proj" target={TARGET} />);
  fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
}

describe("HeldComments", () => {
  afterEach(() => {
    clearHeld(KEY);
    sent.length = 0;
    result = "sent";
  });

  it("renders nothing while the list is empty", () => {
    render(() => <HeldComments heldKey={KEY} folder="/proj" target={TARGET} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sends every comment as one message and clears the list", async () => {
    mountWithTwo();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(heldFor(KEY)).toEqual([]));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("1) In @a.ts lines 1-2: x 2) In @b.ts lines 4-4: y");
    expect(sent[0].blocks).toHaveLength(4);
    expect(sent[0].submit).toBe(true);
  });

  it.each(["blocked", "timeout"] as const)("keeps the list when the send is %s", async (kind) => {
    result = kind;
    mountWithTwo();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await Promise.resolve();
    expect(heldFor(KEY)).toHaveLength(2);
  });
});
