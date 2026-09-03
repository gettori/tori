// Jobs: the transient commands Sway runs for you (a clone, a bare-worktree
// bootstrap, an agent install/update/uninstall, a sign-in). Module-level like
// terminalTabStore, so the tray, the drawer and the callers share one model
// without mounting anything.
//
// They were `kind: "command"` tabs until [[adr_jobs_leave_the_tab_model]]. That
// put them in the workspace-keyed tab model under a cwd that is not a branch
// unit, so the tab joined no strip and focusing it hid the strip the user was
// actually in. A job has no workspace at all, which is the fix.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { refreshAgentHealth } from "../../utils/agentHealth";
import { dropStageHost } from "../../tabs/stageHost";
import type { OpenJob } from "../../utils/events";

/** Running, or finished and classified. There is no "cancelled": a job the user
 *  stopped still exited, and its code says how. */
export type JobState = "running" | "ok" | "failed";

export type Job = OpenJob & {
  startedAt: number;
  state: JobState;
  /** The exit code, once there is one. `null` is an exit the backend could not
   *  confirm, which is why it is distinct from "no exit yet" (`undefined`). */
  code?: number | null;
  endedAt?: number;
};

/**
 * How an exit code reads.
 *
 * A `null` code is an exit the backend could not confirm within its wait, and
 * an unproven exit is a failure: the output an early success would close over
 * is exactly the output worth keeping.
 */
export const stateForCode = (code: number | null): Exclude<JobState, "running"> =>
  code === 0 ? "ok" : "failed";

const [jobs, setJobs] = createSignal<Job[]>([]);
const [shownId, setShownId] = createSignal<string | null>(null);

export { jobs };

/** The job the drawer is showing, or null when it is closed. A stale id cannot
 *  survive here: every removal path clears it (see `forgetJob`). */
export const shownJob = (): Job | null => jobs().find((j) => j.id === shownId()) ?? null;

/** Show a job's output. Also what a tray row does, so a drawer dismissed with
 *  Escape has a way back. */
export function showJob(id: string): void {
  if (jobs().some((j) => j.id === id)) setShownId(id);
}

export function hideDrawer(): void {
  setShownId(null);
}

/**
 * Start a job, or reveal the one already running under this id.
 *
 * The dedupe is the whole reason job ids are minted from what they act on
 * (`install:claude`, `signin:claude:work`): pressing Install twice must focus
 * the install in progress, not race two package managers over one global bin
 * directory. Clone mints a fresh id per press, because two clones are two
 * clones.
 */
export function startJob(spec: OpenJob): void {
  if (jobs().some((j) => j.id === spec.id)) {
    setShownId(spec.id);
    return;
  }
  setJobs([...jobs(), { ...spec, startedAt: Date.now(), state: "running" }]);
  // Newest wins: the user just pressed a button, and the tray row is the way
  // back to whatever it displaced.
  setShownId(spec.id);
}

/**
 * The process behind a job ended.
 *
 * A clean exit clears the job outright, drawer and all: there is nothing left
 * to read, and a receipt that has to be dismissed is a chore. Anything else
 * stays on screen wearing its code, which is what `kind: "command"` stickiness
 * used to buy and what this has to keep.
 */
export function finishJob(id: string, code: number | null): void {
  const job = jobs().find((j) => j.id === id);
  if (!job || job.state !== "running") return;
  const state = stateForCode(code);
  setJobs(jobs().map((j) => (j.id === id ? { ...j, state, code, endedAt: Date.now() } : j)));
  // After the state is recorded, so anything watching sees the outcome even
  // when the job is about to go.
  if (job.rediscoverOnExit) invoke("rediscover").catch(() => {});
  if (job.recheckAgentsOnExit) void refreshAgentHealth();
  if (state === "ok") forgetJob(id);
}

/** Drop a finished job by hand. Running jobs are not dismissable: the row is
 *  the only handle on a live process, and losing it would strand the process. */
export function dismissJob(id: string): void {
  if (jobs().find((j) => j.id === id)?.state === "running") return;
  forgetJob(id);
}

/**
 * The one way a job leaves the model.
 *
 * Every removal goes through here, the auto-clear on success included: the
 * clean exit is the common path, so wiring the stage-host cleanup to Dismiss
 * alone would leak an element on almost every job. Dropping the job unmounts
 * its `TerminalView` first, in that order, exactly as `closeId` does for a tab.
 */
function forgetJob(id: string): void {
  setJobs(jobs().filter((j) => j.id !== id));
  if (shownId() === id) setShownId(null);
  dropStageHost(id);
}

/** Test seam, mirroring `resetTerminalTabModel`. */
export function resetJobModel(): void {
  for (const j of jobs()) dropStageHost(j.id);
  setJobs([]);
  setShownId(null);
}
