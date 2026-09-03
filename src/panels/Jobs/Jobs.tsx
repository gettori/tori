import { For, onCleanup, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView, { type PtyExit } from "../Terminal/TerminalView";
import { stageHost } from "../../tabs/stageHost";
import { OPEN_JOB, onWith, type OpenJob } from "../../utils/events";
import JobDrawer from "./JobDrawer";
import { finishJob, jobs, shownJob, startJob } from "./jobStore";

/**
 * The Jobs host: listeners, surfaces, drawer.
 *
 * A service component like the terminal panel. Every job's `TerminalView` is
 * mounted here for as long as the job exists and portalled into its own stage
 * host, so which job the drawer shows is a question of adoption rather than of
 * mounting. Two jobs at once is normal; only one is on screen.
 */
export default function Jobs() {
  let offOpenJob: (() => void) | undefined;
  let unlistenExit: UnlistenFn | undefined;

  onMount(async () => {
    offOpenJob = onWith<OpenJob>(OPEN_JOB, startJob);
    // The same event every terminal tab listens to. An id this store does not
    // know is a tab's, and `finishJob` ignores it.
    unlistenExit = await listen<PtyExit>("pty://exit", (e) =>
      finishJob(e.payload.id, e.payload.code),
    );
  });

  onCleanup(() => {
    offOpenJob?.();
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
                // Spawns the program directly rather than through a login
                // shell, which keeps the output readable after a failing exit.
                kind="command"
                program={job.program}
                args={job.args}
                env={job.env}
                active={shownJob()?.id === id}
                autoFocus={!!job.interactive}
              />
            </Portal>
          );
        }}
      </For>
      <JobDrawer />
    </>
  );
}
