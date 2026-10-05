// The Toolbar: the crumb to the selected branch and its sync chip, and for a
// Topic just `Topics > name`, with no member row to switch from.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

const A = "/w/api/.tori/worktrees/auth";
const B = "/w/web/.tori/worktrees/auth";

const bridge = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));

// What `git_branch_sync` answers, per root. The sync chip reads the shared git
// store, so a test sets the answer and then drives a refresh, exactly as the
// app does.
const sync = vi.hoisted(() => ({
  byRoot: {} as Record<string, unknown>,
}));

const upstream = (over: Record<string, unknown> = {}) => ({
  detached: false,
  dirty: false,
  head_committed_at: 1700000000,
  upstream: { ahead: 0, behind: 0, has_upstream: true, rewritten: false, superseded: false, ...over },
  base: null,
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "git_branch_sync") return Promise.resolve(sync.byRoot[String(args?.projectPath)] ?? null);
    if (cmd === "get_config")
      return Promise.resolve({ spaces: [{ name: "work", color: "Sky", projects: [{ path: "/w/api" }, { path: "/w/web" }] }] });
    if (cmd === "git_status") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
const handlers: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (handlers[name] ??= []).push(fn);
    return Promise.resolve(() => {
      handlers[name] = (handlers[name] ?? []).filter((f) => f !== fn);
    });
  },
}));

const { default: Toolbar } = await import("./Toolbar");
const { enterRoots, refreshGit, startGitWatch } = await import("../../utils/gitActions");
const { SET_RIGHT_MODE } = await import("../../utils/events");

const topicSel = (activeRoot: string) => ({
  kind: "topic",
  topicId: "f1",
  topicName: "Auth",
  roots: [A, B],
  activeRoot,
  spaceName: "",
  projectName: "Auth",
  projectPath: activeRoot,
  folderPath: activeRoot,
  branch: "feat/auth",
  projectKind: "topic",
});
const unitSel = {
  kind: "unit",
  spaceName: "work",
  projectName: "api",
  projectPath: "/w/api",
  folderPath: "/w/api",
  branch: "main",
  projectKind: "plain",
};

const sessionSel = {
  ...unitSel,
  branch: "bugfix-260903",
  agent: "claude",
  sessionId: "s1",
  sessionPath: "/w/api/s1.jsonl",
  sessionCwd: "/w/api",
  sessionTitle: "For a log prompt, when sent pressing enter it goes under the input field",
  sessionName: null,
};


const crumbs = () =>
  [...document.querySelectorAll("nav[aria-label='location'] > span")].map((s) => s.textContent);

const syncChip = () => document.querySelector("[data-sync-level]") as HTMLButtonElement | null;

/** Seed the store for `roots` with per-root sync answers, as a refresh would. */
async function loadSync(answers: Record<string, unknown>): Promise<void> {
  sync.byRoot = answers;
  const roots = Object.keys(answers);
  enterRoots(roots);
  await Promise.all(roots.map((root) => refreshGit(root)));
}

beforeEach(() => {
  bridge.calls.length = 0;
  sync.byRoot = {};
  for (const key of Object.keys(handlers)) delete handlers[key];
  enterRoots([]);
});

/** The chip's tooltip text. Kobalte mounts the content only while the tooltip
 *  is open and opens on focus with no delay, which is the path that needs no
 *  timers (see Tooltip.test.tsx). */
const tipText = () => {
  const trigger = syncChip()!;
  trigger.focus();
  fireEvent.focus(trigger);
  return screen.queryByRole("tooltip")?.textContent ?? "";
};

const fireFetch = (name: string, payload: unknown) => {
  for (const fn of handlers[name] ?? []) fn({ payload });
};

