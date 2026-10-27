import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import InboxScreen, { watchDigest, watchInbox, watchNeedsYou, watchPermissions } from "./Inbox";
import type { RemoteClient } from "./remote";
import type { Digest } from "../../src/utils/digest";
import type { NeedsYouEvent } from "../../src/utils/needsYouSignals";

const pr: NeedsYouEvent = {
  id: "m",
  ts: 2_000,
  session: null,
  folder: "/work/api",
  branch: "fix",
  project: "api",
  title: "#7 Fix it",
  kind: "prMerged",
  resolvedAt: 2_000,
  settled: false,
  chat: false,
};

const digest: Digest = {
  since: 500,
  asOf: 3_000,
  ready: true,
  finished: [
    {
      session: "s-a",
      folder: "/work/app",
      branch: null,
      project: "app",
      title: "run a",
      chat: true,
      turns: 2,
      firstTs: 1_000,
      lastTs: 2_000,
      lines: { added: 120, removed: 30 },
      verdict: "verified",
    },
  ],
  waiting: [],
  happened: [pr],
};

function client(answers: Record<string, unknown>) {
  const request = vi.fn(async (method: string) => answers[method] ?? null);
  const fake = {
    status: () => "open",
    generation: () => 1,
    request,
    subscribe: () => () => {},
  } as unknown as RemoteClient;
  return { fake, request };
}

function mount(answers: Record<string, unknown>) {
  const { fake, request } = client(answers);
  const opened: NeedsYouEvent[] = [];
  const view = render(() => {
    const [inbox, needsYou, digest] = [watchInbox(fake), watchNeedsYou(fake), watchDigest(fake)];
    const permissions = watchPermissions(fake);
    return (
      <InboxScreen
        client={fake}
        inbox={inbox}
        needsYou={needsYou}
        permissions={permissions}
        digest={digest}
        live={() => []}
        onReply={() => {}}
        onEvent={(e) => opened.push(e)}
        onPermission={() => {}}
        onBack={() => {}}
      />
    );
  });
  return { ...view, request, opened };
}

describe("the phone's Since you looked", () => {
  it("lists finished sessions with lines and verdict and pull requests, each opening its own", async () => {
    const { opened } = mount({ "digest.list": digest, "needs_you.list": [], "review.list": [] });
    fireEvent.click(await screen.findByRole("button", { name: /^Since \d/ }));
    const row = (await screen.findByText("run a")).closest("li")!.textContent!;
    expect(row).toContain("+120 -30");
    expect(row).toContain("Verified");
    expect(screen.getByText("Pull requests")).toBeTruthy();
    fireEvent.click(screen.getByText("run a"));
    fireEvent.click(screen.getByText("#7 Fix it"));
    expect(opened.map((e) => [e.session, e.folder])).toEqual([
      ["s-a", "/work/app"],
      [null, "/work/api"],
    ]);
  });

  it("marks the digest seen only once the tab was shown and left", async () => {
    const { request } = mount({ "digest.list": digest, "needs_you.list": [], "review.list": [] });
    const looked = () => request.mock.calls.filter(([m]) => m === "digest.looked");
    fireEvent.click(await screen.findByRole("button", { name: /^Needs you/ }));
    expect(looked()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /^Since \d/ }));
    await screen.findByText("run a");
    fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
    await waitFor(() => expect(looked()).toEqual([["digest.looked", { at: 3_000 }]]));
  });
});
