import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import type { StatusReport, UnitStatus } from "../../utils/forgeTypes";

// The forge chip where it actually lives: on a branch row, fed by the poller.
//
// `forgeChip.test.ts` pins every decision; this pins that the sidebar asks the
// right questions and draws the answers. The two failures it exists to catch are
// invisible to that pure test:
//
//   1. A remote the API cannot serve still being polled. It costs a request per
//      tick, forever, to be told `unsupportedRemote`, and nothing on screen ever
//      looks wrong - so the assertion is about the request that must NOT happen.
//   2. An inert unit rendering the same absence as a branch with no PR. Both
//      look like nothing until the phase that hangs a create control off one of
//      them (`lesson_probe_the_capability_before_building_its_control`).

const GH = "/root/work/gh";
const GL = "/root/work/gl";
const SOLO = "/root/work/solo";
const NOTES = "/root/work/notes";

const worktree = (branch: string, folder: string) => ({
  label: branch,
  folderPath: folder,
  branch,
  kind: "worktree",
  isCurrent: false,
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
          name: "gh",
          path: GH,
          external: false,
          branchUnits: [
            worktree("shipped", `${GH}/shipped`),
            worktree("drafting", `${GH}/drafting`),
            worktree("broken", `${GH}/broken`),
            worktree("fresh", `${GH}/fresh`),
          ],
        },
        { name: "gl", path: GL, external: false, branchUnits: [worktree("gl-main", `${GL}/main`)] },
        {
          name: "solo",
          path: SOLO,
          external: false,
          branchUnits: [worktree("solo-main", `${SOLO}/main`)],
        },
        {
          name: "notes",
          path: NOTES,
          external: false,
          // A plain-dir project: one unit, no branch, and its project row IS the
          // unit row.
          branchUnits: [
            { label: "notes", folderPath: NOTES, branch: null, kind: "plain-dir", isCurrent: false },
          ],
        },
      ],
    },
  ],
};

const ORIGINS: Record<string, string | null> = {
  [GH]: "git@github.com:skarif2/sway.git",
  [GL]: "git@gitlab.com:skarif2/sway.git",
  [SOLO]: null,
};

const unit = (over: Partial<UnitStatus> & { headRef: string }): UnitStatus => ({
  pullRequest: null,
  checks: { state: "none", total: 0, failing: 0 },
  reviewDecision: "none",
  ...over,
});

const pull = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `pr ${number}`,
  body: null,
  state: "open",
  isDraft: false,
  author: "skarif2",
  headRef: "x",
  baseRef: "main",
  headSha: "sha",
  url: `https://github.com/skarif2/sway/pull/${number}`,
  mergeableState: "clean",
  ...over,
});

const REPORT: StatusReport = {
  statuses: [
    unit({
      headRef: "shipped",
      pullRequest: pull(11) as UnitStatus["pullRequest"],
      checks: { state: "success", total: 3, failing: 0 },
      reviewDecision: "approved",
    }),
    unit({
      headRef: "drafting",
      pullRequest: pull(12, { isDraft: true }) as UnitStatus["pullRequest"],
      checks: { state: "pending", total: 3, failing: 0 },
    }),
    unit({
      headRef: "broken",
      pullRequest: pull(13) as UnitStatus["pullRequest"],
      checks: { state: "failure", total: 5, failing: 2 },
      reviewDecision: "changesRequested",
    }),
    // Answered for, and the answer is that there is no PR.
    unit({ headRef: "fresh" }),
    // The unservable projects' branches, answered for as well. The stub replies
    // the same report to any project, so a build that polls them at all records
    // a no-PR status against their rows - which is what turns the inert
    // assertions below from "nothing has loaded yet" into a real check.
    unit({ headRef: "gl-main" }),
    unit({ headRef: "solo-main" }),
  ],
  uncovered: 0,
  rate: { remaining: 4800, limit: 5000, resetAt: null },
};

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  auth: { kind: "signedIn", login: "skarif2" } as { kind: string; login?: string },
  sessions: [] as unknown[],
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") return Promise.resolve(bridge.sessions);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(ORIGINS[args.projectPath as string] ?? null);
    if (cmd === "forge_accounts") {
      const auth = bridge.auth;
      return Promise.resolve(
        auth.kind === "signedOut"
          ? []
          : [{ host: "github.com", accounts: [{ id: "personal", provider: "github", baseUrl: "https://github.com", login: "skarif2", label: "skarif2", expiresAt: null, auth }] }],
      );
    }
    if (cmd === "forge_repo_account")
      return Promise.resolve({ kind: "account", accountId: "personal", host: "github.com", auth: bridge.auth });
    if (cmd === "forge_unit_statuses") return Promise.resolve(REPORT);
    if (cmd === "sessions_running")
      return Promise.resolve(((args.sessions ?? []) as { id: string }[]).map((s) => s.id));
    if (cmd === "session_tail_state") return Promise.resolve("done");
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    bridge.handlers[name] = fn;
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
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { resetForgeStatusForTests } = await import("../../utils/forgeStatus");

