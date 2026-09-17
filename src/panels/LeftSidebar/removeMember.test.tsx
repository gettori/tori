// Remove repository, end to end (#159 phase 2). The record detaches first, the
// worktree is offered second, and Keep is a real outcome rather than an undo:
// the member has already left the Feature by the time the dialog opens.
//
// Mounted with the Toolbar beside the sidebar because the half worth pinning is
// the one no unit test reaches: removing the *active* member has to move
// `activeRoot` onto a member that still exists, before anything touches the
// folder, or the crumb keeps naming a repo the Feature no longer has.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { pointerClick } from "../../test/menus";

const REPO_A = "/w/api";
const REPO_B = "/w/web";
const WT_A = `${REPO_A}/.tori/worktrees/auth`;
const WT_B = `${REPO_B}/.tori/worktrees/auth`;

const member = (repoPath: string, displayName: string, worktreePath: string, order: number) => ({
  repoPath,
  displayName,
  worktreePath,
  state: { kind: "present" },
  order,
});

const config = {
  path: "/cfg/tori.toml",
  roots: ["/w"],
  spaces: [
    {
      name: "work",
      path: "/w",
      external: false,
      projects: [
        { name: "api", path: REPO_A, external: false, branchUnits: [] },
        { name: "web", path: REPO_B, external: false, branchUnits: [] },
      ],
    },
  ],
};

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  members: [] as Record<string, unknown>[],
  dirty: false,
}));

const feature = () => ({
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: bridge.members,
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_topics") return Promise.resolve([feature()]);
    if (cmd === "remove_member") {
      bridge.members = bridge.members.filter((m) => m.repoPath !== args.repoPath);
      return Promise.resolve(feature());
    }
    if (cmd === "worktree_status")
      return Promise.resolve({ dirty: bridge.dirty, unpushed: false, hasRemote: false });
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    return Promise.resolve(null);
  },
}));

const handlers = vi.hoisted(() => ({}) as Record<string, ((e: { payload: unknown }) => void)[]>);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (handlers[name] ??= []).push(cb);
    return Promise.resolve(() => {});
  },
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
const { default: Toolbar } = await import("../../components/Toolbar/Toolbar");
const { featureSelection } = await import("../../utils/features");
const { PURGE_UNDER_PATH } = await import("../../utils/events");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");

const changed = () =>
  (handlers["topics://changed"] ?? []).slice().forEach((cb) => cb({ payload: feature() }));
const sent = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd);
const crumbs = () =>
  Array.from(document.querySelectorAll('nav[aria-label="location"] > span')).map((s) => s.textContent);

// The sidebar owns the selection the Toolbar reads, exactly as the shell wires
// them: `onSelect` re-resolves the Feature through `featureSelection`, which is
// where a departed root drops out of `roots` and off `activeRoot`.
async function mount() {
  const [selected, setSelected] = createSignal(featureSelection(feature() as never, WT_A));
  render(() => (
    <>
      <Toolbar selected={selected()} />
      <LeftSidebar
        selected={selected()}
        onSelect={(s) => setSelected(s as never)}
        onActiveRoot={() => {}}
        liveTabs={[]}
      />
    </>
  ));
  // One emit moves the shared resource's generation on, so a second test in
  // this file is not served the first one's record from the cache.
  changed();
  await waitFor(() => expect(crumbs()).toEqual(["Auth", "api", "feat/auth"]));
  fireEvent.click(await screen.findByRole("button", { name: "Show members of Auth" }));
  return selected;
}

const removeRepo = async (repoPath: string) => {
  fireEvent.contextMenu(document.querySelector<HTMLElement>(`li[data-member="${repoPath}"]`)!);
  pointerClick(await screen.findByText("Remove repository"));
  await screen.findByRole("dialog", { name: /Remove worktree/ });
};

describe("Remove repository", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.dirty = false;
    bridge.members = [member(REPO_A, "api", WT_A, 0), member(REPO_B, "web", WT_B, 1)];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.sidebar-mode.v1", "features");
  });

  it("keeps the worktree and leaves it out of the record", async () => {
    const selected = await mount();
    await removeRepo(REPO_B);

    expect(sent("remove_member")[0].args).toEqual({ topicId: "f1", repoPath: REPO_B });
    fireEvent.click(screen.getByRole("button", { name: "Keep worktree" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent("remove_worktree")).toEqual([]);
    expect(sent("remove_worktree_and_branch")).toEqual([]);
    expect(selected()!.roots).toEqual([WT_A]);
  });

  it("purges under the worktree before it removes it", async () => {
    bridge.dirty = true;
    const purges: unknown[] = [];
    const order: string[] = [];
    const onPurge = (e: Event) => {
      purges.push((e as CustomEvent).detail);
      order.push("purge");
    };
    window.addEventListener(PURGE_UNDER_PATH, onPurge);
    try {
      await mount();
      await removeRepo(REPO_B);
      await screen.findByText("uncommitted changes");

      fireEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
      await waitFor(() => expect(sent("remove_worktree_and_branch").length).toBe(1));
      order.push("remove");
    } finally {
      window.removeEventListener(PURGE_UNDER_PATH, onPurge);
    }

    expect(order).toEqual(["purge", "remove"]);
    expect(purges).toEqual([{ path: WT_B }]);
    expect(sent("remove_worktree_and_branch")[0].args).toEqual({
      repoPath: REPO_B,
      worktreePath: WT_B,
      branch: "feat/auth",
      force: true,
    });
  });

  // The whole reason the record goes first: by the time the worktree is offered
  // the Feature no longer has that member, so the crumb must already name one
  // it does. A blank middle segment is what an unmoved `activeRoot` looks like.
  it("moves the active root off the member it removed", async () => {
    const selected = await mount();
    await removeRepo(REPO_A);

    expect(selected()!.activeRoot).toBe(WT_B);
    changed();
    await waitFor(() => expect(crumbs()).toEqual(["Auth", "web", "feat/auth"]));
    // Still before the worktree is touched: Keep is offered, not assumed.
    expect(sent("remove_worktree")).toEqual([]);
  });
});
