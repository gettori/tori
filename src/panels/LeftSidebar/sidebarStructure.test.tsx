import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { pointerClick, rightClick } from "../../test/menus";
import { expectNoAxeViolations } from "../../test/axe";

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
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: WORK,
      projects: [
        {
          name: "repo",
          path: REPO,
          favicon: `${REPO}/main/public/favicon.svg`,
          branchUnits: [worktree("main", true), worktree("feat", false)],
        },
        {
          name: "notes",
          path: NOTES,
          icon: "Rocket",
          branchUnits: [
            { label: "notes", folderPath: NOTES, branch: null, kind: "plain-dir", isCurrent: false },
          ],
        },
      ],
    },
    {
      name: "side",
      path: "/root/side",
      projects: [
        {
          name: "scratch",
          path: "/root/side/scratch",
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
  agent: "claude" as const, state: "live" as const,
});

const liveTabs = [tab("tab-1", `${REPO}/feat`, onFeat.id), tab("tab-2", NOTES, inNotes.id)];

const bridge = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
  configReads: 0,
  // The sidebar's errors are toasts, and the stack renders from its own portal
  // outside this tree, so the call is what there is to watch.
  toasts: [] as string[],
  // `git_branch_sync_many`'s reply, keyed the way the backend keys it. Set per
  // test; empty is a tree nothing has answered for, which is every test here
  // that predates the state line.
  sync: {} as Record<string, unknown>,
}));

vi.mock("../../components/Toasts/Toasts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pushToast: (message: string) => {
    // The real one drops blank messages, which is still the "clear the banner"
    // idiom at several call sites. A mock that recorded them would count a
    // clear as a toast.
    if (String(message ?? "").trim()) bridge.toasts.push(message);
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_config") {
      bridge.configReads += 1;
      return Promise.resolve(config);
    }
    if (cmd === "list_sessions") {
      if (args.folder === `${REPO}/feat`) return Promise.resolve([onFeat]);
      if (args.folder === NOTES) return Promise.resolve([inNotes]);
      return Promise.resolve([]);
    }
    if (cmd === "git_branch_sync_many") return Promise.resolve(bridge.sync);
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
const { OPEN_IN_EDITOR } = await import("../../utils/events");
const { syntheticId } = await import("../../utils/syntheticTabs");
const { syncUnits } = await import("../../utils/branchSync");

/** The row element carrying `label`, which is that text's own parent. */
const row = async (label: string) => (await screen.findByText(label)).parentElement!;

