import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, cleanup } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import { expectNoAxeViolations } from "../../test/axe";
import { Toast } from "../../lib/toast";
import { LAST_MEMBER, type Topic, type Member, type MemberState } from "../../utils/topics";

function member(repoPath: string, order: number, state: MemberState = { kind: "present" }): Member {
  return {
    repoPath,
    displayName: repoPath.split("/").pop()!,
    worktreePath: null,
    state,
    order,
  };
}

// A present member's worktree carries the Topic's slug, so two Topics over
// the same repo never share a root. The change count is keyed by root, and a
// shared one would put Auth's number on the Payments row.
const wt = (members: Member[], slug: string) =>
  members.map((m) => ({
    ...m,
    worktreePath: m.state.kind === "present" ? `${m.repoPath}/.tori/worktrees/${slug}` : null,
  }));

const AUTH: Topic = {
  id: "auth-1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: wt([member("/w/api", 0), member("/w/web", 1)], "auth"),
};
const PAY: Topic = {
  id: "pay-1",
  name: "Payments",
  branch: "feat/payments",
  createdAt: 2,
  members: wt(
    [member("/w/api", 0), member("/w/ledger", 1, { kind: "failed", reason: "refusing to overwrite" })],
    "payments",
  ),
};

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  topics: null as Topic[] | null,
  created: null as Topic | null,
  // What `pick_folder` answers; null is the cancelled picker.
  picked: null as string | null,
  // Whether `delete_topic` refuses, what `worktree_status` answers per worktree
  // path, and which worktree paths `remove_worktree*` refuses, for the sweep.
  failDelete: false,
  wtStatus: {} as Record<string, { dirty: boolean; unpushed: boolean }>,
  refuse: new Set<string>(),
  // Held answers, so a test can decide *when* the backend replies: the bugs
  // below are both about what happens between the ask and the answer.
  holdStatus: null as null | (() => void),
  holdDelete: null as null | (() => void),
  holdRemove: null as null | (() => void),
  running: {} as Record<string, number>,
  // What `git_status` answers per member root, for the row's change count.
  status: {} as Record<string, unknown[]>,
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_topics") return Promise.resolve(bridge.topics);
    if (cmd === "git_status") return Promise.resolve(bridge.status[String(args?.projectPath)] ?? []);
    if (cmd === "create_topic") return Promise.resolve(bridge.created);
    if (cmd === "worktree_status") {
      const answer = {
        ...(bridge.wtStatus[String(args?.path)] ?? { dirty: false, unpushed: false }),
        hasRemote: false,
      };
      if (!bridge.holdStatus) return Promise.resolve(answer);
      return new Promise((resolve) => {
        const prev = bridge.holdStatus!;
        bridge.holdStatus = () => {
          prev();
          resolve(answer);
        };
      });
    }
    if (cmd === "remove_worktree" || cmd === "remove_worktree_and_branch") {
      const settle = bridge.refuse.has(String(args?.worktreePath))
        ? () => Promise.reject(new Error("worktree is locked"))
        : () => Promise.resolve(null);
      if (!bridge.holdRemove) return settle();
      return new Promise((resolve, reject) => {
        const prev = bridge.holdRemove!;
        bridge.holdRemove = () => {
          prev();
          settle().then(resolve, reject);
        };
      });
    }
    if (cmd === "pick_folder") return Promise.resolve(bridge.picked);
    if (cmd === "delete_topic") {
      const settle = () =>
        bridge.failDelete ? Promise.reject(new Error("delete refused")) : Promise.resolve(null);
      if (!bridge.holdDelete) return settle();
      return new Promise((resolve, reject) => {
        bridge.holdDelete = () => settle().then(resolve, reject);
      });
    }
    // Both repairs answer with the reconciled record: `relocate_member` also
    // rewrites `repoPath`, which is the one field a member's identity is.
    if (cmd === "retry_member" || cmd === "relocate_member") {
      const at = (bridge.topics ?? []).findIndex((f) => f.id === args.topicId);
      if (at < 0) return Promise.reject(new Error(`No Topic with id ${args.topicId}`));
      const f = bridge.topics![at];
      const next: Topic = {
        ...f,
        members: f.members.map((m) =>
          m.repoPath === args.repoPath
            ? {
                ...m,
                repoPath: args.newRepoPath ? String(args.newRepoPath) : m.repoPath,
                state: { kind: "present" } as MemberState,
              }
            : m,
        ),
      };
      bridge.topics = bridge.topics!.map((x, i) => (i === at ? next : x));
      return Promise.resolve(next);
    }
    // The record-only commands answer with the reloaded Topic, the shape the
    // backend took on when it started emitting `topics://changed` for them.
    if (RECORD_ONLY.has(cmd)) {
      const at = (bridge.topics ?? []).findIndex((f) => f.id === args.topicId);
      if (at < 0) return Promise.reject(new Error(`No Topic with id ${args.topicId}`));
      const next = recordOnly(cmd, bridge.topics![at], args);
      bridge.topics = bridge.topics!.map((f, i) => (i === at ? next : f));
      return Promise.resolve(next);
    }
    return Promise.resolve(null);
  },
}));

