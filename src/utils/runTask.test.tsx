import { describe, it, expect, beforeEach } from "vite-plus/test";
import { rerunLast, runTask } from "./runTask";
import { loadTaskRuns } from "./taskRecents";
import { OPEN_OMNIBOX, OPEN_TERMINAL, RUN_LAST_TASK, type OpenTerminal } from "./events";
import { COMMANDS } from "./commands";
import type { Task } from "./tasks";

// The one action three surfaces share (the panel's rows, the omnibox's rows and
// the ⌘⇧B binding), so what is pinned is that all three agree: a run is
// recorded before its tab is opened, because the tab id is built from the run
// count and two tabs sharing an id means the second run focuses the first
// instead of starting.

const REPO = "/proj";
const DEV: Task = { id: "npm:dev", name: "dev", source: "npm", command: "pnpm run dev" };
const BUILD: Task = { id: "npm:build", name: "build", source: "npm", command: "pnpm run build" };

/** Every OPEN_TERMINAL that goes out while `fn` runs. */
function opened(fn: () => void): OpenTerminal[] {
  const seen: OpenTerminal[] = [];
  const listener = (e: Event) => seen.push((e as CustomEvent<OpenTerminal>).detail);
  window.addEventListener(OPEN_TERMINAL, listener);
  try {
    fn();
  } finally {
    window.removeEventListener(OPEN_TERMINAL, listener);
  }
  return seen;
}

beforeEach(() => localStorage.clear());

describe("running a task", () => {
  it("opens its tab and writes the run through to storage", () => {
    // Written through rather than held: the hotkey below reads storage, because
    // the panel that recorded the run is gone by the time it fires.
    const tabs = opened(() => runTask({}, REPO, DEV));
    expect(tabs).toHaveLength(1);
    expect(tabs[0].init).toBe("pnpm run dev\n");
    expect(loadTaskRuns()[REPO][0].task.name).toBe("dev");
  });

  it("numbers the tab from the run count, so two runs are two tabs", () => {
    const first = opened(() => runTask(loadTaskRuns(), REPO, DEV));
    const second = opened(() => runTask(loadTaskRuns(), REPO, DEV));
    expect(first[0].id).not.toBe(second[0].id);
  });
});

describe("the rerun hotkey", () => {
  it("re-runs the last task with nothing to pick", () => {
    // The point of the binding: the question "which task" was answered the last
    // time, and asking it again is what a picker would do.
    runTask({}, REPO, DEV);
    runTask(loadTaskRuns(), REPO, BUILD);

    const tabs = opened(() => expect(rerunLast(REPO)).toBe("ran"));
    expect(tabs).toHaveLength(1);
    expect(tabs[0].init).toBe("pnpm run build\n");
  });

  it("keeps the reruns coming, each in its own tab", () => {
    runTask({}, REPO, DEV);
    const a = opened(() => rerunLast(REPO));
    const b = opened(() => rerunLast(REPO));
    expect(new Set([a[0].id, b[0].id]).size).toBe(2);
  });

  it("says why rather than running when this workspace has run nothing", () => {
    runTask({}, "/elsewhere", DEV);
    expect(opened(() => expect(rerunLast(REPO)).toBe("nothing-run-here"))).toHaveLength(0);
  });

  it("says why rather than running with no branch selected", () => {
    runTask({}, REPO, DEV);
    expect(opened(() => expect(rerunLast(null)).toBe("no-workspace"))).toHaveLength(0);
  });

  it("is what ⌘⇧B asks for, rather than a picker", () => {
    // The whole point of the key: "which task" was answered by the last run, so
    // a box asking it again would be the thing it exists to skip. Checked
    // through the registry's own entry, since that is what the sheet prints.
    const rerun = COMMANDS.find((c) => c.id === "rerun-last-task")!;
    const fired: string[] = [];
    const listener = (e: Event) => fired.push(e.type);
    for (const name of [RUN_LAST_TASK, OPEN_OMNIBOX]) window.addEventListener(name, listener);
    try {
      rerun.run!();
    } finally {
      for (const name of [RUN_LAST_TASK, OPEN_OMNIBOX]) window.removeEventListener(name, listener);
    }
    expect(fired).toEqual([RUN_LAST_TASK]);
  });
});
