import { For, Show, type JSX } from "solid-js";
import { ArrowUpRight, ShieldCheck } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import DecisionCard from "./DecisionCard";
import { ComposerShell, ErrorBanner, KeyHints, OffNotice, SectionHead, StatusDot, Thread, decisionHandlers, ref } from "./ShellParts";
import type {
  ActivityItem,
  AutopilotError,
  AutopilotState,
  Decision,
  DecisionAction,
  QueuedItem,
  Ref,
  ThreadMessage,
  WorkerCard,
} from "./autopilot";
import styles from "./AutopilotView.module.css";

export interface AutopilotViewProps {
  state: AutopilotState;
  workers: WorkerCard[];
  /** Shown in place of the cards when nothing is in flight. */
  emptyWorkers: string;
  queue: QueuedItem[];
  messages: ThreadMessage[];
  /** Pending decisions, drawn at the end of the thread. */
  decisions: Decision[];
  focused?: number;
  activity: ActivityItem[];
  /** The footer's promise about what has left the machine. */
  shield: string;
  /** Shown in the error state. */
  error?: AutopilotError;
  onWatch?: (refNumber: Ref) => void;
  onOpenWorker?: (refNumber: Ref) => void;
  onDecision?: (action: DecisionAction, decision: Decision) => void;
  onStart?: () => void;
  onRestart?: () => void;
  onViewLog?: () => void;
  /** The live conversation, in place of the drawn thread and composer. */
  chat?: JSX.Element;
}

/** The full window Autopilot view: what is in flight on the left, the
 *  conversation in the middle, what happened on the right. Static: it draws
 *  what it is handed and owns no state. The title bar above it is the host's. */
export default function AutopilotView(props: AutopilotViewProps) {
  const off = () => props.state === "off";
  const banners = () => (
    <>
      <Show when={props.state === "error" && props.error}>
        {(error) => <ErrorBanner {...error()} onRestart={props.onRestart} onViewLog={props.onViewLog} />}
      </Show>
      <For each={props.decisions}>
        {(d, i) => <DecisionCard {...d} focused={i() === props.focused} {...decisionHandlers(d, props)} />}
      </For>
    </>
  );

  return (
    <div class={styles.view}>
      <aside class={styles.workers} aria-label="In flight">
        <SectionHead label="In flight" count={props.workers.length} />
        <Show when={props.workers.length} fallback={<div class={styles.empty}>{props.emptyWorkers}</div>}>
          <For each={props.workers}>
            {(w) => (
              <article class={styles.card} data-status={w.status}>
                <div class={styles.cardHead}>
                  <StatusDot status={w.status} />
                  <span class={styles.cardRef}>{ref(w.refNumber)}</span>
                  <span class={styles.cardTitle}>{w.title}</span>
                </div>
                <span class={styles.cardBranch}>
                  {w.diff ? `${w.branch}, ${w.diff}` : w.branch}
                </span>
                <Show when={w.contract}>
                  {(contract) => (
                    <details class={styles.contract}>
                      <summary>Contract</summary>
                      <p class={styles.contractText}>{contract()}</p>
                    </details>
                  )}
                </Show>
                <div class={styles.log}>
                  <For each={w.log}>{(line) => <div class={styles.logLine}>{line}</div>}</For>
                </div>
                <div class={styles.cardFoot}>
                  <span class={styles.doing} data-status={w.status}>
                    {w.doing}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    iconRight={<Icon icon={ArrowUpRight} class={styles.watchIcon} />}
                    onClick={() => props.onWatch?.(w.refNumber)}
                  >
                    Watch
                  </Button>
                </div>
                <Show when={w.progress != null}>
                  <span class={styles.progress} style={{ "--card-fill": String(w.progress) }} />
                </Show>
              </article>
            )}
          </For>
        </Show>
        <Show when={props.queue.length}>
          <SectionHead label="Queued" count={props.queue.length} />
          <For each={props.queue}>
            {(q) => (
              <div class={styles.queued}>
                <span class={styles.cardRef}>{ref(q.refNumber)}</span>
                <span class={styles.queuedTitle}>{q.title}</span>
                <Show when={q.after !== undefined}>
                  <span class={styles.queuedAfter}>after {ref(q.after!)}</span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </aside>

      <section class={styles.center} aria-label="Conversation">
        <div class={styles.column} data-live={props.chat ? "true" : "false"}>
          <div class={styles.scroll}>
            <Show when={off()}>
              <OffNotice
                body="Workers it started are normal sessions now. Start it again to hand it tickets and PRs. It asks before anything leaves this machine."
                action="Start autopilot"
                onStart={props.onStart}
              />
            </Show>
            <Show when={!props.chat} fallback={banners()}>
              <Thread messages={props.messages}>{banners()}</Thread>
            </Show>
          </div>
          <Show
            when={props.chat}
            fallback={
              <ComposerShell
                disabled={off() || props.state === "error"}
                placeholder={off() ? "Start the autopilot to message it" : props.state === "error" ? "Reconnecting..." : "Tell the autopilot..."}
                hints={
                  <KeyHints
                    hints={
                      props.decisions.length
                        ? [[["\u2318\u21e7J"], "workspace"], [["J", "K"], "move"], [["A"], "approve"], [["R"], "reply"]]
                        : [[["\u2318\u21e7J"], "workspace"]]
                    }
                  />
                }
              />
            }
          >
            <div class={styles.chat}>{props.chat}</div>
          </Show>
        </div>
      </section>

      <aside class={styles.activity} aria-label="Activity">
        <SectionHead label="Activity" />
        <div class={styles.activityList}>
          <For each={props.activity}>
            {(a) => (
              <div class={styles.activityRow} data-needs-you={a.needsYou ? "true" : "false"}>
                <span class={styles.activityTime}>{a.time}</span>
                <span class={styles.activityText}>{a.text}</span>
              </div>
            )}
          </For>
        </div>
        <div class={styles.shield}>
          <Icon icon={ShieldCheck} class={styles.shieldIcon} />
          {props.shield}
        </div>
      </aside>
    </div>
  );
}
