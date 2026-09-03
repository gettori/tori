import { For, Show } from "solid-js";
import { X } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import { dismissJob, jobs, showJob, type Job } from "./jobStore";
import styles from "./Jobs.module.css";

const WORD: Record<Job["state"], string> = {
  running: "Running",
  ok: "Done",
  failed: "Failed",
};

/**
 * The tray: one row per job, above the sidebar's mode tabs.
 *
 * It exists because the drawer can be closed and a job can be displaced by a
 * newer one. Without a row, a job whose drawer went away would be running with
 * nothing on screen that says so and no way back to its output.
 */
export default function JobTray() {
  return (
    <Show when={jobs().length > 0}>
      <div class={styles.tray} role="list" aria-label="Jobs">
        <For each={jobs()}>
          {(job) => (
            <div class={styles.row} role="listitem">
              {/* No native tooltip attribute on a control, which is what the
                  interactiveTitle guard exists to keep out. A row truncated
                  here reads in full in the drawer head it opens. */}
              <button type="button" class={styles.rowOpen} onClick={() => showJob(job.id)}>
                <span class={styles.rowTitle}>{job.title}</span>
                <span class={`${styles.state} ${styles[job.state]}`}>{WORD[job.state]}</span>
              </button>
              {/* Only once it has exited. The row is the only handle on a live
                  process, so dropping it would strand one; stopping a running
                  job is a separate, destructive affordance. */}
              <Show when={job.state !== "running"}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Dismiss ${job.title}`}
                  tooltip="Dismiss"
                  icon={<Icon icon={X} />}
                  onClick={() => dismissJob(job.id)}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
