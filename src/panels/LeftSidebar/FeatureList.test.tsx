import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import { Toast } from "../../lib/toast";
import { LAST_MEMBER, type Feature, type Member, type MemberState } from "../../utils/features";

function member(repoPath: string, order: number, state: MemberState = { kind: "present" }): Member {
  return {
    repoPath,
    displayName: repoPath.split("/").pop()!,
    worktreePath: null,
    state,
    order,
  };
}

// A present member's worktree carries the Feature's slug, so two Features over
// the same repo never share a root. The change count is keyed by root, and a
// shared one would put Auth's number on the Payments row.
const wt = (members: Member[], slug: string) =>
  members.map((m) => ({
    ...m,
    worktreePath: m.state.kind === "present" ? `${m.repoPath}/.sway/worktrees/${slug}` : null,
  }));

const AUTH: Feature = {
  id: "auth-1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: wt([member("/w/api", 0), member("/w/web", 1)], "auth"),
};
const PAY: Feature = {
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
  features: null as Feature[] | null,
  created: null as Feature | null,
  // What `git_status` answers per member root, for the row's change count.
  status: {} as Record<string, unknown[]>,
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_features") return Promise.resolve(bridge.features);
    if (cmd === "git_status") return Promise.resolve(bridge.status[String(args?.projectPath)] ?? []);
    if (cmd === "create_feature") return Promise.resolve(bridge.created);
    if (cmd === "worktree_status")
      return Promise.resolve({ dirty: false, unpushed: false, hasRemote: false });
    if (cmd === "retry_member") {
      const fixed = {
        ...PAY,
        members: PAY.members.map((m) => (m.repoPath === args.repoPath ? { ...m, state: { kind: "present" } } : m)),
      };
      return Promise.resolve(fixed);
    }
    // The record-only commands answer with the reloaded Feature, the shape the
    // backend took on when it started emitting `features://changed` for them.
    if (RECORD_ONLY.has(cmd)) {
      const at = (bridge.features ?? []).findIndex((f) => f.id === args.featureId);
      if (at < 0) return Promise.reject(new Error(`No Feature with id ${args.featureId}`));
      const next = recordOnly(cmd, bridge.features![at], args);
      bridge.features = bridge.features!.map((f, i) => (i === at ? next : f));
      return Promise.resolve(next);
    }
    return Promise.resolve(null);
  },
}));

const RECORD_ONLY = new Set(["rename_feature", "rename_member", "reorder_members", "remove_member"]);

