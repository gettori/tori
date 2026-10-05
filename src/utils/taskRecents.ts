// Which tasks this workspace actually runs, so the second run costs no picker
// and the tenth costs no thinking.
//
// Recency order rather than frecency: a task list is short and already ordered
// by the project (the `scripts` block is written with the daily ones on top),
// so the only thing a store can add is "what I just did", and a decay curve
// over a dozen names would mostly reorder things under the cursor.
//
// The whole `Task` is kept, not its id: the rerun hotkey has to be able to run
// without first re-reading `package.json`, and a task that has since been
// deleted from the project fails loudly in the shell, which is the right place
// for it to fail.

import type { Task } from "./tasks";

export type TaskRun = {
  task: Task;
  /** How many times this task has been run here. The tab id carries it, so a
   *  re-run opens its own tab rather than colliding with the live one. */
  runs: number;
  lastAt: number;
};

/** Per-workspace, keyed by branch-unit folder, newest first. Bucketed like the
 *  tab strip and the jump list, and for the same reason: `npm run dev` in one
 *  worktree is not the run you made in another. */
export type TaskRunStore = Readonly<Record<string, readonly TaskRun[]>>;

const LS_TASK_RUNS = "tori.taskRuns";

/** How many a workspace keeps. Past this it is a history, and the panel already
 *  lists every task the project defines. */
export const MAX_RECENTS = 10;

export function runsFor(store: TaskRunStore, ws: string | null): readonly TaskRun[] {
  return (ws && store[ws]) || [];
}

/** How many times a task has been run here, zero when never. */
export function runCount(store: TaskRunStore, ws: string | null, taskId: string): number {
  return runsFor(store, ws).find((r) => r.task.id === taskId)?.runs ?? 0;
}

/** The task the rerun hotkey repeats, or null when this workspace has run none. */
export function lastRun(store: TaskRunStore, ws: string | null): Task | null {
  return runsFor(store, ws)[0]?.task ?? null;
}

/**
 * Record a run: to the front, with its count bumped.
 *
 * The stored `task` is overwritten from the one just run, so editing a script's
 * body updates what a rerun will do. The count is carried across that, since it
 * counts runs of the *name*, which is what the tab id needs to stay unique.
 */
export function noteRun(store: TaskRunStore, ws: string, task: Task, now: number, cap = MAX_RECENTS): TaskRunStore {
  if (!ws) return store;
  const prev = runsFor(store, ws);
  const runs = (prev.find((r) => r.task.id === task.id)?.runs ?? 0) + 1;
  const rest = prev.filter((r) => r.task.id !== task.id);
  return { ...store, [ws]: [{ task, runs, lastAt: now }, ...rest].slice(0, cap) };
}

/** Tolerant of anything already in storage: a shape that does not parse reads
 *  as "nothing run here" rather than throwing on startup. */
export function parseRunStore(raw: string | null): TaskRunStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, TaskRun[]> = {};
    for (const [ws, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const kept: TaskRun[] = [];
      for (const entry of list) {
        const e = entry as Partial<TaskRun> | null;
        const t = e?.task as Partial<Task> | undefined;
        if (
          !t ||
          typeof t.id !== "string" ||
          typeof t.name !== "string" ||
          typeof t.command !== "string" ||
          (t.source !== "npm" && t.source !== "make" && t.source !== "just") ||
          typeof e?.runs !== "number" ||
          typeof e?.lastAt !== "number"
        ) {
          continue;
        }
        kept.push({
          task: {
            id: t.id,
            name: t.name,
            source: t.source,
            command: t.command,
            ...(typeof t.dir === "string" && t.dir ? { dir: t.dir } : {}),
          },
          runs: e.runs,
          lastAt: e.lastAt,
        });
      }
      if (kept.length) out[ws] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadTaskRuns(): TaskRunStore {
  try {
    return parseRunStore(localStorage.getItem(LS_TASK_RUNS));
  } catch {
    return {};
  }
}

export function saveTaskRuns(store: TaskRunStore): void {
  try {
    localStorage.setItem(LS_TASK_RUNS, JSON.stringify(store));
  } catch {
    /* quota or private mode: the panel still lists every task, unordered */
  }
}
