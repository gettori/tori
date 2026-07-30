import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// What the sidebar is *for* once its session level is gone: spaces, projects,
// branch-units, the rollup badges that report what is live underneath, and the
// three context menus. Written before the deletion so it pins the current
// behaviour rather than describing whatever survives it.
//
// Deliberately not asserted here: the plain-dir project row's badge rule, which
// this phase changes on purpose (a folder with no branch node loses its only
// session surface, so its rollup becomes unconditional).
const WORK = "/root/work";
const REPO = `${WORK}/repo`;
const NOTES = `${WORK}/notes`;

const worktree = (label: string, isCurrent: boolean) => ({
  label,
  folderPath: `${REPO}/${label}`,
  branch: label,
  kind: "worktree",
  isCurrent,
});

const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: WORK,
      external: false,
      projects: [
        {
          name: "repo",
          path: REPO,
          external: false,
          branchUnits: [worktree("main", true), worktree("feat", false)],
        },
        {
          name: "notes",
          path: NOTES,
          external: false,
          branchUnits: [
            { label: "notes", folderPath: NOTES, branch: null, kind: "plain-dir", isCurrent: false },
          ],
        },
      ],
    },
    {
      name: "side",
      path: "/root/side",
      external: false,
      projects: [
        {
          name: "scratch",
          path: "/root/side/scratch",
          external: false,
          branchUnits: [
            {
              label: "scratch",
              folderPath: "/root/side/scratch",
              branch: null,
              kind: "plain-dir",
              isCurrent: false,
            },
          ],
        },
      ],
    },
  ],
};

const session = (id: string, cwd: string, branch: string | null) => ({
  id,
  path: `${cwd}/.t/${id}.jsonl`,
  cwd,
  branch,
  title: id,
  last_active: 1_700_000_000,
  created_at: 1_700_000_000,
  name: null,
  agent: "claude",
});

const onFeat = session("on-feat", `${REPO}/feat`, "feat");
const inNotes = session("in-notes", NOTES, null);

const tab = (id: string, workspace: string, sessionId: string) => ({
  id,
  workspace,
  kind: "agent" as const,
  sessionId,
  agent: "claude" as const,
});

const liveTabs = [tab("tab-1", `${REPO}/feat`, onFeat.id), tab("tab-2", NOTES, inNotes.id)];

const bridge = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions") {
      if (args.folder === `${REPO}/feat`) return Promise.resolve([onFeat]);
      if (args.folder === NOTES) return Promise.resolve([inNotes]);
      return Promise.resolve([]);
    }
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

/** The row element carrying `label`, which is that text's own parent. */
const row = async (label: string) => (await screen.findByText(label)).parentElement!;

const selections: unknown[] = [];
const mount = (expandedKeys: string[] = []) => {
  localStorage.setItem("sway.expanded.v1", JSON.stringify(expandedKeys));
  return render(() => (
    <LeftSidebar selected={null} onSelect={(s) => selections.push(s)} liveTabs={liveTabs} />
  ));
};

/** Drive the scanner event: a session hosted in a tab is never probed by the
 *  folder sweep, so nothing would resolve its status without it. */
const settle = async () => {
  await waitFor(() => expect(bridge.handlers["sessions://changed"]).toBeTruthy());
  bridge.handlers["sessions://changed"]({ payload: null });
};

describe("the sidebar levels that outlive the session rows", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.handlers = {};
    selections.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
  });

  it("shows one tile per space and renders only the active space's projects", async () => {
    mount();

    // Both tiles exist whatever is active; only one space's tree is rendered.
    expect(await screen.findByTitle("work")).toBeTruthy();
    expect(screen.getByTitle("side")).toBeTruthy();
    expect(screen.getByText("repo")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
    expect(screen.queryByText("scratch")).toBeNull();

    fireEvent.click(screen.getByTitle("side"));

    await waitFor(() => expect(screen.getByText("scratch")).toBeTruthy());
    expect(screen.queryByText("repo")).toBeNull();
  });

  it("expands a git project into its branch-unit rows", async () => {
    mount();

    const repo = await row("repo");
    expect(screen.queryByText("main")).toBeNull();

    fireEvent.click(repo);

    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    expect(screen.getByText("feat")).toBeTruthy();
  });

  it("rolls a live session up onto its own branch row and not onto its sibling", async () => {
    mount(["p:work/repo"]);

    const feat = await row("feat");
    const main = await row("main");
    await settle();

    await waitFor(() => expect(feat.querySelector('[title="Idle"]')).toBeTruthy());
    expect(main.querySelector('[title="Idle"]')).toBeNull();
  });

  it("rolls that same session up to the project row while the project is closed", async () => {
    mount();

    const repo = await row("repo");
    await settle();

    await waitFor(() => expect(repo.querySelector('[title="Idle"]')).toBeTruthy());
  });

  // A branch row has nothing under it any more: sessions are reached from the
  // terminal pane's History dropdown, so clicking one means select, not expand.
  it("renders a branch-unit row as a leaf that selects when clicked", async () => {
    mount(["p:work/repo"]);

    const feat = await row("feat");
    const before = feat.parentElement!.textContent;

    fireEvent.click(feat);

    await waitFor(() => expect(selections.length).toBe(1));
    expect(selections[0]).toMatchObject({ folderPath: `${REPO}/feat`, branch: "feat" });
    // Nothing appeared underneath it, and there is no disclosure to have opened.
    expect(feat.parentElement!.textContent).toBe(before);
    expect(screen.queryByText("on-feat")).toBeNull();
  });

  // The one sidebar rule this phase changes on purpose: a non-git folder is a
  // leaf too, and its row is the only place its sessions can ever report, so it
  // carries the rollup whether or not anything is "open".
  it("carries a plain-dir folder's rollup on the project row unconditionally", async () => {
    mount(["p:work/notes"]);

    const notes = await row("notes");
    await settle();

    await waitFor(() => expect(notes.querySelector('[title="Idle"]')).toBeTruthy());
    expect(screen.queryByText("in-notes")).toBeNull();
  });

  it("keeps the space, project and branch-unit context menus", async () => {
    mount(["p:work/repo"]);

    fireEvent.contextMenu(await screen.findByTitle("work"));
    expect(await screen.findByText("New…")).toBeTruthy();
    expect(screen.getByText("Edit space…")).toBeTruthy();
    expect(screen.getByText("Delete space")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(await row("repo"));
    expect(await screen.findByText("Add Worktree")).toBeTruthy();
    expect(screen.getByText("Fan out…")).toBeTruthy();
    expect(screen.getByText("Remove project")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(await row("feat"));
    expect(await screen.findByText("New session")).toBeTruthy();
    expect(screen.getByText("Remove worktree")).toBeTruthy();
  });
});
