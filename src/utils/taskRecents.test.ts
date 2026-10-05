import { describe, it, expect } from "vite-plus/test";
import {
  lastRun,
  noteRun,
  parseRunStore,
  runCount,
  runsFor,
  type TaskRunStore,
} from "./taskRecents";
import type { Task } from "./tasks";

// A short list whose only job is "what I just did", so what is pinned is the
// ordering, the per-task run count the tab ids depend on, and the workspace
// bucketing that keeps one worktree's runs out of another's.

const t = (name: string, command = `npm run ${name}`): Task => ({
  id: `npm:${name}`,
  name,
  source: "npm",
  command,
});

const WS = "/proj";

describe("recording a run", () => {
  it("puts the task at the front", () => {
    let s: TaskRunStore = {};
    s = noteRun(s, WS, t("dev"), 1);
    s = noteRun(s, WS, t("test"), 2);
    expect(runsFor(s, WS).map((r) => r.task.name)).toEqual(["test", "dev"]);
  });

  it("moves a task already listed rather than listing it twice", () => {
    let s: TaskRunStore = {};
    s = noteRun(s, WS, t("dev"), 1);
    s = noteRun(s, WS, t("test"), 2);
    s = noteRun(s, WS, t("dev"), 3);
    expect(runsFor(s, WS).map((r) => r.task.name)).toEqual(["dev", "test"]);
  });

  it("counts the runs, because the tab id is built from the count", () => {
    // Two tabs sharing an id means the second run focuses the first run's tab
    // instead of running.
    let s: TaskRunStore = {};
    expect(runCount(s, WS, "npm:dev")).toBe(0);
    s = noteRun(s, WS, t("dev"), 1);
    expect(runCount(s, WS, "npm:dev")).toBe(1);
    s = noteRun(s, WS, t("dev"), 2);
    expect(runCount(s, WS, "npm:dev")).toBe(2);
  });

  it("takes the freshly-run task's body, keeping the count across it", () => {
    // Editing a script changes what a rerun does; it does not make it a new task.
    let s: TaskRunStore = {};
    s = noteRun(s, WS, t("dev", "npm run dev"), 1);
    s = noteRun(s, WS, t("dev", "npm run dev -- --host"), 2);
    expect(runsFor(s, WS)[0].task.command).toBe("npm run dev -- --host");
    expect(runCount(s, WS, "npm:dev")).toBe(2);
  });

  it("drops the oldest past the cap", () => {
    let s: TaskRunStore = {};
    for (const name of ["a", "b", "c"]) s = noteRun(s, WS, t(name), 1);
    s = noteRun(s, WS, t("d"), 1, 3);
    expect(runsFor(s, WS).map((r) => r.task.name)).toEqual(["d", "c", "b"]);
  });

  it("keeps two worktrees' runs apart", () => {
    // The same relative project in two worktrees is two sets of work.
    let s: TaskRunStore = {};
    s = noteRun(s, "/a", t("dev"), 1);
    s = noteRun(s, "/b", t("test"), 2);
    expect(lastRun(s, "/a")?.name).toBe("dev");
    expect(lastRun(s, "/b")?.name).toBe("test");
  });
});

describe("what the rerun hotkey repeats", () => {
  it("is the most recent run in this workspace", () => {
    let s: TaskRunStore = {};
    s = noteRun(s, WS, t("dev"), 1);
    s = noteRun(s, WS, t("build"), 2);
    expect(lastRun(s, WS)?.name).toBe("build");
  });

  it("is nothing at all before anything has been run here", () => {
    expect(lastRun({}, WS)).toBeNull();
    expect(lastRun(noteRun({}, "/other", t("dev"), 1), WS)).toBeNull();
  });

  it("is nothing with no workspace selected", () => {
    expect(lastRun(noteRun({}, WS, t("dev"), 1), null)).toBeNull();
    expect(runsFor({}, null)).toEqual([]);
  });
});

describe("reading what was stored", () => {
  it("survives a round trip", () => {
    const s = noteRun({}, WS, t("dev"), 5);
    expect(parseRunStore(JSON.stringify(s))).toEqual(s);
  });

  it("reads anything it cannot understand as nothing run", () => {
    expect(parseRunStore(null)).toEqual({});
    expect(parseRunStore("not json")).toEqual({});
    expect(parseRunStore('{"/proj":"nope"}')).toEqual({});
  });

  it("drops an entry missing what a rerun needs", () => {
    // A stored entry with no command is a row that cannot be run, and a panel
    // row that does nothing is worse than one that is not there.
    const raw = JSON.stringify({
      "/proj": [
        { task: { id: "npm:dev", name: "dev", source: "npm" }, runs: 1, lastAt: 1 },
        { task: { id: "npm:ok", name: "ok", source: "npm", command: "npm run ok" }, runs: 1, lastAt: 2 },
        { task: { id: "x", name: "x", source: "cargo", command: "c" }, runs: 1, lastAt: 3 },
      ],
    });
    expect(parseRunStore(raw)["/proj"].map((r) => r.task.name)).toEqual(["ok"]);
  });
});
