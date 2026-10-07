import { describe, expect, it } from "vite-plus/test";
import { cleanupVerdict, type CleanupFacts, type CleanupInput } from "./worktreeCleanupVerdict";

const NOW = 1_800_000_000;
const DAY = 86_400;

function facts(over: Partial<CleanupFacts> = {}): CleanupFacts {
  return {
    path: "/p/feat",
    branch: "feat",
    head: "abc",
    dirty: false,
    unpushed: false,
    lastActivity: NOW - 30 * DAY,
    inMergedHead: false,
    ...over,
  };
}

function input(over: Partial<CleanupInput> = {}): CleanupInput {
  return {
    facts: facts(),
    merged: false,
    busy: false,
    selectedRoot: null,
    openPaths: [],
    autopilotWorktrees: [],
    settings: { cleanupAfterMerge: true, cleanupAfterIdleDays: 7 },
    now: NOW,
    ...over,
  };
}

describe("cleanupVerdict", () => {
  it.each<[string, Partial<CleanupInput>, boolean]>([
    [
      "a squash merge whose upstream was deleted",
      { merged: true, facts: facts({ unpushed: true, inMergedHead: true, lastActivity: NOW }) },
      true,
    ],
    [
      "a local commit after the merged head",
      { merged: true, facts: facts({ unpushed: true, inMergedHead: false, lastActivity: NOW }) },
      false,
    ],
    ["a fresh worktree off an old base", { facts: facts({ lastActivity: NOW - 60 }) }, false],
    ["idle past the threshold and pushed", {}, true],
    ["idle but unpushed", { facts: facts({ unpushed: true }) }, false],
    ["dirty", { facts: facts({ dirty: true }) }, false],
    ["the selected folder with no tabs", { selectedRoot: "/p/feat" }, false],
    ["a folder nested in the selection's worktree", { selectedRoot: "/p/feat/src" }, false],
    ["a sibling sharing a prefix is not the selection", { selectedRoot: "/p/feature" }, true],
    ["a live tab or session", { busy: true }, false],
    ["an open editor tab", { openPaths: ["/p/feat/a.ts"] }, false],
    ["an active autopilot worktree", { autopilotWorktrees: ["/p/feat"] }, false],
    [
      "both settings off",
      {
        merged: true,
        facts: facts({ inMergedHead: true }),
        settings: { cleanupAfterMerge: false, cleanupAfterIdleDays: 0 },
      },
      false,
    ],
  ])("%s", (_, over, remove) => {
    expect(cleanupVerdict(input(over)).remove).toBe(remove);
  });

  it("names the merge rule when both apply", () => {
    expect(cleanupVerdict(input({ merged: true, facts: facts({ inMergedHead: true }) }))).toEqual({
      remove: true,
      rule: "merged",
    });
  });
});