const selections: unknown[] = [];
const mount = (expandedKeys: string[] = []) => {
  localStorage.setItem("tori.expanded.v1", JSON.stringify(expandedKeys));
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
    bridge.configReads = 0;
    bridge.toasts.length = 0;
    bridge.sync = {};
    selections.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("shows one tile per space and renders only the active space's projects", async () => {
    mount();

    // Both tiles exist whatever is active; only one space's tree is rendered.
    expect(await screen.findByRole("button", { name: "work" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "side" })).toBeTruthy();
    expect(screen.getByText("repo")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
    expect(screen.queryByText("scratch")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "side" }));

    await waitFor(() => expect(screen.getByText("scratch")).toBeTruthy());
    expect(screen.queryByText("repo")).toBeNull();
  });

  it("reloads the tree for a fetch you asked for, and not for the scheduled sweep", async () => {
    mount();
    await screen.findByRole("button", { name: "work" });
    await waitFor(() => expect(bridge.handlers["git://fetch-done"]).toBeTruthy());

    // A sweep emits one of these per container. Reloading on each would be one
    // full rediscovery per repo, on a timer.
    bridge.configReads = 0;
    bridge.handlers["git://fetch-done"]({ payload: { repo: "/somewhere/else", quiet: true } });
    await Promise.resolve();
    expect(bridge.configReads).toBe(0);

    // The manual one is a repo you just acted on, so the tree follows it.
    bridge.handlers["git://fetch-done"]({ payload: { repo: REPO, quiet: false } });
    await waitFor(() => expect(bridge.configReads).toBe(1));
  });

  it("keeps a quiet fetch failure off the sidebar's error line", async () => {
    mount();
    await screen.findByRole("button", { name: "work" });
    await waitFor(() => expect(bridge.handlers["git://fetch-error"]).toBeTruthy());

    // A sweep fails on every repo behind a password prompt it will not show.
    // That is those repos' resting state, not something to shout about.
    bridge.handlers["git://fetch-error"]({
      payload: { repo: REPO, error: "could not read Username", quiet: true },
    });
    await Promise.resolve();
    expect(bridge.toasts).toEqual([]);

    // The manual one still speaks up, so the silence above is a choice.
    bridge.handlers["git://fetch-error"]({
      payload: { repo: REPO, error: "host is unreachable", quiet: false },
    });
    await waitFor(() => expect(bridge.toasts).toEqual(["host is unreachable"]));
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

  // The identity mark moved down a level: a project row now says which project
  // it is (its own favicon, or an icon someone picked), and the git glyph that
  // used to sit there now sits beside the branch it actually describes.
  it("marks a project row with its favicon and each branch row with its git kind", async () => {
    mount(["p:work/repo"]);

    const repo = await row("repo");
    expect(repo.querySelector("img")?.getAttribute("src")).toBe(
      `asset://${REPO}/main/public/favicon.svg`,
    );

    // A project with a chosen glyph renders that glyph, never an image.
    const notes = await row("notes");
    expect(notes.querySelector("img")).toBeNull();
    expect(notes.querySelector('[class*="lucide-rocket"]')).toBeTruthy();

    // Both worktree rows carry the worktree mark the project row used to, at
    // rest: nothing is executing under either of them.
    for (const label of ["main", "feat"]) {
      const mark = (await row(label)).querySelector('[data-mark="worktree"]');
      expect(mark).toBeTruthy();
      expect(mark?.getAttribute("data-active")).toBe("false");
    }
  });

  // The disclosure lives in the project's icon slot now, so the row spends no
  // width at its right edge on a chevron it only needs under the pointer.
  it("puts a project's disclosure chevron in its icon slot", async () => {
    mount(["p:work/repo"]);

    const repo = await row("repo");
    const slot = repo.querySelector('[class*="projectIcon"]')!;
    expect(slot.querySelector('[class*="iconChevron"]')).toBeTruthy();
    expect(repo.querySelector('[class*="rowChevron"]')).toBeNull();

    // A plain folder has nothing to disclose, so it keeps its icon throughout.
    const notes = await row("notes");
    expect(notes.querySelector('[class*="iconChevron"]')).toBeNull();
  });

  it("offers Change icon on every project, whatever its git kind", async () => {
    mount();

    fireEvent.contextMenu(await row("repo"));
    expect(await screen.findByText("Change icon")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    // A plain-dir folder gets it too: the icon is a property of the row, not of
    // whatever git is (or is not) doing underneath it.
    fireEvent.contextMenu(await row("notes"));
    expect(await screen.findByText("Change icon")).toBeTruthy();
  });

  it("keeps the space, project and branch-unit context menus", async () => {
    mount(["p:work/repo"]);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "work" }));
    expect(await screen.findByText("New in “work”")).toBeTruthy();
    expect(screen.getByText("Edit space")).toBeTruthy();
    expect(screen.getByText("Delete space")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(await row("repo"));
    expect(await screen.findByText("Add worktree")).toBeTruthy();
    expect(screen.getByText("Fan out")).toBeTruthy();
    expect(screen.getByText("Remove project")).toBeTruthy();
    // The header names what the menu is acting on, and which of the three
    // project menus this is.
    expect(screen.getByText("Bare")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(await row("feat"));
    expect(await screen.findByText("New session")).toBeTruthy();
    expect(screen.getByText("Remove worktree")).toBeTruthy();
  });

  // Written against the hand-rolled menu (gettori/tori#103, phase 1), now
  // running against Kobalte's (phase 3). What the three menus *contain* is
  // asserted above; this is how they open and close. Where a menu opens is
  // pinned in `ContextMenu.test.tsx`, since no position assertion could span
  // both implementations.
  //
  // What the migration actually had to rewrite here, against phase 1's list:
  //   - `role="menu"` on the surface: unchanged, Kobalte's Content sets it too.
  //   - `defaultPrevented` on the dispatched event: unchanged, and still the
  //     whole difference between a row that owns its right-click and one that
  //     lets the browser's own menu through. Kobalte's trigger is what calls
  //     `preventDefault` now.
  //   - The outside click had to become `pointerDown`: Popover listened for
  //     `mousedown`, the dismissable layer listens for `pointerdown`.
  //   - Picking a row had to become `pointerClick` (`src/test/menus.ts`).
  //   - Replacing an open menu had to spell out the pointerdown a right-click
  //     carries, which the single shared menu signal never needed.
  describe("how the context menus open and close", () => {
    it("claims the right-click on every row that has a menu", async () => {
      mount(["p:work/repo"]);

      // All three levels suppress the browser's own menu, because all three
      // answer with one of their own.
      expect(rightClick(await screen.findByRole("button", { name: "work" }))).toBe(true);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(rightClick(await row("repo"))).toBe(true);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(rightClick(await row("feat"))).toBe(true);
    });

    it("closes on Escape", async () => {
      mount(["p:work/repo"]);
      fireEvent.contextMenu(await row("repo"));
      await screen.findByRole("menu");

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    });

    it("closes on an outside click", async () => {
      mount(["p:work/repo"]);
      fireEvent.contextMenu(await row("repo"));
      await screen.findByRole("menu");
      // Kobalte installs the outside listener from a `setTimeout(0)`, so a click
      // dispatched before this yield lands on a listener that does not exist yet.
      await new Promise((resolve) => setTimeout(resolve, 0));

      fireEvent.pointerDown(document.body);
      fireEvent.mouseDown(document.body);

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    });

    it("closes when a row is picked", async () => {
      mount(["p:work/repo"]);
      fireEvent.contextMenu(await row("feat"));

      pointerClick(await screen.findByText("Graph"));

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    });

    it("replaces the open menu rather than stacking a second one", async () => {
      mount(["p:work/repo"]);
      fireEvent.contextMenu(await row("repo"));
      await screen.findByRole("menu");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A right-click on the *other* row, spelled out: the pointerdown is what
      // dismisses the open menu, and each row now owns its own menu rather than
      // sharing one signal, so the closing is no longer implicit in the opening.
      const feat = await row("feat");
      fireEvent.pointerDown(feat, { button: 2 });
      fireEvent.contextMenu(feat);

      // One surface at a time, whichever row was asked last.
      await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(1));
      expect(await screen.findByText("New session")).toBeTruthy();
    });

    // Each row owns its own menu now, where before one signal held whichever the
    // last handler wrote. So the question "does a branch row inside an open
    // project answer with the branch's menu" stopped being answered by the
    // sidebar's code and started being answered by the DOM. It is only ever the
    // branch's because the rows are siblings rather than nested: a project row
    // ends before its branch list begins, so the right-click never passes
    // through it. This pins that shape, since a refactor that wrapped the branch
    // list inside the project row would silently change what a branch offers.
    // What `menuActive` used to do by hand, and what the CSS now keys on. Only
    // the attribute is assertable: vitest stubs the CSS module import and jsdom
    // resolves no `var()`, so there is no computed background to read here.
    it("marks the row its menu belongs to, and unmarks it on close", async () => {
      mount(["p:work/repo"]);
      const repo = await row("repo");

      fireEvent.contextMenu(repo);
      await screen.findByRole("menu");
      expect(repo.hasAttribute("data-expanded")).toBe(true);

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => expect(repo.hasAttribute("data-expanded")).toBe(false));
    });

    it("answers a branch row with the branch's menu, not the project's", async () => {
      mount(["p:work/repo"]);

      fireEvent.contextMenu(await row("feat"));

      const m = await screen.findByRole("menu");
      expect(within(m).getByText("New session")).toBeTruthy();
      expect(within(m).queryByText("Fan out")).toBeNull();
      expect(within(m).queryByText("Remove project")).toBeNull();
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    });
  });

  it("opens a branch-unit's graph, selecting that unit on the way", async () => {
    mount(["p:work/repo"]);
    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(OPEN_IN_EDITOR, listener);

    fireEvent.contextMenu(await row("feat"));
    pointerClick(await screen.findByText("Graph"));

    // The tab is workspace-scoped, so the unit has to be selected first or the
    // graph would open into a workspace nobody is looking at.
    await waitFor(() => expect(opened).toEqual([syntheticId("graph", `${REPO}/feat`)]));
    expect(selections[selections.length - 1]).toMatchObject({ folderPath: `${REPO}/feat` });
    window.removeEventListener(OPEN_IN_EDITOR, listener);
  });
});