describe("Toolbar for a Topic", () => {
  it("shows Topics and the Topic's name, with no member to switch to", async () => {
    await loadSync({ [A]: upstream({ behind: 3 }) });
    render(() => <Toolbar selected={topicSel(A) as never} />);
    expect(crumbs()).toEqual(["Topics", "Auth"]);
    expect(screen.queryByRole("group", { name: "Topic members" })).toBeNull();
    expect(syncChip()).toBeNull();
  });

  it("draws the sync chip at every level that has something to say", async () => {
    const cases = [
      [upstream({ ahead: 2, behind: 1 }), "diverged"],
      [upstream({ behind: 3 }), "behind"],
      [upstream({ ahead: 2 }), "ahead"],
      [upstream({ has_upstream: false }), "unpushed"],
      [{ ...upstream(), base: { name: "main", behind: 14, conflicts: [] } }, "baseBehind"],
      [{ ...upstream(), base: { name: "main", behind: 2, conflicts: ["src/a.ts"] } }, "conflicts"],
    ] as const;

    for (const [answer, level] of cases) {
      await loadSync({ "/w/api": answer });
      const view = render(() => <Toolbar selected={unitSel as never} />);
      expect(syncChip()?.dataset.syncLevel).toBe(level);
      view.unmount();
    }
  });

  it("draws nothing at all for a branch with nothing to report", async () => {
    await loadSync({ "/w/api": upstream() });
    render(() => <Toolbar selected={unitSel as never} />);
    // No element, not a blank one: an empty pill is still a thing to hover,
    // focus and click into a state the branch is not in.
    expect(syncChip()).toBeNull();
  });

  it("opens the Changes panel, where every one of these states is acted on", async () => {
    await loadSync({ "/w/api": upstream({ behind: 3 }) });
    const modes: unknown[] = [];
    const onMode = (e: Event) => modes.push((e as CustomEvent).detail);
    window.addEventListener(SET_RIGHT_MODE, onMode);

    render(() => <Toolbar selected={unitSel as never} />);
    fireEvent.click(syncChip()!);
    window.removeEventListener(SET_RIGHT_MODE, onMode);

    expect(modes).toEqual([{ mode: "changes" }]);
  });

  it("says how long ago the refs were fetched, and names a quiet failure", async () => {
    await loadSync({ "/w/api": upstream({ behind: 3 }) });
    const stopWatch = await startGitWatch();
    render(() => <Toolbar selected={unitSel as never} />);

    fireFetch("git://fetch-error", {
      repo: "/w/api",
      ok: false,
      error: "could not read Username",
      quiet: true,
      fetchedAt: Math.floor(Date.now() / 1000) - 5 * 60,
    });

    await waitFor(() => expect(tipText()).toMatch(/Fetched 5 min ago/));
    // The one place a quiet failure is ever said out loud.
    expect(tipText()).toMatch(/could not read Username/);

    stopWatch();
  });

  it("marks a silent branch stale when it cannot reach the remote at all", async () => {
    // In sync, so `syncState` has nothing to say - but the numbers behind that
    // silence are only as fresh as the last fetch that worked.
    await loadSync({ "/w/api": upstream() });
    const stopWatch = await startGitWatch();
    render(() => <Toolbar selected={unitSel as never} />);
    expect(syncChip()).toBeNull();

    fireFetch("git://fetch-error", {
      repo: "/w/api",
      ok: false,
      error: "host is unreachable",
      quiet: true,
      fetchedAt: Math.floor(Date.now() / 1000),
    });

    await waitFor(() => expect(syncChip()?.dataset.syncLevel).toBe("staleFetch"));
    expect(syncChip()?.getAttribute("aria-label")).toBe("Cannot reach the remote");

    stopWatch();
  });

  it("passes the axe gate with a chip on the bar", async () => {
    await loadSync({ "/w/api": { ...upstream(), base: { name: "main", behind: 2, conflicts: ["src/a.ts"] } } });
    render(() => <Toolbar selected={unitSel as never} />);
    expect(syncChip()).toBeTruthy();
    await expectNoAxeViolations(document.body);
  });

  it("keeps the unit crumb as it was and reads no Topic record for it", () => {
    render(() => <Toolbar selected={unitSel as never} />);
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(bridge.calls.some((c) => c.cmd === "list_topics")).toBe(false);
  });

  it("ends the crumb at the branch when a chat is focused", () => {
    // Focusing a chat tab puts its sessionId on the Selection, which used to add
    // a fourth crumb repeating the tab's own agent mark and title.
    render(() => <Toolbar selected={sessionSel as never} />);
    expect(crumbs()).toEqual(["work", "api", "bugfix-260903"]);
    expect(screen.queryByText(sessionSel.sessionTitle)).toBeNull();
    expect(document.querySelector("nav[aria-label='location'] .claude-icon")).toBeNull();
  });
});
