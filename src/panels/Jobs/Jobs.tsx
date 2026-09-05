import { For, onCleanup, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView, { type PtyExit } from "../Terminal/TerminalView";
import { stageHost } from "../../tabs/stageHost";
import { emit, emitWith, REVEAL_SIDEBAR, TOAST, type ToastEvent } from "../../utils/events";
import JobDrawer from "./JobDrawer";
import { finishJob, jobs, showJob, shownJob, type Job } from "./jobStore";

/**
 * Say what happened, wherever the user is looking.
 *
 * The drawer can be closed and the tray lives in a sidebar that can be hidden,
 * so a job can finish with nothing on screen that says so. Only a failure
 * carries the action: a clean job has already cleared itself, and there would
 * be nothing left for Show to reveal.
 */
function announce(job: Job) {
  const failed = job.state === "failed";
  const status = job.code == null ? "no exit status" : `exit ${job.code}`;
  emitWith<ToastEvent>(TOAST, {
    message: failed ? `${job.title} failed (${status})` : `${job.title} finished`,
    kind: failed ? "error" : "info",
    ...(failed
      ? {
          action: {
            label: "Show",
            run: () => {
              emit(REVEAL_SIDEBAR);
              showJob(job.id);
            },
          },
        }
      : {}),
  });
}

/**
 * The Jobs host: listeners, surfaces, drawer. Nothing routes here any more:
 * `OPEN_JOB` opens a command tab in the Shells workspace now, and phase 5 of
 * the standalone-terminals plan deletes all of this.
 *
 * A service component like the terminal panel. Every job's `TerminalView` is
 * mounted here for as long as the job exists and portalled into its own stage
 * host, so which job the drawer shows is a question of adoption rather than of
 * mounting. Two jobs at once is normal; only one is on screen.
 */
export default function Jobs() {
  let unlistenExit: UnlistenFn | undefined;

  onMount(async () => {
    // The same event every terminal tab listens to. An id this store does not
    // know is a tab's, and `finishJob` ignores it.
    unlistenExit = await listen<PtyExit>("pty://exit", (e) => {
      const done = finishJob(e.payload.id, e.payload.code);
      if (done) announce(done);
    });
  });

  onCleanup(() => {
    unlistenExit?.();
  });

  return (
    <>
      {/* Over ids, not over jobs. `For` diffs by reference, and recording an
          exit replaces the job object, so iterating the list itself would tear
          down and rebuild the surface at exactly the moment its output matters
          most. A string id is stable across every state change. */}
      <For each={jobs().map((j) => j.id)}>
        {(id) => {
          // Read once, untracked: a job's spawn arguments never change, and
          // subscribing to the list here would put the identity churn back.
          const job = untrack(() => jobs().find((j) => j.id === id))!;
          return (
            <Portal mount={stageHost(id)}>
              <TerminalView
                id={id}
                cwd={job.cwd}
                // A login shell running the command through a runner, so the
                // shell survives the command and reports how it went here.
                // `pty://exit` below still covers the shell itself ending.
                kind="command"
                program={job.program}
                args={job.args}
                env={job.env}
                active={shownJob()?.id === id}
                autoFocus={!!job.interactive}
                onCommandExit={(code) => {
                  const done = finishJob(id, code);
                  if (done) announce(done);
                }}
              />
            </Portal>
          );
        }}
      </For>
      <JobDrawer />
    </>
  );
}