/** `BranchSync` as the backend sends it, clean unless told otherwise. */
const syncOf = (over: Record<string, unknown> = {}) => ({
  detached: false,
  dirty: false,
  head_committed_at: 1_700_000_000,
  upstream: { ahead: 0, behind: 0, has_upstream: true, rewritten: false },
  base: null,
  ...over,
});

const syncKey = (label: string) => `${REPO}/${label}\u0000${label}`;

/** The branch node for `label`: the row and, when it has one, its state line. */
const node = async (label: string) => (await screen.findByText(label)).parentElement!.parentElement!;

/** The kinds of mark on a branch row, in drawing order, with counts. */
const marks = async (label: string) =>
  Array.from((await node(label)).querySelectorAll("[data-sync-mark]")).map(
    (el) => `${el.getAttribute("data-sync-mark")}${el.textContent}`,
  );

describe("what a branch row says about its remote", () => {
  beforeEach(async () => {
    // The sync store is module-level and asks only about units it has not seen,
    // which is what stops `loadConfig` costing a `git` process per row. An
    // empty tree is how it forgets, and without it the mounts above this file
    // would have already claimed these rows.
    await syncUnits([]);
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.handlers = {};
    bridge.sync = {};
    selections.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("draws what the branch owes the remote, and nothing when it owes nothing", async () => {
    bridge.sync = {
      [syncKey("main")]: syncOf({ upstream: { ahead: 2, behind: 3, has_upstream: true, rewritten: false } }),
      [syncKey("feat")]: syncOf(),
    };
    mount(["p:work/repo"]);

    await waitFor(async () => expect(await marks("main")).toEqual(["push2", "pull3"]));
    // Silence is the resting state. A row that drew "in sync" would spend the
    // reader's attention on the news that there is no news.
    expect(await marks("feat")).toEqual([]);
  });

  it("marks a branch nobody has pushed without a count to put on it", async () => {
    bridge.sync = {
      [syncKey("feat")]: syncOf({ upstream: { ahead: 0, behind: 0, has_upstream: false, rewritten: false } }),
    };
    mount(["p:work/repo"]);

    await waitFor(async () => expect(await marks("feat")).toEqual(["push"]));
  });

  it("marks uncommitted work, and a base that would fight", async () => {
    bridge.sync = {
      [syncKey("main")]: syncOf({ dirty: true }),
      [syncKey("feat")]: syncOf({
        base: { name: "main", ahead: 2, behind: 4, conflicts: ["src/a.ts", "src/b.ts"] },
      }),
    };
    mount(["p:work/repo"]);

    await waitFor(async () => expect(await marks("main")).toEqual(["dirty"]));
    // The conflict leads, so the one red glyph in a column keeps its place and
    // never sits against the forge's own marks at the row's other end.
    expect(await marks("feat")).toEqual(["conflict"]);
  });

  it("keeps every row to one line, whatever it has to report", async () => {
    // The row is `--row-h` and the rail, the hover pill and the drag handle are
    // all measured against it, so the marks have to live inside it. jsdom has
    // no layout; what pins the height is that the node holds the row and
    // nothing else.
    bridge.sync = {
      [syncKey("main")]: syncOf({ dirty: true, upstream: { ahead: 2, behind: 3, has_upstream: true, rewritten: false } }),
      [syncKey("feat")]: syncOf(),
    };
    const { container } = mount(["p:work/repo"]);

    await waitFor(async () => expect((await marks("main")).length).toBe(3));
    for (const label of ["main", "feat"]) {
      expect((await node(label)).children.length).toBe(1);
    }
    expect(container.querySelector("[data-state-line]")).toBeNull();
  });

  it("hangs one styled tooltip on the run rather than a native one per glyph", async () => {
    bridge.sync = {
      [syncKey("main")]: syncOf({ upstream: { ahead: 0, behind: 3, has_upstream: true, rewritten: false } }),
    };
    mount(["p:work/repo"]);

    const run = await waitFor(async () => {
      const found = (await node("main")).querySelector("[data-sync-marks]");
      expect(found).toBeTruthy();
      return found!;
    });
    // Nothing native anywhere in the run: the browser's own tooltip is
    // unstyled, slow and un-themeable, and four glyphs inside twenty pixels
    // would be four hover targets for one sentence.
    expect(run.hasAttribute("title")).toBe(false);
    expect(run.querySelectorAll("[title]").length).toBe(0);

    fireEvent.pointerEnter(run);
    expect((await screen.findByRole("tooltip")).textContent).toContain("3 commits to pull");
  });

  it("stands the marks down while an agent holds the row, and brings them back", async () => {
    bridge.sync = {
      [syncKey("feat")]: syncOf({
        dirty: true,
        upstream: { ahead: 1, behind: 2, has_upstream: true, rewritten: false },
      }),
    };
    mount(["p:work/repo"]);
    await waitFor(async () => expect((await marks("feat")).length).toBe(3));

    await waitFor(() => expect(bridge.handlers["pty://activity"]).toBeTruthy());
    bridge.handlers["pty://activity"]({ payload: { id: "tab-1", state: "active" } });
    bridge.handlers["sessions://changed"]({ payload: null });

    // Two of those three are being rewritten as you read them, and the third is
    // "uncommitted changes" on a row where an agent is writing files.
    await waitFor(async () => expect(await marks("feat")).toEqual([]));

    bridge.handlers["pty://activity"]({ payload: { id: "tab-1", state: "quiet" } });
    await waitFor(async () => expect((await marks("feat")).length).toBe(3));
  });

  it("passes axe with a tree of rows that have something to report", async () => {
    bridge.sync = {
      [syncKey("main")]: syncOf({ dirty: true }),
      [syncKey("feat")]: syncOf({
        base: { name: "main", ahead: 2, behind: 4, conflicts: ["src/a.ts"] },
      }),
    };
    const { container } = mount(["p:work/repo"]);
    await waitFor(async () => expect((await marks("feat")).length).toBe(1));

    await expectNoAxeViolations(container);
  });
});
