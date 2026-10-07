// The schedule and the side effects around `cleanupVerdict`: which projects to
// ask about, what is open or running, the removal itself, and the one toast.
//
// Fed its UI inputs by App rather than importing the panels, the same shape as
// `forgeStatus.ts`: whoever knows a fact passes it in.

import { createEffect, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { settings } from "../panels/Settings/settingsStore";
import { pushToast } from "../components/Toasts/Toasts";
import { PURGE_UNDER_PATH, emitWith, type PurgeUnderPath } from "./events";
import { detachedCandidates, liveCandidates } from "./folderActors";
import { mergedHeads, onForgeReport } from "./forgeStatus";
import { isUnderPath } from "./pathScope";
import { cleanupVerdict, type CleanupFacts } from "./worktreeCleanupVerdict";

export type CleanupInputs = {
  selectedRoot: () => string | null;
  /** Every path an editor or terminal tab holds open, in any workspace. */
  openPaths: () => readonly string[];
};

type ConfigProjects = { spaces: { projects: { path: string; branchUnits: { kind: string }[] }[] }[] };
type AutopilotRow = { state: string; worktree?: string | null };

const HOUR_MS = 60 * 60 * 1000;
const FINISHED = new Set(["done", "failed"]);

const enabled = () => settings.git.cleanupAfterMerge || settings.git.cleanupAfterIdleDays > 0;

async function everyProject(): Promise<string[]> {
  const cfg = await invoke<ConfigProjects | null>("get_config").catch(() => null);
  const paths = (cfg?.spaces ?? [])
    .flatMap((s) => s.projects)
    .filter((p) => p.branchUnits.some((u) => u.kind === "worktree" || u.kind === "plain"))
    .map((p) => p.path);
  return [...new Set(paths)];
}

async function autopilotWorktrees(): Promise<string[]> {
  const state = await invoke<{ items: AutopilotRow[] }>("autopilot_state").catch(() => null);
  return (state?.items ?? []).filter((i) => !FINISHED.has(i.state) && i.worktree).map((i) => i.worktree!);
}

async function busy(path: string): Promise<boolean> {
  if (liveCandidates().some((c) => isUnderPath(c.folderPath, path))) return true;
  return (await detachedCandidates(path)).length > 0;
}

/** One project's removals. `mergeOnly` is the forge report's recheck, which
 *  has news about pull requests and nothing else. Answers the removed branches. */
async function sweepProject(
  project: string,
  inputs: CleanupInputs,
  autopilot: readonly string[],
  mergeOnly: boolean,
): Promise<string[]> {
  const heads = settings.git.cleanupAfterMerge ? mergedHeads(project) : {};
  if (mergeOnly && Object.keys(heads).length === 0) return [];
  const facts = await invoke<CleanupFacts[]>("worktree_cleanup_facts", {
    projectPath: project,
    mergedHeads: heads,
    mergedOnly: mergeOnly,
  }).catch(() => [] as CleanupFacts[]);
  const cleanupSettings = {
    cleanupAfterMerge: settings.git.cleanupAfterMerge,
    cleanupAfterIdleDays: mergeOnly ? 0 : settings.git.cleanupAfterIdleDays,
  };
  const removed: string[] = [];
  for (const f of facts) {
    const verdict = (isBusy: boolean) =>
      cleanupVerdict({
        facts: f,
        merged: Object.prototype.hasOwnProperty.call(heads, f.branch),
        busy: isBusy,
        selectedRoot: inputs.selectedRoot(),
        openPaths: inputs.openPaths(),
        autopilotWorktrees: autopilot,
        settings: cleanupSettings,
        now: Math.floor(Date.now() / 1000),
      }).remove;
    // The session probe spawns processes, so it runs only for a worktree that
    // every other check already lets go.
    if (!verdict(false) || !verdict(await busy(f.path))) continue;
    // The facts are a few awaits old by now. A purge cannot be taken back, so
    // the cheap check runs again right before it.
    if (await invoke<boolean>("worktree_dirty", { path: f.path }).catch(() => true)) continue;
    emitWith<PurgeUnderPath>(PURGE_UNDER_PATH, { path: f.path });
    try {
      await invoke("remove_worktree", { repoPath: project, worktreePath: f.path, force: false });
      removed.push(f.branch);
    } catch {
      // Refused (it went dirty after all) or git failed: the worktree stays,
      // and the next sweep asks again.
    }
  }
  return removed;
}

/** Starts the sweep: at once, whenever either setting changes, hourly, and for
 *  one project each time the forge poll answers for it. Returns the teardown. */
export function startWorktreeCleanup(inputs: CleanupInputs): () => void {
  let running = false;
  let rerun: (() => Promise<void>) | null = null;

  // Single flight: a trigger that lands mid-sweep queues one rerun rather than
  // a second sweep racing the first to the same removals. A second trigger
  // queued behind the first widens it to a full sweep, which covers both.
  const run = async (work: () => Promise<void>) => {
    if (!enabled()) return;
    if (running) {
      rerun = rerun === null ? work : full;
      return;
    }
    running = true;
    try {
      await work();
    } finally {
      running = false;
      const next = rerun;
      rerun = null;
      if (next) void run(next);
    }
  };

  const report = (removed: string[]) => {
    if (removed.length === 0) return;
    const names = removed.join(", ");
    pushToast(
      `Removed ${removed.length === 1 ? "worktree" : "worktrees"} for ${names}. Add Worktree brings one back.`,
      "info",
    );
  };

  const full = async () => {
    const autopilot = await autopilotWorktrees();
    const removed: string[] = [];
    for (const project of await everyProject()) {
      removed.push(...(await sweepProject(project, inputs, autopilot, false)));
    }
    report(removed);
  };

  const recheck = (project: string) => async () => {
    if (!settings.git.cleanupAfterMerge) return;
    report(await sweepProject(project, inputs, await autopilotWorktrees(), true));
  };

  createEffect(
    on(
      () => [settings.git.cleanupAfterMerge, settings.git.cleanupAfterIdleDays],
      () => void run(full),
    ),
  );
  const timer = window.setInterval(() => void run(full), HOUR_MS);
  const stopReports = onForgeReport((project) => void run(recheck(project)));

  return () => {
    window.clearInterval(timer);
    stopReports();
  };
}