const RECORD_ONLY = new Set(["rename_topic", "rename_member", "reorder_members", "remove_member"]);

function recordOnly(cmd: string, f: Topic, args: Record<string, unknown>): Topic {
  if (cmd === "rename_topic") return { ...f, name: String(args.name) };
  if (cmd === "rename_member") {
    return {
      ...f,
      members: f.members.map((m) =>
        m.repoPath === args.repoPath ? { ...m, displayName: String(args.displayName) } : m,
      ),
    };
  }
  if (cmd === "remove_member") {
    return { ...f, members: f.members.filter((m) => m.repoPath !== args.repoPath) };
  }
  const order = args.repoPaths as string[];
  return {
    ...f,
    members: [...f.members]
      .sort((a, b) => order.indexOf(a.repoPath) - order.indexOf(b.repoPath))
      .map((m, i) => ({ ...m, order: i })),
  };
}
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    bridge.handlers.set(name, handler);
    return Promise.resolve(() => bridge.handlers.delete(name));
  },
  emit: () => Promise.resolve(),
}));

const { default: TopicList } = await import("./TopicList");
const { default: ToastRegion } = await import("../../components/Toasts/Toasts");
const { PURGE_WORKSPACE } = await import("../../utils/events");
const { enterRoots } = await import("../../utils/gitActions");
const { emit, NEW_TOPIC } = await import("../../utils/events");

const SPACES = [
  {
    name: "work",
    external: false,
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
    ],
  },
];
const listCalls = () => bridge.calls.filter((c) => c.cmd === "list_topics").length;
const row = (name: string) => screen.getByText(name).closest("li")!;
// One macrotask, which every pending microtask chain has drained by.
const tick = () => new Promise((r) => setTimeout(r, 0));
const riskRow = (scope: HTMLElement, repoPath: string) =>
  scope.querySelector<HTMLElement>(`[data-member="${repoPath}"]`)!;

