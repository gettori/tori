// Running a task, in one place.
//
// Three surfaces start a run: the Scripts section, the omnibox's rows, and the
// rerun hotkey. They must agree on all three steps (record the run, mint the
// tab id from the run count, open the tab), because the tab id *is* the run
// count: a surface that opened a tab without recording the run would collide
// with the next one that did, and focus a live task instead of starting one.

import { emitWith, OPEN_TERMINAL } from "./events";
import { taskTab, type Task } from "./tasks";
import { lastRun, loadTaskRuns, noteRun, runCount, saveTaskRuns, type TaskRunStore } from "./taskRecents";

/**
 * Run `task` in `root` and return the store with the run recorded.
 *
 * The caller keeps the returned store (its own signal reads it back), and this
 * writes it through to storage, so a run recorded by one surface is a recent
 * the others see on their next read.
 */
export function runTask(store: TaskRunStore, root: string, task: Task): TaskRunStore {
  const next = noteRun(store, root, task, Date.now());
  saveTaskRuns(next);
  emitWith(OPEN_TERMINAL, taskTab(root, task, runCount(next, root, task.id)));
  return next;
}

/** Why a rerun did nothing, or that it ran. A value rather than a toast, so the
 *  rule is testable without a window and the wording lives with the other
 *  user-facing text in App. */
export type RerunOutcome = "ran" | "nothing-run-here" | "no-workspace";

/**
 * Run this workspace's last task again.
 *
 * Reads storage rather than taking a store, because the hotkey fires from
 * wherever focus happens to be: the Scripts section that recorded the run is torn
 * down as soon as another right-hand mode is showing, so there is no live
 * signal to consult and no picker to reopen.
 */
export function rerunLast(root: string | null): RerunOutcome {
  if (!root) return "no-workspace";
  const store = loadTaskRuns();
  const task = lastRun(store, root);
  if (!task) return "nothing-run-here";
  runTask(store, root, task);
  return "ran";
}
