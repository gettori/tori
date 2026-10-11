import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const sent: { text: string; submit?: boolean }[] = [];

vi.mock("../../utils/safeSend", async (orig) => ({
  ...(await orig<typeof import("../../utils/safeSend")>()),
  requestSend: (req: { text: string; submit?: boolean }) => {
    sent.push(req);
    return Promise.resolve({ kind: "sent" });
  },
}));

import HunkCommentInput from "./HunkCommentInput";
import { clearHeld, heldFor } from "../../utils/heldComments";
import { writeSendHunkCommentsNow } from "../../utils/hunkCommentPref";
import type { SessionTarget } from "../../utils/safeSend";

const TARGET: SessionTarget = {
  sessionId: "s1",
  agent: "claude",
  profile: null,
  folderPath: "/proj",
  sessionCwd: "/proj",
};

describe("HunkCommentInput with Send hunk comments right away on", () => {
  afterEach(() => {
    writeSendHunkCommentsNow(false);
    clearHeld("/proj");
    sent.length = 0;
  });

  it("sends the one comment as a turn and holds nothing", async () => {
    writeSendHunkCommentsNow(true);
    render(() => <HunkCommentInput heldKey="/proj" target={TARGET} filePath="/proj/a.ts" startLine={1} endLine={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment on this hunk" }));
    fireEvent.input(screen.getByPlaceholderText("Comment on this hunk"), { target: { value: "why" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ text: "In @a.ts lines 1-2: why", submit: true });
    expect(heldFor("/proj")).toEqual([]);
  });
});