const row = async (label: string) => (await screen.findByText(label)).parentElement!;
const statusAsks = () =>
  bridge.calls.filter((c) => c.cmd === "forge_unit_statuses").map((c) => c.args.projectPath);

describe("the forge chip on a branch row", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    bridge.auth = { kind: "signedIn", login: "skarif2" };
    bridge.sessions = [];
    bridge.handlers = {};
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    localStorage.setItem(
      "sway.expanded.v1",
      JSON.stringify(["p:work/gh", "p:work/gl", "p:work/solo"]),
    );
  });

  it("draws each PR state the poller can report", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);

    const shipped = await row("shipped");
    await waitFor(() => expect(shipped.querySelector("[data-forge-pr]")).toBeTruthy());

    // Open, all checks green, approved.
    expect(shipped.querySelector('[data-forge-pr="open"]')?.textContent).toContain("#11");
    expect(shipped.querySelector('[data-forge-checks="good"]')).toBeTruthy();
    expect(shipped.querySelector('[data-forge-review="good"]')).toBeTruthy();

    // A draft is its own state, not an open PR with a flag: the row has to read
    // as "not asking for review yet" at a glance.
    const drafting = await row("drafting");
    expect(drafting.querySelector('[data-forge-pr="draft"]')?.textContent).toContain("#12");
    expect(drafting.querySelector('[data-forge-checks="busy"]')).toBeTruthy();
    expect(drafting.querySelector("[data-forge-review]")).toBeNull();

    // Failing checks and a changes-requested verdict, the two states
    // `needsAttention` counts and Phase 7 will attribute to a session.
    const broken = await row("broken");
    const checks = broken.querySelector('[data-forge-checks="bad"]');
    expect(checks?.getAttribute("title")).toBe("2 of 5 checks failing");
    expect(broken.querySelector('[data-forge-review="bad"]')?.getAttribute("title")).toBe(
      "Changes requested",
    );
  });

  it("marks a branch the forge answered for and has no PR", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);

    const fresh = await row("fresh");
    await waitFor(() => expect(fresh.querySelector('[data-forge-state="noPr"]')).toBeTruthy());
    // No number, and no checks or verdict hanging off a PR that does not exist.
    expect(fresh.querySelector('[data-forge-pr="none"]')?.textContent).toBe("");
    expect(fresh.querySelector("[data-forge-checks]")).toBeNull();
  });

  it("gives an unservable remote an inert row, not a no-PR one", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);

    // Discriminating on purpose: the GitHub project's no-PR chip must already be
    // on screen, so "renders nothing" here cannot pass merely because nothing
    // has loaded yet.
    await waitFor(async () =>
      expect((await row("fresh")).querySelector('[data-forge-state="noPr"]')).toBeTruthy(),
    );

    // gitlab.com has an adapter, so a repo there with no account is offered one
    // rather than left blank. What it must not show is PR state.
    const gl = await row("gl-main");
    expect(gl.querySelector('[data-forge-state="connect"]')).toBeTruthy();
    expect(gl.querySelector("[data-forge-pr]")).toBeNull();

    // A repo with no origin has nothing to connect to, so nothing renders and
    // there is no control to click.
    const solo = await row("solo-main");
    expect(solo.querySelector("[data-forge-state]")).toBeNull();
    expect(solo.querySelector("[data-forge-pr]")).toBeNull();
    expect(solo.querySelector("button")).toBeNull();

    // A plain-dir project row is its own unit and has no branch, so it is inert
    // for the same reason and by the same rule.
    const notes = await row("notes");
    expect(notes.querySelector("[data-forge-state]")).toBeNull();
  });

  it("never spends a request on a remote the API cannot serve", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);

    await waitFor(() => expect(statusAsks()).toContain(GH));
    // The failure this exists for is invisible: asking anyway looks identical on
    // screen and costs a request per project per tick to be refused.
    expect(statusAsks()).not.toContain(GL);
    expect(statusAsks()).not.toContain(SOLO);
    expect(statusAsks()).not.toContain(NOTES);
  });

  it("asks about the whole project, once, not about one branch at a time", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);

    await waitFor(() => expect(statusAsks().length).toBeGreaterThan(0));
    const ask = bridge.calls.find((c) => c.cmd === "forge_unit_statuses")!;
    expect(ask.args.branches).toEqual(["shipped", "drafting", "broken", "fresh"]);
    // The disclosure toggles and the config settles during mount, each of which
    // re-runs the watcher effect. The 30-second per-project gap is what keeps
    // that from being one request each.
    expect(statusAsks().filter((p) => p === GH).length).toBe(1);
  });

  it("stops claiming anything once the account signs out", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
    const shipped = await row("shipped");
    await waitFor(() => expect(shipped.querySelector("[data-forge-pr]")).toBeTruthy());

    // The statuses are still in the store; what changed is that nothing is
    // refreshing them, so the row must stop presenting them as current.
    const { noteForgeAccounts } = await import("../../utils/forgeStatus");
    noteForgeAccounts([]);

    await waitFor(() => expect(shipped.querySelector("[data-forge-pr]")).toBeNull());

    // github.com has no account left, so the repo offers one, on its first row only.
    expect(shipped.querySelector('button[data-forge-state="connect"]')).toBeTruthy();
    expect((await row("drafting")).querySelector("[data-forge-state]")).toBeNull();
  });
});