function recordOnly(cmd: string, f: Feature, args: Record<string, unknown>): Feature {
  if (cmd === "rename_feature") return { ...f, name: String(args.name) };
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

const { default: FeatureList } = await import("./FeatureList");
const { default: ToastRegion } = await import("../../components/Toasts/Toasts");
const { enterRoots, refreshStatus, stage } = await import("../../utils/gitActions");

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
const listCalls = () => bridge.calls.filter((c) => c.cmd === "list_features").length;
const row = (name: string) => screen.getByText(name).closest("li")!;

describe("FeatureList", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.handlers.clear();
    bridge.features = [AUTH, PAY];
    bridge.created = null;
    bridge.status = {};
    enterRoots([]);
  });
  afterEach(() => Toast.toaster.clear());

  it("renders one row per Feature and filters by name or member", async () => {
    const [query, setQuery] = (await import("solid-js")).createSignal("");
    render(() => <FeatureList spaces={SPACES} query={query()} />);
    await screen.findByText("Auth");
    expect(screen.getByText("Payments")).toBeTruthy();
    setQuery("ledger");
    await waitFor(() => expect(screen.queryByText("Auth")).toBeNull());
    expect(screen.getByText("Payments")).toBeTruthy();
    setQuery("nothing");
    await screen.findByText("No Feature matches the filter.");
  });

  it("reads a null answer as no Features and opens the dialog from the empty state", async () => {
    bridge.features = null;
    render(() => <FeatureList spaces={SPACES} query="" />);
    await screen.findByText("No Features yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create a Feature" }));
    expect(await screen.findByRole("dialog", { name: "New Feature" })).toBeTruthy();
  });

  it("applies a features://changed payload without a refetch", async () => {
    render(() => <FeatureList spaces={SPACES} query="" />);
    await screen.findByText("Payments");
    await waitFor(() => expect(bridge.handlers.has("features://changed")).toBe(true));
    expect(listCalls()).toBe(1);
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();

    const flipped = {
      ...PAY,
      members: PAY.members.map((m) => ({
        ...m,
        state: { kind: "present" } as MemberState,
      })),
    };
    bridge.handlers.get("features://changed")!({ payload: flipped });
    await waitFor(() => expect(screen.queryByRole("img", { name: "Failed" })).toBeNull());
    expect(listCalls()).toBe(1);

    const fresh: Feature = {
      id: "new-1",
      name: "Brand new",
      branch: "feat/brand-new",
      createdAt: 3,
      members: [member("/w/api", 0, { kind: "failed", reason: "pending" })],
    };
    bridge.handlers.get("features://changed")!({ payload: fresh });
    await screen.findByText("Brand new");
    expect(listCalls()).toBe(1);

    bridge.handlers.get("config://changed")!({ payload: null });
    await waitFor(() => expect(listCalls()).toBe(2));
  });

  it("wires Retry to retry_member and applies the answer", async () => {
    render(() => <FeatureList spaces={SPACES} query="" />);
    const retry = await screen.findByRole("button", { name: "Retry ledger" });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry ledger" })).toBeNull());
    const call = bridge.calls.find((c) => c.cmd === "retry_member")!;
    expect(call.args).toEqual({ featureId: "pay-1", repoPath: "/w/ledger" });
  });

  it("closes the dialog on creation and toasts the member that failed", async () => {
    bridge.features = [];
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
        <FeatureList spaces={SPACES} query="" />
      </>
    ));
    fireEvent.click(await screen.findByRole("button", { name: "New Feature" }));
    const dialog = await screen.findByRole("dialog", { name: "New Feature" });
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
      featureId: "search-1",
      repoPath: "/w/web",
    });
  });

  // The count is the git slot map's, and the editor only enters the open
  // Feature's roots, so every other row sums to nothing without being told to.
  describe("the open Feature's change count", () => {
    const API = "/w/api/.sway/worktrees/auth";
    const WEB = "/w/web/.sway/worktrees/auth";

    const rows = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({
        status: " M",
        path: `src/${from + i}.ts`,
        staged: false,
        unstaged: true,
      }));
    const staged = (n: number) => rows(n).map((f) => ({ ...f, status: "M ", staged: true, unstaged: false }));

    async function fill(api: unknown[], web: unknown[]) {
      bridge.status = { [API]: api, [WEB]: web };
      enterRoots([API, WEB]);
      await Promise.all([refreshStatus(API), refreshStatus(WEB)]);
    }

    const count = (name: string) => row(name).querySelector("[data-changed]");

    it("sums every member and leaves the Features nobody opened silent", async () => {
      render(() => <FeatureList spaces={SPACES} query="" activeId="auth-1" />);
      await screen.findByText("Auth");
      await fill(rows(4), rows(3));

      await waitFor(() => expect(count("Auth")?.textContent).toBe("7 changed"));
      // Payments shares a repo with Auth but not a worktree, so it reads its
      // own empty slots rather than borrowing the number beside it.
      expect(count("Payments")).toBeNull();
    });

    it("counts staged files too, so staging a member's work does not empty the row", async () => {
      render(() => <FeatureList spaces={SPACES} query="" activeId="auth-1" />);
      await screen.findByText("Auth");
      await fill(rows(4), rows(3));
      await waitFor(() => expect(count("Auth")?.textContent).toBe("7 changed"));

      // Everything staged, plus one file nobody staged. Counting the unstaged
      // alone reads 1; a row that never re-rendered still reads 7.
      bridge.status = { [API]: [...staged(4), ...rows(1, 4)], [WEB]: staged(3) };
      await Promise.all([stage(API, ["src/0.ts"]), stage(WEB, ["src/0.ts"])]);

      await waitFor(() => expect(count("Auth")?.textContent).toBe("8 changed"));
    });

    it("says nothing for a Feature whose members are all clean", async () => {
      render(() => <FeatureList spaces={SPACES} query="" activeId="auth-1" />);
      await screen.findByText("Auth");
      await fill([], []);

      expect(count("Auth")).toBeNull();
    });
  });

  it("renames from the context menu", async () => {
    render(() => <FeatureList spaces={SPACES} query="" />);
    await screen.findByText("Auth");
    fireEvent.contextMenu(row("Auth"));
    pointerClick(await screen.findByText("Rename…"));
    const input = await screen.findByRole("textbox", { name: "Rename Auth" });
    fireEvent.input(input, { target: { value: "Auth v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "rename_feature")).toBe(true));
    expect(bridge.calls.find((c) => c.cmd === "rename_feature")!.args).toEqual({
      featureId: "auth-1",
      name: "Auth v2",
    });
    await screen.findByText("Auth v2");
  });

  it("opens Add repository with the members left out", async () => {
    render(() => <FeatureList spaces={SPACES} query="" />);
    await screen.findByText("Payments");
    fireEvent.contextMenu(row("Payments"));
    pointerClick(await screen.findByText("Add repository…"));
    await screen.findByRole("dialog", { name: "Add repository to Payments" });
    expect(screen.queryByRole("checkbox", { name: "api" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "web" })).toBeTruthy();
  });

  it("deletes the record after a confirm that lists every member, and never a worktree", async () => {
    render(() => <FeatureList spaces={SPACES} query="" />);
    await screen.findByText("Payments");
    fireEvent.contextMenu(row("Payments"));
    pointerClick(await screen.findByText("Delete…"));
    const dialog = await screen.findByRole("dialog", { name: "Delete Payments?" });
    expect(dialog.textContent).toContain("api: Ready");
    expect(dialog.textContent).toContain("ledger: Failed");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Payments")).toBeNull());
    expect(bridge.calls.find((c) => c.cmd === "delete_feature")!.args).toEqual({ featureId: "pay-1" });
    expect(bridge.calls.some((c) => c.cmd === "remove_worktree")).toBe(false);
    expect(screen.getByText("Auth")).toBeTruthy();
  });

  describe("the member row menu", () => {
    const expand = async (name: string) =>
      fireEvent.click(await screen.findByRole("button", { name: `Show members of ${name}` }));
    const memberRow = (repoPath: string) =>
      document.querySelector<HTMLElement>(`li[data-member="${repoPath}"]`)!;

    async function openOn(featureName: string, repoPath: string) {
      render(() => <FeatureList spaces={SPACES} query="" />);
      await screen.findByText(featureName);
      await expand(featureName);
      fireEvent.contextMenu(memberRow(repoPath));
    }

    it("moves a member up through reorder_members, in the swapped order", async () => {
      await openOn("Auth", "/w/web");
      pointerClick(await screen.findByText("Move up"));

      await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "reorder_members")).toBe(true));
      expect(bridge.calls.find((c) => c.cmd === "reorder_members")!.args).toEqual({
        featureId: "auth-1",
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
        featureId: "auth-1",
        repoPath: "/w/api",
        displayName: "Payments API",
      });
      await waitFor(() => expect(memberRow("/w/api").textContent).toContain("Payments API"));
    });

    it("removes a member the Feature can spare", async () => {
      await openOn("Auth", "/w/web");
      pointerClick(await screen.findByText("Remove repository"));

      await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "remove_member")).toBe(true));
      expect(bridge.calls.find((c) => c.cmd === "remove_member")!.args).toEqual({
        featureId: "auth-1",
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
      bridge.features = [{ ...AUTH, members: [AUTH.members[0], broken] }, PAY];
      await openOn("Auth", "/w/web");
      pointerClick(await screen.findByText("Remove repository"));

      await waitFor(() => expect(memberRow("/w/web")).toBeNull());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(bridge.calls.some((c) => c.cmd === "worktree_status")).toBe(false);
    });

    it("refuses to remove the last member and says why on the row", async () => {
      bridge.features = [{ ...AUTH, members: [AUTH.members[0]] }, PAY];
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
