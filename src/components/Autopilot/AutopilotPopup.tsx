import { For, Show, type JSX } from "solid-js";
import { ArrowUpRight, SquareArrowOutUpRight } from "lucide-solid";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import DecisionCard from "./DecisionCard";
import Wheel from "./Wheel";
import {
  ComposerShell,
  ErrorBanner,
  KeyHints,
  OffNotice,
  SectionHead,
  StatusDot,
  Thread,
  TicketNumber,
  decisionHandlers,
} from "./ShellParts";
import type {
  AutopilotError,
  AutopilotState,
  Decision,
  DecisionAction,
  InFlightRow,
  ThreadMessage,
  TicketHandlers,
} from "./autopilot";
import styles from "./AutopilotPopup.module.css";

export interface AutopilotPopupProps extends TicketHandlers {
  state: AutopilotState;
  /** One line under the title, e.g. "Working on 2, 2 decisions". */
  stateLine: string;
  decisions: Decision[];
  /** Index into `decisions` of the one J/K has selected. */
  focused?: number;
  inFlight: InFlightRow[];
  messages: ThreadMessage[];
  /** Draws the autopilot's replies, so its links work; plain text when absent. */
  renderReply?: (text: string) => JSX.Element;
  /** Shown in the error state. */
  error?: AutopilotError;
  onOpenView?: () => void;
  onDecision?: (action: DecisionAction, decision: Decision) => void;
  onStart?: () => void;
  onRestart?: () => void;
  onViewLog?: () => void;
  onTurnOff?: () => void;
  /** A live input, in place of the drawn composer. */
  composer?: JSX.Element;
}

/** The autopilot summoned over Workspace: what needs you, what is running,
 *  and the conversation, without leaving the pane in front of you. Static:
 *  it draws what it is handed and owns no state. */
export default function AutopilotPopup(props: AutopilotPopupProps) {
  const off = () => props.state === "off";
  const muted = () => off() || props.state === "error";

  return (
    <section class={styles.popup} aria-label="Autopilot">
      <header class={styles.head}>
        <span class={styles.tile}>
          <Wheel state={props.state} count={props.decisions.length} size={16} />
        </span>
        <div class={styles.titles}>
          <span class={styles.title}>Autopilot</span>
          <span class={styles.stateLine} data-state={props.state}>
            {props.stateLine}
          </span>
        </div>
        <kbd class={styles.kbd}>{"\u2318L"}</kbd>
        <IconButton
          size="md"
          icon={<Icon icon={SquareArrowOutUpRight} />}
          tooltip="Open autopilot view"
          onClick={() => props.onOpenView?.()}
        />
      </header>

      <div class={styles.body}>
        <Show when={off()}>
          <OffNotice
            body="Workers it started keep running as normal sessions. Turn it on to hand it tickets and PRs again."
            action="Turn on"
            onStart={props.onStart}
          />
        </Show>
        <Show when={props.state === "error" && props.error}>
          {(error) => (
            <ErrorBanner
              {...error()}
              turnOff
              onRestart={props.onRestart}
              onViewLog={props.onViewLog}
              onTurnOff={props.onTurnOff}
            />
          )}
        </Show>

        <Show when={props.decisions.length}>
          <div class={styles.section}>
            <SectionHead label="Decisions" count={props.decisions.length}>
              <KeyHints
                hints={[
                  [["J", "K"], "move"],
                  [["A"], "approve"],
                  [["R"], "reply"],
                ]}
              />
            </SectionHead>
            <For each={props.decisions}>
              {(d, i) => <DecisionCard {...d} focused={i() === props.focused} {...decisionHandlers(d, props)} />}
            </For>
          </div>
        </Show>

        <Show when={props.inFlight.length}>
          <div class={styles.inFlight}>
            <SectionHead label="In flight" count={props.inFlight.length} />
            <For each={props.inFlight}>
              {(r) => (
                // A link cannot sit inside a button, so the number stands beside it.
                <div class={styles.row}>
                  <StatusDot status={r.status} />
                  <span class={styles.rowRef}>
                    <TicketNumber ticket={r.ticket} onOpenLink={props.onOpenLink} />
                  </span>
                  <button
                    type="button"
                    class={styles.rowOpen}
                    disabled={!r.ticket.target}
                    onClick={() => r.ticket.target && props.onNavigate?.(r.ticket.target)}
                  >
                    <span class={styles.rowBranch}>{r.ticket.place.join(" -> ")}</span>
                    <span class={styles.rowDoing}>{r.doing}</span>
                    <Icon icon={ArrowUpRight} class={styles.rowGo} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={props.messages.length}>
          <Thread messages={props.messages} dense reply={props.renderReply} />
        </Show>
      </div>

      <footer class={styles.foot}>
        <Show
          when={props.composer}
          fallback={
            <ComposerShell
              dense
              disabled={muted()}
              placeholder={
                off()
                  ? "Start the autopilot to message it"
                  : props.state === "error"
                    ? "Reconnecting..."
                    : "Tell the autopilot..."
              }
            />
          }
        >
          {props.composer}
        </Show>
      </footer>
    </section>
  );
}