describe("TopicList", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.handlers.clear();
    bridge.topics = [AUTH, PAY];
    bridge.created = null;
    bridge.picked = null;
    bridge.wtStatus = {};
    bridge.failDelete = false;
    bridge.refuse = new Set();
    bridge.holdStatus = null;
    bridge.holdDelete = null;
    bridge.holdRemove = null;
    bridge.running = {};
    bridge.status = {};
    enterRoots([]);
  });
  afterEach(() => Toast.toaster.clear());

  it("renders one row per Topic and filters by name or member", async () => {
    const [query, setQuery] = (await import("solid-js")).createSignal("");
    render(() => <TopicList spaces={SPACES} query={query()} />);
    await screen.findByText("Auth");
    expect(screen.getByText("Payments")).toBeTruthy();
    setQuery("ledger");
    await waitFor(() => expect(screen.queryByText("Auth")).toBeNull());
    expect(screen.getByText("Payments")).toBeTruthy();
    setQuery("nothing");
    await screen.findByText("No Topic matches the filter.");
  });

  it("reads a null answer as no Topics and opens the dialog from the empty state", async () => {
    bridge.topics = null;
    render(() => <TopicList spaces={SPACES} query="" />);
    await screen.findByText("No Topics yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create a Topic" }));
    expect(await screen.findByRole("dialog", { name: "New Topic" })).toBeTruthy();
  });

  it("applies a topics://changed payload without a refetch", async () => {
    render(() => <TopicList spaces={SPACES} query="" />);
    await screen.findByText("Payments");
    await waitFor(() => expect(bridge.handlers.has("topics://changed")).toBe(true));
    expect(listCalls()).toBe(1);
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();

    const flipped = {
      ...PAY,
      members: PAY.members.map((m) => ({
        ...m,
        state: { kind: "present" } as MemberState,
      })),
    };
    bridge.handlers.get("topics://changed")!({ payload: flipped });
    await waitFor(() => expect(screen.queryByRole("img", { name: "Failed" })).toBeNull());
    expect(listCalls()).toBe(1);

    const fresh: Topic = {
      id: "new-1",
      name: "Brand new",
      branch: "feat/brand-new",
      createdAt: 3,
      members: [member("/w/api", 0, { kind: "failed", reason: "pending" })],
    };
    bridge.handlers.get("topics://changed")!({ payload: fresh });
    await screen.findByText("Brand new");
    expect(listCalls()).toBe(1);

    bridge.handlers.get("config://changed")!({ payload: null });
    await waitFor(() => expect(listCalls()).toBe(2));
  });

  // The repair lives on the member row now, so it is reached through the
  // disclosure rather than an actions strip under the chips (#159 phase 3).
  it("wires Retry to retry_member and applies the answer", async () => {
    render(() => <TopicList spaces={SPACES} query="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show members of Payments" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry ledger" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry ledger" })).toBeNull());
    const call = bridge.calls.find((c) => c.cmd === "retry_member")!;
    expect(call.args).toEqual({ topicId: "pay-1", repoPath: "/w/ledger" });
  });

  // One per action `memberState` can return. The row decides which; these pin
  // that each routes to the right command with the right arguments, and that
  // the member stops reading broken once the answer lands.
  describe("repairing a broken member", () => {
    const broken = (state: MemberState) => [
      { ...AUTH, members: [AUTH.members[0], { ...AUTH.members[1], worktreePath: null, state }] },
      PAY,
    ];
    async function press(state: MemberState, name: string) {
      bridge.topics = broken(state);
      render(() => <TopicList spaces={SPACES} query="" />);
      fireEvent.click(await screen.findByRole("button", { name: "Show members of Auth" }));
      fireEvent.click(await screen.findByRole("button", { name }));
    }
    const gone = (name: string) => waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());

    it("recreates a member whose worktree went missing", async () => {
      await press({ kind: "worktree-missing" }, "Recreate web");

      await gone("Recreate web");
      expect(bridge.calls.find((c) => c.cmd === "retry_member")!.args).toEqual({
        topicId: "auth-1",
        repoPath: "/w/web",
      });
    });

    it("retries a member the creation failed on", async () => {
      await press({ kind: "failed", reason: "refusing to overwrite" }, "Retry web");

      await gone("Retry web");
      expect(bridge.calls.find((c) => c.cmd === "retry_member")!.args).toEqual({
        topicId: "auth-1",
        repoPath: "/w/web",
      });
    });

    it("locates a member whose repo moved, through the folder picker", async () => {
      bridge.picked = "/moved/web";
      await press({ kind: "repo-missing" }, "Locate web");

      await gone("Locate web");
      expect(bridge.calls.some((c) => c.cmd === "pick_folder")).toBe(true);
      expect(bridge.calls.find((c) => c.cmd === "relocate_member")!.args).toEqual({
        topicId: "auth-1",
        repoPath: "/w/web",
        newRepoPath: "/moved/web",
      });
      // `repoPath` is the member's identity, so the row now answers to the new one.
      await waitFor(() => expect(document.querySelector('li[data-member="/moved/web"]')).toBeTruthy());
    });

    it("leaves the record alone when the picker is cancelled", async () => {
      await press({ kind: "repo-missing" }, "Locate web");

      await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "pick_folder")).toBe(true));
      expect(bridge.calls.some((c) => c.cmd === "relocate_member")).toBe(false);
      expect(screen.getByRole("button", { name: "Locate web" })).toBeTruthy();
    });
  });

  it("closes the dialog on creation and toasts the member that failed", async () => {
    bridge.topics = [];
    bridge.created = {
      id: "search-1",
      name: "Search",
      branch: "feat/search",
      createdAt: 4,
      members: [member("/w/api", 0), member("/w/web", 1, { kind: "failed", reason: "checked out in place" })],
    };
    render(() => (
      <>
        <ToastRegion />
        <TopicList spaces={SPACES} query="" />
      </>
    ));
    // The button is the sidebar's now, one component up; this list answers the
    // event it emits, and the listener is up before the first fetch resolves.
    await screen.findByText("No Topics yet.");
    emit(NEW_TOPIC);
    const dialog = await screen.findByRole("dialog", { name: "New Topic" });
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Search" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "api" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "web" }));
    const done = () => screen.getByRole("button", { name: "Done" }) as HTMLButtonElement;
    await waitFor(() => expect(done().disabled).toBe(false));
    fireEvent.click(done());

    await waitFor(() => expect(dialog.isConnected).toBe(false));
    const chip = row("Search").querySelector('[data-chip="/w/web"]')!;
    expect(chip.getAttribute("data-state")).toBe("failed");
    expect(chip.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Failed");
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("Search: no worktree for web");
    expect(listCalls()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "retry_member")).toBe(true));
    expect(bridge.calls.find((c) => c.cmd === "retry_member")!.args).toEqual({
      topicId: "search-1",
      repoPath: "/w/web",
    });
  });

  // The count is the git slot map's, and the editor only enters the open
  // Topic's roots, so every other row sums to nothing without being told to.
  it("renames from the context menu", async () => {
    render(() => <TopicList spaces={SPACES} query="" />);
    await screen.findByText("Auth");
    fireEvent.contextMenu(row("Auth"));
    pointerClick(await screen.findByText("Rename…"));
    const input = await screen.findByRole("textbox", { name: "Rename Auth" });
    fireEvent.input(input, { target: { value: "Auth v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "rename_topic")).toBe(true));
    expect(bridge.calls.find((c) => c.cmd === "rename_topic")!.args).toEqual({
      topicId: "auth-1",
      name: "Auth v2",
    });
    await screen.findByText("Auth v2");
    // The slug, and with it every member's branch, was frozen at creation: a
    // rename is a record write and nothing else. The note in the prompt says
    // so, and this is what keeps the note true.
    const GIT = ["create_worktree_in", "create_worktree", "remove_worktree", "remove_worktree_and_branch", "delete_remote_branch"];
    expect(bridge.calls.filter((c) => GIT.includes(c.cmd))).toEqual([]);
  });

  it("opens Add repository with the members left out", async () => {
    render(() => <TopicList spaces={SPACES} query="" />);
    await screen.findByText("Payments");
    fireEvent.contextMenu(row("Payments"));
    pointerClick(await screen.findByText("Add repository…"));
    await screen.findByRole("dialog", { name: "Add repository to Payments" });
    expect(screen.queryByRole("checkbox", { name: "api" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "web" })).toBeTruthy();
  });

  it("deletes the record after a confirm that lists every member, and never a worktree", async () => {
    render(() => <TopicList spaces={SPACES} query="" />);
    await screen.findByText("Payments");
    fireEvent.contextMenu(row("Payments"));
    pointerClick(await screen.findByText("Delete…"));
    const dialog = await screen.findByRole("dialog", { name: "Delete Payments?" });
    // A member with no usable worktree is asked nothing about it: its row says
    // what state it is in instead of a status git could not have answered.
    expect(riskRow(dialog, "/w/api").textContent).toContain("api");
    expect(riskRow(dialog, "/w/ledger").textContent).toContain("Failed");
    fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));
    await waitFor(() => expect(screen.queryByText("Payments")).toBeNull());
    expect(bridge.calls.find((c) => c.cmd === "delete_topic")!.args).toEqual({ topicId: "pay-1" });
    expect(bridge.calls.some((c) => c.cmd === "remove_worktree")).toBe(false);
    expect(screen.getByText("Auth")).toBeTruthy();
  });

  // #159 phase 4. The confirm shows the blast radius per member, the sweep that
  // follows offers each worktree, and the two are sequential on purpose: a sweep
  // opened before the delete could be answered for a Topic that stayed.
  describe("deleting a Topic", () => {
    const AUTH_API = "/w/api/.tori/worktrees/auth";
    const AUTH_WEB = "/w/web/.tori/worktrees/auth";
    const sweepRow = (repoPath: string) => document.querySelector<HTMLElement>(`[data-sweep="${repoPath}"]`)!;
    const branchBox = (repoPath: string) =>
      sweepRow(repoPath).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const choose = (repoPath: string, what: "Keep" | "Remove") =>
      fireEvent.click(within(sweepRow(repoPath)).getByRole("button", { name: what }));

    async function confirmDelete(onDeleted?: () => void) {
      render(() => <TopicList spaces={SPACES} query="" onDeleted={onDeleted} />);
      await screen.findByText("Auth");
      fireEvent.contextMenu(row("Auth"));
      pointerClick(await screen.findByText("Delete…"));
      return screen.findByRole("dialog", { name: "Delete Auth?" });
    }
    async function toSweep(onDeleted?: () => void) {
      await confirmDelete(onDeleted);
      fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));
      return screen.findByRole("dialog", { name: /Its worktrees/ });
    }

    it("tags the member git says has work at risk, and only that one", async () => {
      bridge.wtStatus = { [AUTH_API]: { dirty: true, unpushed: false } };
      const dialog = await confirmDelete();

      await waitFor(() => expect(riskRow(dialog, "/w/api").textContent).toContain("uncommitted changes"));
      expect(riskRow(dialog, "/w/web").textContent).toContain("clean");
      expect(riskRow(dialog, "/w/web").textContent).not.toContain("uncommitted");
    });

    // The single-worktree dialog defaults local-delete on, calibrated for one
    // tree whose warning is in the same dialog. Over N rows the warning has to
    // reach the row, so the box follows that row's own evidence.
    it("arms the branch checkbox on a clean row and disarms it on a dirty one", async () => {
      bridge.wtStatus = { [AUTH_API]: { dirty: true, unpushed: false } };
      await toSweep();

      await waitFor(() => expect(sweepRow("/w/api").textContent).toContain("uncommitted changes"));
      expect(branchBox("/w/api").checked).toBe(false);
      expect(branchBox("/w/web").checked).toBe(true);
      // And it is inert until that row is actually being removed.
      expect(branchBox("/w/web").disabled).toBe(true);
      choose("/w/web", "Remove");
      expect(branchBox("/w/web").disabled).toBe(false);
    });

    it("purges the workspace before it offers the worktrees, and offers nothing on a failed delete", async () => {
      const order: string[] = [];
      // Recorded from inside the purge, not after the await: the question is
      // what had already happened at that moment, and a sweep already on screen
      // would be a sweep answered for a Topic the delete had not finished.
      const onPurge = () => order.push(document.querySelector("[data-sweep]") ? "sweep" : "purge");
      window.addEventListener(PURGE_WORKSPACE, onPurge);
      try {
        await toSweep(() => order.push("deleted"));
      } finally {
        window.removeEventListener(PURGE_WORKSPACE, onPurge);
      }
      expect(order).toEqual(["purge", "deleted"]);
      expect(document.querySelector("[data-sweep]")).toBeTruthy();

      cleanup();
      bridge.topics = [AUTH, PAY];
      bridge.failDelete = true;
      await confirmDelete();
      fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));

      await screen.findByText(/delete refused/);
      expect(screen.queryByRole("dialog", { name: /Its worktrees/ })).toBeNull();
      // The record is still there, so nothing purged it either.
      expect(screen.getByText("Auth")).toBeTruthy();
    });

    it("has no accessibility violations", async () => {
      bridge.wtStatus = { [AUTH_API]: { dirty: true, unpushed: true } };
      const dialog = await toSweep();
      await waitFor(() => expect(sweepRow("/w/api").textContent).toContain("uncommitted changes"));
      choose("/w/web", "Remove");

      await expectNoAxeViolations(dialog);
    });

    // The confirm closes before `delete_topic` answers and the sweep opens
    // after, so a status resolving in between has no dialog to land on. It has
    // to be kept anyway, or that row reaches the sweep stuck on "checking...".
    it("carries a status that answered while neither dialog was open", async () => {
      bridge.wtStatus = { [AUTH_API]: { dirty: true, unpushed: false } };
      bridge.holdStatus = () => {};
      bridge.holdDelete = () => {};
      await confirmDelete();
      expect(screen.getByRole("dialog").textContent).toContain("checking…");

      // The confirm is gone and the sweep is not there yet: git answering here
      // is the case, and it is the whole duration of `delete_topic` wide.
      fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      bridge.holdStatus!();
      await tick();
      bridge.holdDelete!();

      await screen.findByRole("dialog", { name: /Its worktrees/ });
      await waitFor(() => expect(sweepRow("/w/api").textContent).toContain("uncommitted changes"));
      expect(branchBox("/w/api").checked).toBe(false);
    });

    it("does not reopen itself when a row fails after the dialog was dismissed", async () => {
      bridge.refuse = new Set([AUTH_API]);
      bridge.holdRemove = () => {};
      await toSweep();
      choose("/w/api", "Remove");
      fireEvent.click(screen.getByRole("button", { name: "Remove 1 worktree" }));

      fireEvent.click(screen.getByRole("button", { name: "Keep all" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      bridge.holdRemove!();

      await waitFor(() => expect(bridge.calls.some((c) => c.cmd.startsWith("remove_worktree"))).toBe(true));
      await tick();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // The one consequence git has nothing to say about: removal tears down the
    // PTYs under the worktree, and only the sweep asks, since only it removes.
    it("says what a removal will stop, per row", async () => {
      bridge.running = { [AUTH_WEB]: 2 };
      render(() => <TopicList spaces={SPACES} query="" countRunning={(p) => Promise.resolve(bridge.running[p] ?? 0)} />);
      await screen.findByText("Auth");
      fireEvent.contextMenu(row("Auth"));
      pointerClick(await screen.findByText("Delete…"));
      await screen.findByRole("dialog", { name: "Delete Auth?" });
      // Not on the confirm: it removes nothing, so it has nothing to stop.
      expect(screen.getByRole("dialog").textContent).not.toContain("terminal tab");
      fireEvent.click(screen.getByRole("button", { name: "Delete Topic" }));

      await screen.findByRole("dialog", { name: /Its worktrees/ });
      await waitFor(() => expect(sweepRow("/w/web").textContent).toContain("2 terminal tabs running here"));
      expect(sweepRow("/w/api").textContent).not.toContain("terminal tab");
    });

    it("removes the rows it was told to and keeps the rest", async () => {
      await toSweep();
      choose("/w/web", "Remove");
      fireEvent.click(screen.getByRole("button", { name: "Remove 1 worktree" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const removed = bridge.calls.filter((c) => c.cmd.startsWith("remove_worktree"));
      expect(removed.map((c) => c.args.worktreePath)).toEqual([AUTH_WEB]);
      // Clean row, so the branch went with it.
      expect(removed[0].cmd).toBe("remove_worktree_and_branch");
      expect(removed[0].args).toMatchObject({ branch: "feat/auth", force: true });
    });

    it("keeps going when one row refuses, and leaves that row on screen", async () => {
      bridge.refuse = new Set([AUTH_API]);
      await toSweep();
      choose("/w/api", "Remove");
      choose("/w/web", "Remove");
      fireEvent.click(screen.getByRole("button", { name: "Remove 2 worktrees" }));

      await waitFor(() => expect(sweepRow("/w/api").textContent).toContain("worktree is locked"));
      const removed = bridge.calls.filter((c) => c.cmd.startsWith("remove_worktree"));
      expect(removed.map((c) => c.args.worktreePath).sort()).toEqual([AUTH_API, AUTH_WEB].sort());
      // Only the one that failed is still asking.
      expect(sweepRow("/w/web")).toBeNull();
    });
  });

  describe("the member row menu", () => {
    const expand = async (name: string) =>
      fireEvent.click(await screen.findByRole("button", { name: `Show members of ${name}` }));
    const memberRow = (repoPath: string) =>
      document.querySelector<HTMLElement>(`li[data-member="${repoPath}"]`)!;

    async function openOn(topicName: string, repoPath: string) {
      render(() => <TopicList spaces={SPACES} query="" />);
      await screen.findByText(topicName);
      await expand(topicName);
      fireEvent.contextMenu(memberRow(repoPath));
    }

    it("moves a member up through reorder_members, in the swapped order", async () => {
      await openOn("Auth", "/w/web");
      pointerClick(await screen.findByText("Move up"));

      await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "reorder_members")).toBe(true));
      expect(bridge.calls.find((c) => c.cmd === "reorder_members")!.args).toEqual({
        topicId: "auth-1",
        repoPaths: ["/w/web", "/w/api"],
      });
      await waitFor(() =>
        expect(Array.from(document.querySelectorAll("li[data-member]")).map((r) => r.getAttribute("data-member"))).toEqual([
          "/w/web",
          "/w/api",
        ]),
      );
    });

    it("renames a member and shows the new name on its row", async () => {
      await openOn("Auth", "/w/api");
      pointerClick(await screen.findByText("Rename…"));
      const input = await screen.findByRole("textbox", { name: "Rename api" });
      fireEvent.input(input, { target: { value: "Payments API" } });
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));

      await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "rename_member")).toBe(true));
      expect(bridge.calls.find((c) => c.cmd === "rename_member")!.args).toEqual({
        topicId: "auth-1",
        repoPath: "/w/api",
        displayName: "Payments API",
      });
      await waitFor(() => expect(memberRow("/w/api").textContent).toContain("Payments API"));
    });

    it("removes a member the Topic can spare", async () => {
      await openOn("Auth", "/w/web");
      pointerClick(await screen.findByText("Remove repository"));

      await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "remove_member")).toBe(true));
      expect(bridge.calls.find((c) => c.cmd === "remove_member")!.args).toEqual({
        topicId: "auth-1",
        repoPath: "/w/web",
      });
      await waitFor(() => expect(memberRow("/w/web")).toBeNull());
      // The record is gone and the worktree is only offered, so declining is
      // "keep" rather than an undo. `removeMember.test.tsx` takes both outcomes.
      const dialog = await screen.findByRole("dialog", { name: /Remove worktree/ });
      expect(dialog.textContent).toContain("Keep worktree");
    });

    // `reconcile_member` never clears `worktree_path`, so a broken member still
    // carries a folder its repo cannot reach. Offering it would confirm a
    // removal that fails; the record detaching is the whole action here.
    it("offers no worktree for a member whose repo is gone", async () => {
      const broken = { ...AUTH.members[1], state: { kind: "repo-missing" } as MemberState };
      bridge.topics = [{ ...AUTH, members: [AUTH.members[0], broken] }, PAY];
      await openOn("Auth", "/w/web");
      pointerClick(await screen.findByText("Remove repository"));

      await waitFor(() => expect(memberRow("/w/web")).toBeNull());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(bridge.calls.some((c) => c.cmd === "worktree_status")).toBe(false);
    });

    it("refuses to remove the last member and says why on the row", async () => {
      bridge.topics = [{ ...AUTH, members: [AUTH.members[0]] }, PAY];
      await openOn("Auth", "/w/api");
      const remove = (await screen.findByText("Remove repository")).closest<HTMLElement>("[role=menuitem]")!;

      // Refusing rather than disabled: an arrow key still reaches the row, so
      // the reason is not written somewhere only a pointer can find it. Drawn
      // and described rather than hung off a native `title`, which is what
      // `src/test/interactiveTitle.test.ts` exists to keep off a menu row.
      expect(remove.getAttribute("aria-disabled")).toBe("true");
      expect(remove.getAttribute("title")).toBeNull();
      const note = document.getElementById(remove.getAttribute("aria-describedby")!)!;
      expect(note.textContent).toBe(LAST_MEMBER);
      pointerClick(remove);
      expect(bridge.calls.some((c) => c.cmd === "remove_member")).toBe(false);
    });
  });
});