// The wiring between the chip and the needs-you pipeline.
//
// `sessionActivity.test.ts` pins the join itself, given the units. What it
// cannot see is whether anything ever hands them over: a store fed nothing
// composes perfectly and reports nothing, and every one of its own tests still
// passes (`lesson_a_registered_command_with_no_caller_is_not_shipped`).
describe("a failing check reaching the session that owns the branch", () => {
  const BROKEN = `${GH}/broken`;
  const session = {
    id: "s-broken",
    path: `${BROKEN}/.t/s-broken.jsonl`,
    cwd: BROKEN,
    branch: "broken",
    title: "the agent on broken",
    last_active: 1,
    created_at: 1,
    name: null,
    agent: "claude",
  };
  const liveTabs = [
    { id: "t1", workspace: BROKEN, kind: "agent" as const, sessionId: "s-broken", agent: "claude" as const, state: "live" as const },
  ];

  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    bridge.auth = { kind: "signedIn", login: "skarif2" };
    bridge.handlers = {};
    bridge.sessions = [session];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    localStorage.setItem("sway.expanded.v1", JSON.stringify(["p:work/gh"]));
  });

  it("turns the branch's own row into a needs-you row", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);

    const broken = await row("broken");
    await waitFor(() => expect(broken.querySelector('[data-forge-checks="bad"]')).toBeTruthy());

    // A tab hosting a session is not probed by the folder sweep, so drive the
    // scanner event that does. Until the probe lands the dot is "none", which
    // the raise deliberately leaves alone.
    await waitFor(() => expect(bridge.handlers["sessions://changed"]).toBeTruthy());
    bridge.handlers["sessions://changed"]({ payload: null });

    // The existing rollup badge, unchanged: the CI failure arrives as a
    // needs-you dot and rides the surface that was already there.
    await waitFor(() =>
      expect(broken.querySelector('[title="Waiting for approval"]')).toBeTruthy(),
    );

    // And only that branch. `shipped` is green and `fresh` has no PR at all.
    const shipped = await row("shipped");
    expect(shipped.querySelector('[title="Waiting for approval"]')).toBeNull();
  });
});

// The chip as a way in. Phase 6 made it a status surface; this makes the one
// with a pull request behind it a control.
describe("clicking a branch's forge chip", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    bridge.auth = { kind: "signedIn", login: "skarif2" };
    bridge.sessions = [];
    bridge.handlers = {};
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    localStorage.setItem("sway.expanded.v1", JSON.stringify(["p:work/gh"]));
  });

  it("selects the branch and opens the Pull Requests panel", async () => {
    const selected: unknown[] = [];
    render(() => (
      <LeftSidebar selected={null} onSelect={(s) => selected.push(s)} liveTabs={[]} />
    ));

    const shipped = await row("shipped");
    await waitFor(() => expect(shipped.querySelector("button[data-forge-state]")).toBeTruthy());

    let detail: unknown = null;
    const handler = (e: Event) => (detail = (e as CustomEvent).detail);
    window.addEventListener("sway:set-right-mode", handler);
    (shipped.querySelector("button[data-forge-state]") as HTMLButtonElement).click();
    await waitFor(() => expect(detail).toEqual({ mode: "pulls" }));
    window.removeEventListener("sway:set-right-mode", handler);

    // The panel is workspace-scoped, so the selection has to land first or it
    // opens onto whichever project was already showing.
    expect(selected).toHaveLength(1);
    expect((selected[0] as { branch: string }).branch).toBe("shipped");
  });

  it("leaves a branch with no pull request inert", async () => {
    // There is nothing for the panel to show it: the list carries what exists,
    // so a button here would look like a control and do nothing visible
    // (`lesson_probe_the_capability_before_building_its_control`).
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);

    const fresh = await row("fresh");
    await waitFor(() => expect(fresh.querySelector('[data-forge-state="noPr"]')).toBeTruthy());
    expect(fresh.querySelector("button")).toBeNull();
  });
});
