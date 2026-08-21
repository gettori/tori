import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

// A plain repo is the case where a folder attributes nothing: `main` and `feat`
// are two rows over one working directory, told apart only by the branch each
// session recorded. The rollup badge is keyed off the live status list now
// rather than off the rows' own session arrays, so this is the check that the
// list carries enough to land the badge on the right one.
const REPO = "/root/work/repo";

const plain = (branch: string, isCurrent: boolean) => ({
  label: branch,
  folderPath: REPO, // deliberately shared: that is what makes this the hard case
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
          // `main` is checked out; the live session recorded `feat`.
          branchUnits: [plain("main", true), plain("feat", false)],
        },
      ],
    },
  ],
};

const session = (id: string, branch: string) => ({
  id,
  path: `${REPO}/.t/${id}.jsonl`,
  cwd: REPO,
  branch,
  title: id,
  last_active: 1_700_000_000,
  created_at: 1_700_000_000,
  name: null,
  agent: "claude",
});

const liveTabs = [
  {
    id: "tab-1",
    workspace: REPO,
    kind: "agent" as const,
    sessionId: "on-feat",
    agent: "claude" as const, state: "live" as const,
  },
];

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") return Promise.resolve([session("on-feat", "feat")]);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
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

/** The branch row for `label`, which is the element carrying that text. */
const branchRow = async (label: string) => (await screen.findByText(label)).parentElement!;

describe("a rollup badge on a plain repo's sibling branch rows", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.handlers = {};
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    // The project open, both branch rows visible and both collapsed, so each
    // shows its own rollup rather than its session rows.
    localStorage.setItem("sway.expanded.v1", JSON.stringify(["p:work/repo"]));
  });

  it("lands on the branch the session recorded, not on its checked-out sibling", async () => {
    render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs} />);

    const feat = await branchRow("feat");
    const main = await branchRow("main");

    // Nothing probes a session hosted in a tab until something asks: the folder
    // sweep skips them by design, so drive the scanner event that does.
    await waitFor(() => expect(bridge.handlers["sessions://changed"]).toBeTruthy());
    bridge.handlers["sessions://changed"]({ payload: null });

    // "Idle" is a probed, quiet, non-blocked session: enough to badge with,
    // and reached without depending on the needs-you floor.
    await waitFor(() => expect(feat.querySelector('[title="Idle"]')).toBeTruthy());
    expect(main.querySelector('[title="Idle"]')).toBeNull();
  });
});
