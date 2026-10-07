import { For, Show, type JSX } from "solid-js";
import { Anchor, ArrowUpRight, Sailboat } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import DecisionCard from "./DecisionCard";
import Horizon, { type SceneKey } from "./Horizon";
import {
  CaptainsCall,
  ComposerShell,
  ErrorBanner,
  KeyHints,
  SectionHead,
  StatusDot,
  Thread,
  TicketLink,
  TicketNumber,
  TicketPlace,
  decisionHandlers,
} from "./ShellParts";
import type {
  ActivityItem,
  AutopilotError,
  AutopilotState,
  CockpitHero,
  Decision,
  DecisionAction,
  QueuedItem,
  ThreadMessage,
  TicketHandlers,
  WorkerCard,
} from "./autopilot";
import styles from "./AutopilotView.module.css";
import { shortcut } from "../../utils/hotkeys";

export interface AutopilotViewProps extends TicketHandlers {
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
  onDecision?: (action: DecisionAction, decision: Decision) => void;
  onStart?: () => void;
  onStop?: () => void;
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
                    <TicketNumber ticket={w.ticket} onOpenLink={props.onOpenLink} />
                  </span>
                  <div class={styles.cardName}>
                    <span class={styles.cardTitle}>{w.title}</span>
                    <span class={styles.cardBranch}>
                      <TicketPlace ticket={w.ticket} onNavigate={props.onNavigate} />
                      {w.diff ? ` \u00b7 ${w.diff}` : ""}
                    </span>
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
                    disabled={!w.ticket.target}
                    onClick={() => w.ticket.target && props.onNavigate?.(w.ticket.target)}
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
                <span class={styles.cardRef}>
                  <TicketLink ticket={q.ticket} onOpenLink={props.onOpenLink} onNavigate={props.onNavigate} />
                </span>
                <span class={styles.queuedTitle}>{q.title}</span>
                <Show when={q.proposed}>
                  <span class={styles.queuedAfter}>proposed</span>
                </Show>
                <Show when={q.after}>
                  {(after) => (
                    <span class={styles.queuedAfter}>
                      after <TicketLink ticket={after()} onOpenLink={props.onOpenLink} onNavigate={props.onNavigate} />
                    </span>
                  )}
                </Show>
              </div>
            )}
          </For>
        </Show>
      </aside>

      <section class={styles.center} aria-label="Conversation">
        <Hero {...props.hero} state={props.state} scene={props.scene} onStart={props.onStart} onStop={props.onStop} />
        <div class={styles.column} data-live={props.chat ? "true" : "false"}>
          <div class={styles.scroll}>
            <Show when={!props.chat} fallback={banners()}>
              <Thread messages={props.messages}>{banners()}</Thread>
            </Show>
          </div>
          <Show
            when={props.chat}
            fallback={
              <ComposerShell
                disabled={off() || props.state === "error"}
                placeholder={
                  off()
                    ? "Set sail to message the autopilot"
                    : props.state === "error"
                      ? "Reconnecting..."
                      : "Tell the autopilot..."
                }
                hints={
                  <KeyHints
                    hints={
                      props.decisions.length
                        ? [
                            [[shortcut("autopilot-view")], "workspace"],
                            [["J", "K"], "move"],
                            [["A"], "approve"],
                            [["R"], "reply"],
                          ]
                        : [[[shortcut("autopilot-view")], "workspace"]]
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
                <span class={styles.activityText}>
                  <Show when={a.ticket}>
                    {(ticket) => (
                      <>
                        <TicketLink
                          ticket={ticket()}
                          onOpenLink={props.onOpenLink}
                          onNavigate={props.onNavigate}
                        />{" "}
                      </>
                    )}
                  </Show>
                  {a.text}
                </span>
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
function Hero(
  props: CockpitHero & { state: AutopilotState; scene: SceneKey; onStart?: () => void; onStop?: () => void },
) {
  return (
    <header class={styles.hero} data-state={props.state}>
      <Horizon scene={props.scene} />
      <Show when={props.state === "error"}>
        <div class={styles.dim} />
      </Show>
      <div class={styles.heroRow}>
        <div class={styles.heroText}>
          <span class={styles.eyebrow}>
            <span class={styles.eyebrowDot} />
            {props.eyebrow}
          </span>
          <h1 class={styles.heroTitle}>{props.title}</h1>
          <p class={styles.heroBody}>{props.body}</p>
        </div>
        <Show
          when={props.state === "off"}
          fallback={
            <button type="button" class={styles.anchor} onClick={() => props.onStop?.()}>
              <Icon icon={Anchor} class={styles.helmIcon} />
              Drop anchor
            </button>
          }
        >
          <button type="button" class={styles.sail} onClick={() => props.onStart?.()}>
            <Icon icon={Sailboat} class={styles.helmIcon} />
            Set sail
          </button>
        </Show>
      </div>
    </header>
  );
}
