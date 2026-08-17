import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// History's end of the seam: it names a session and an action, and the sidebar
// answers exactly as its own row would. What matters is that the answer is the
// *same* one - the plain-repo checkout guard, the destructive confirm and the
// close-the-child-first ordering are all things that only exist here.
const REPO = "/root/work/repo";

const plain = (branch: string, isCurrent: boolean) => ({
  label: branch,
  folderPath: REPO, // a plain repo: both rows over one working directory
  branch,
  kind: "plain",
  isCurrent,
});

const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      external: false,
      projects: [
        {
          name: "repo",
          path: REPO,
          external: false,
          // `main` is checked out; the session below recorded `feat`.
          branchUnits: [plain("main", true), plain("feat", false)],
        },
      ],
    },
  ],
};

const session = {
  id: "s1",
  path: `${REPO}/.t/s1.jsonl`,
  cwd: REPO,
  branch: "feat",
  title: "the session",
  last_active: 1_700_000_000,
  created_at: 1_700_000_000,
  name: null,
  agent: "claude",
};

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  /** Which agent produced the folder's one session. `gemini` is the bundled
   *  adapter with no parser kind, so its sessions have no transcript. */
  agent: "claude",
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") return Promise.resolve([{ ...session, agent: bridge.agent }]);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    if (cmd === "sessions_running") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    isFocused: () => Promise.resolve(true),
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { sessions, resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { SESSION_ACTION, SESSION_DELETED, emitWith } = await import("../../utils/events");

const cmds = () => bridge.calls.map((c) => c.cmd);

/** Mount the sidebar and wait until its store holds the folder's session, which
 *  is what any of these actions resolves the bare id through. */
async function mounted(onSelect: (s: unknown) => void = () => {}) {
  const r = render(() => <LeftSidebar selected={null} onSelect={onSelect} liveTabs={[]} />);
  await waitFor(() => expect(sessions()[REPO]?.length).toBe(1));
  bridge.calls.length = 0;
  return r;
}

const act = (action: "open" | "rename" | "delete") =>
  emitWith(SESSION_ACTION, { sessionId: "s1", action });

describe("a session action raised from outside the tree", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.agent = "claude";
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
  });

  // The guard that only the selection chain has: on a plain repo the session's
  // recorded branch is not the checkout, and opening it would otherwise show
  // the wrong files under the right title.
  it("routes an open through the plain-repo checkout guard", async () => {
    const picked: unknown[] = [];
    await mounted((s) => picked.push(s));

    act("open");
    await waitFor(() => expect(screen.getByText('Switch repo to “feat”?')).toBeTruthy());

    // Cancelled: nothing was checked out and the selection did not move.
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText('Switch repo to “feat”?')).toBeNull());
    expect(cmds()).not.toContain("git_checkout");
    expect(picked).toHaveLength(0);
  });

  it("carries the open through once the checkout is agreed to", async () => {
    const picked: { sessionId?: string }[] = [];
    await mounted((s) => picked.push(s as { sessionId?: string }));

    act("open");
    await waitFor(() => expect(screen.getByText("Switch")).toBeTruthy());
    fireEvent.click(screen.getByText("Switch"));

    await waitFor(() => expect(cmds()).toContain("git_checkout"));
    await waitFor(() => expect(picked.map((p) => p.sessionId)).toContain("s1"));
  });

  // Delete is the one action that cannot be half-done: the child holds the
  // session id, so closing it has to come first or the transcript is removed
  // from under a process still writing one and still holding a claim nothing
  // can reclaim.
  it("confirms a delete, closes the child first, and tells the tab to go", async () => {
    const closed: string[] = [];
    const onDeleted = (e: Event) => closed.push((e as CustomEvent).detail.sessionId);
    window.addEventListener(SESSION_DELETED, onDeleted);
    await mounted();

    act("delete");
    await waitFor(() => expect(screen.getByText("Delete this session’s transcript?")).toBeTruthy());
    // Nothing has happened yet: the confirm is a real gate, not a notice.
    expect(cmds()).not.toContain("delete_session");

    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(cmds()).toContain("delete_session"));
    expect(cmds().indexOf("chat_close")).toBeLessThan(cmds().indexOf("delete_session"));
    expect(closed).toEqual(["s1"]);
    window.removeEventListener(SESSION_DELETED, onDeleted);
  });

  // A session with no transcript is a different act wearing the same button.
  // Its conversation lives wherever its agent keeps it, no protocol verb
  // removes one, and all that happens is that Sway stops listing it - so
  // promising that the history is gone would be promising something Sway
  // cannot do, to somebody who would believe it.
  it("says it is forgetting, not deleting, a session with no transcript", async () => {
    bridge.agent = "gemini";
    await mounted();

    act("delete");
    await waitFor(() => expect(screen.getByText("Forget this session?")).toBeTruthy());
    expect(screen.queryByText("Delete this session’s transcript?")).toBeNull();
    expect(document.body.textContent).toContain("cannot delete its copy");

    fireEvent.click(screen.getByText("Forget"));
    await waitFor(() => expect(cmds()).toContain("delete_session"));
    // The backend decides which of the two it is doing from the agent, so the
    // agent has to be sent: without it, `delete_session` would take the path
    // for a transcript and remove Sway's record by the wrong route.
    const call = bridge.calls.find((c) => c.cmd === "delete_session")!;
    expect(call.args.agent).toBe("gemini");
  });

  it("cancels a delete without touching the transcript", async () => {
    await mounted();
    act("delete");
    await waitFor(() => expect(screen.getByText("Delete this session’s transcript?")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Delete this session’s transcript?")).toBeNull());
    expect(cmds()).not.toContain("delete_session");
  });

  it("prompts for a new name on rename", async () => {
    await mounted();
    act("rename");
    await waitFor(() => expect(screen.getByText("Rename session:")).toBeTruthy());
  });

  // The id is all History sends, so an id the store cannot place must be a
  // no-op rather than a dialog about nothing.
  it("does nothing for a session it cannot place", async () => {
    await mounted();
    emitWith(SESSION_ACTION, { sessionId: "nope", action: "delete" });
    await Promise.resolve();
    expect(cmds()).not.toContain("chat_close");
  });
});
