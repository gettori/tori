import { For, Show, type JSX } from "solid-js";
import { Anchor, ArrowUpRight } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import DecisionCard from "./DecisionCard";
import Horizon, { type SceneKey } from "./Horizon";
import { CaptainsCall, ComposerShell, ErrorBanner, KeyHints, OffNotice, SectionHead, StatusDot, Thread, decisionHandlers, ref } from "./ShellParts";
import type {
  ActivityItem,
  AutopilotError,
  AutopilotState,
  CockpitHero,
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
  hero: CockpitHero;
  /** The time of day the banner shows. */
  scene: SceneKey;
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
      <Show when={props.decisions.length}>
        <CaptainsCall count={props.decisions.length} />
      </Show>
      <For each={props.decisions}>
        {(d, i) => <DecisionCard {...d} focused={i() === props.focused} {...decisionHandlers(d, props)} />}
      </For>
    </>
  );

  return (
    <div class={styles.view}>
      <aside class={styles.workers} aria-label="In flight">
        <SectionHead label="Crew on deck" count={props.workers.length} />
        <Show
          when={props.workers.length}
          fallback={
            <div class={styles.empty}>
              <span class={styles.emptyTitle}>Everyone's on shore leave</span>
              {props.emptyWorkers}
            </div>
          }
        >
          <For each={props.workers}>
            {(w) => (
              <article class={styles.card} data-status={w.status}>
                <div class={styles.cardHead}>
                  <span
                    class={styles.ring}
                    data-status={w.status}
                    style={w.status === "working" && w.progress != null ? { "--p": `${w.progress * 100}%` } : undefined}
                  >
                    {ref(w.refNumber)}
                  </span>
                  <div class={styles.cardName}>
                    <span class={styles.cardTitle}>{w.title}</span>
                    <span class={styles.cardBranch}>{w.diff ? `${w.branch} \u00b7 ${w.diff}` : w.branch}</span>
                  </div>
                </div>
                <Show when={w.contract}>
                  {(contract) => (
                    <details class={styles.contract}>
                      <summary>Contract</summary>
                      <p class={styles.contractText}>{contract()}</p>
                    </details>
                  )}
                </Show>
                <Show when={w.log.length}>
                  <div class={styles.log}>
                    <For each={w.log}>{(line) => <div class={styles.logLine}>{line}</div>}</For>
                  </div>
                </Show>
                <div class={styles.cardFoot}>
                  <span class={styles.doing} data-status={w.status}>
                    <StatusDot status={w.status} />
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
          <SectionHead label="Waiting at the dock" count={props.queue.length} />
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
        <Hero {...props.hero} state={props.state} scene={props.scene} />
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
        <SectionHead label="Ship's log" />
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
        <div class={styles.harbor}>
          <span class={styles.harborLabel}>
            <Icon icon={Anchor} class={styles.harborIcon} />
            Harbor
          </span>
          {props.shield}
        </div>
      </aside>
    </div>
  );
}

/** The time of day over the water: the banner, with the state on its first line. */
function Hero(props: CockpitHero & { state: AutopilotState; scene: SceneKey }) {
  return (
    <header class={styles.hero} data-state={props.state}>
      <Horizon scene={props.scene} />
      <Show when={props.state === "error"}>
        <div class={styles.dim} />
      </Show>
      <div class={styles.scrim} />
      <div class={styles.heroRow}>
        <div class={styles.heroText}>
          <span class={styles.eyebrow}>
            <span class={styles.eyebrowDot} />
            {props.eyebrow}
          </span>
          <h1 class={styles.heroTitle}>{props.title}</h1>
          <p class={styles.heroBody}>{props.body}</p>
        </div>
        <div class={styles.stats}>
          <For each={props.stats}>
            {(s) => (
              <div class={styles.stat}>
                <span class={styles.statLabel}>{s.label}</span>
                <span class={styles.statValue}>{s.value}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </header>
  );
}
