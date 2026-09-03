import { createEffect, Show } from "solid-js";
import { X } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import { emit, REFIT_PANES } from "../../utils/events";
import { stageHost } from "../../tabs/stageHost";
import { hideDrawer, shownJob } from "./jobStore";
import styles from "./Jobs.module.css";

/** What the head says a job is doing, code included once there is one. */
function outcome(state: string, code: number | null | undefined): string {
  if (state === "running") return "Running";
  if (state === "ok") return "Done";
  return code == null ? "Failed (no exit status)" : `Failed (exit ${code})`;
}

/**
 * The job surface: one job's output, over the workspace, at the bottom.
 *
 * The element is always mounted and hidden with a class, never wrapped in a
 * `Show`. `TerminalView`'s cleanup calls `pty_kill`, so a mount gate here would
 * be a destroy gate ([[lesson_a_mount_gate_is_a_destroy_gate]]): closing the
 * drawer would end the clone it was reporting on.
 */
export default function JobDrawer() {
  let body!: HTMLDivElement;

  // Adopt the shown job's stage host, the way PaneView adopts a tab's. The
  // surface moves; it is never rebuilt, so scrollback and the process survive.
  // Displaced hosts stay put: an inactive `TerminalView` hides itself.
  createEffect(() => {
    const job = shownJob();
    if (!job) return;
    const el = stageHost(job.id);
    if (el.parentElement === body) return;
    body.appendChild(el);
    // After layout, not in it: an adopted xterm measures its new box on
    // REFIT_PANES, and mid-flush the box has no size yet.
    requestAnimationFrame(() => emit(REFIT_PANES));
  });

  return (
    <div
      class={styles.drawer}
      classList={{ [styles.hidden]: !shownJob() }}
      role="region"
      aria-label="Job output"
      aria-hidden={shownJob() ? undefined : "true"}
    >
      <div class={styles.drawerHead}>
        <span class={styles.drawerTitle}>{shownJob()?.title}</span>
        <Show when={shownJob()}>
          {(job) => (
            <span class={`${styles.state} ${styles[job().state]}`}>
              {outcome(job().state, job().code)}
            </span>
          )}
        </Show>
        <Button
          variant="ghost"
          size="md"
          aria-label="Close job output"
          tooltip="Close"
          icon={<Icon icon={X} />}
          onClick={hideDrawer}
        />
      </div>
      <div class={styles.drawerBody} ref={body} />
    </div>
  );
}
