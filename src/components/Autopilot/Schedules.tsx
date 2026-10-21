import { For, Show } from "solid-js";
import Button from "../Button/Button";
import { SectionHead, TicketLink } from "./ShellParts";
import type { ScheduleCard, TicketHandlers } from "./autopilot";
import styles from "./Schedules.module.css";

export interface SchedulesProps extends TicketHandlers {
  schedules: ScheduleCard[];
  onResume?: (id: string) => void;
}

/** The cockpit's schedules: when each fires next, how its last run went, and
 *  Resume on one three failed runs paused. Adding and editing stay on the CLI. */
export default function Schedules(props: SchedulesProps) {
  return (
    <Show when={props.schedules.length}>
      <SectionHead label="Tide table" count={props.schedules.length} />
      <For each={props.schedules}>
        {(s) => (
          <div class={styles.row} data-paused={s.paused ? "true" : "false"}>
            <div class={styles.head}>
              <span class={styles.name}>{s.name}</span>
              <span class={styles.cron}>{s.cron}</span>
            </div>
            <span class={styles.what}>{s.what}</span>
            <div class={styles.foot}>
              <Show
                when={s.paused}
                fallback={
                  <span class={styles.when}>
                    <Show when={s.waitingOn} fallback={s.next ? `next ${s.next}` : ""}>
                      {(run) => (
                        <>
                          waiting on{" "}
                          <TicketLink ticket={run()} onOpenLink={props.onOpenLink} onNavigate={props.onNavigate} />
                        </>
                      )}
                    </Show>
                  </span>
                }
              >
                <span class={styles.paused}>paused after 3 failed runs</span>
                <Button size="xs" variant="ghost" onClick={() => props.onResume?.(s.id)}>
                  Resume
                </Button>
              </Show>
              <Show when={s.last}>
                <span class={styles.last}>last {s.last}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}
