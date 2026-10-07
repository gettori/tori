import { isUnderPath } from "./pathScope";

/** Mirrors `CleanupFacts` in src-tauri/src/worktree_cleanup.rs. */
export type CleanupFacts = {
  path: string;
  branch: string;
  head: string;
  dirty: boolean;
  unpushed: boolean;
  /** Epoch seconds. */
  lastActivity: number;
  inMergedHead: boolean;
};

export type CleanupSettings = { cleanupAfterMerge: boolean; cleanupAfterIdleDays: number };

export type CleanupInput = {
  facts: CleanupFacts;
  /** The branch's pull request merged, as the forge poll last saw it. */
  merged: boolean;
  /** A live tab or a detached session is working in the folder. */
  busy: boolean;
  selectedRoot: string | null;
  openPaths: readonly string[];
  autopilotWorktrees: readonly string[];
  settings: CleanupSettings;
  /** Epoch seconds. */
  now: number;
};

export type CleanupVerdict = { remove: true; rule: "merged" | "idle" } | { remove: false; reason: string };

const DAY = 86_400;

export function cleanupVerdict(i: CleanupInput): CleanupVerdict {
  const { facts, settings } = i;
  const keep = (reason: string): CleanupVerdict => ({ remove: false, reason });
  const mergeRule = settings.cleanupAfterMerge && i.merged && facts.inMergedHead;
  const idleRule =
    settings.cleanupAfterIdleDays > 0 &&
    !facts.unpushed &&
    i.now - facts.lastActivity > settings.cleanupAfterIdleDays * DAY;
  if (!mergeRule && !idleRule) return keep("no rule applies");
  if (facts.dirty) return keep("uncommitted changes");
  if (i.busy) return keep("a session is working in it");
  if (i.selectedRoot && isUnderPath(i.selectedRoot, facts.path)) return keep("it is the selected folder");
  if (i.openPaths.some((p) => isUnderPath(p, facts.path))) return keep("a tab is open in it");
  if (i.autopilotWorktrees.some((w) => isUnderPath(w, facts.path) || isUnderPath(facts.path, w)))
    return keep("an autopilot item is using it");
  return { remove: true, rule: mergeRule ? "merged" : "idle" };
}
