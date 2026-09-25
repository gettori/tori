import { For, Show, createSignal, type JSX } from "solid-js";
import { ArrowUp, Bell, TriangleAlert } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import { WheelGlyph } from "./Wheel";
import type { Decision, DecisionAction, ThreadMessage, TicketHandlers, TicketRef, WorkerStatus } from "./autopilot";
import styles from "./ShellParts.module.css";

// Pieces the popup and the Autopilot view both draw.

/** A ticket's number, a link to its page on the forge when there is one. */
export function TicketNumber(props: { ticket: TicketRef; prefix?: string } & TicketHandlers) {
  const text = () => `${props.prefix ?? ""}${props.ticket.label}`;
  return (
    <Show when={props.ticket.url} fallback={<span>{text()}</span>}>
      {(url) => (
        <a
          class={styles.ticketLink}
          href={url()}
          onClick={(e) => {
            e.preventDefault();
            props.onOpenLink?.(url());
          }}
        >
          {text()}
        </a>
      )}
    </Show>
  );
}

/** Where a ticket is worked on, `personal -> tori -> y-test`, opening it in Tori. */
export function TicketPlace(props: { ticket: TicketRef } & TicketHandlers) {
  const text = () => props.ticket.place.join(" -> ");
  return (
    <Show when={props.ticket.target} fallback={<span>{text()}</span>}>
      {(target) => (
        <button type="button" class={styles.placeLink} onClick={() => props.onNavigate?.(target())}>
          {text()}
        </button>
      )}
    </Show>
  );
}

/** `#212 (personal -> tori -> y-test)`. */
export function TicketLink(props: { ticket: TicketRef; prefix?: string } & TicketHandlers) {
  return (
    <span>
      <TicketNumber {...props} />
      <Show when={props.ticket.place.length}>
        {" ("}
        <TicketPlace {...props} />
        {")"}
      </Show>
    </span>
  );
}

/** A decision card's buttons, routed to one handler with the decision attached. */
export function decisionHandlers(
  d: Decision,
  on: { onDecision?: (action: DecisionAction, decision: Decision) => void } & TicketHandlers,
) {
  return {
    onApprove: () => on.onDecision?.("approve", d),
    onEdit: () => on.onDecision?.("edit", d),
    onReply: () => on.onDecision?.("reply", d),
    onDismiss: () => on.onDecision?.("dismiss", d),
    onOpenWorker: () => d.ticket?.target && on.onNavigate?.(d.ticket.target),
    onOpenLink: on.onOpenLink,
    onNavigate: on.onNavigate,
  };
}

export function StatusDot(props: { status: WorkerStatus }) {
  return <span class={styles.dot} data-status={props.status} aria-hidden="true" />;
}

/** The autopilot's face beside each thing it says. */
export function ReplyMark() {
  return (
    <span class={styles.replyMark} aria-hidden="true">
      <WheelGlyph class={styles.replyGlyph} />
    </span>
  );
}

/** The heading over what waits on the user. */
export function CaptainsCall(props: { count: number }) {
  return (
    <div class={styles.call}>
      <Icon icon={Bell} class={styles.callIcon} />
      Captain's call
      <span class={styles.callCount}>{props.count}</span>
    </div>
  );
}

export function SectionHead(props: { label: string; count?: number; children?: JSX.Element }) {
  return (
    <div class={styles.sectionHead}>
      <span class={styles.sectionLabel}>{props.label}</span>
      <Show when={props.count != null}>
        <span class={styles.sectionCount}>{props.count}</span>
      </Show>
      {props.children}
    </div>
  );
}

/** Keys and what they do, e.g. [["J", "K"], "move"]. */
export function KeyHints(props: { hints: [string[], string][] }) {
  return (
    <span class={styles.keyHints}>
      <For each={props.hints}>
        {([keys, what]) => (
          <span class={styles.keyHint}>
            <For each={keys}>{(k) => <kbd class={styles.kbd}>{k}</kbd>}</For>
            {what}
          </span>
        )}
      </For>
    </span>
  );
}

/** The autopilot conversation. `dense` is the popup's smaller type; `reply`
 *  draws what the autopilot says, plain text when absent. */
export function Thread(props: {
  messages: ThreadMessage[];
  dense?: boolean;
  reply?: (text: string) => JSX.Element;
  children?: JSX.Element;
}) {
  return (
    <div class={styles.thread} data-dense={props.dense ? "true" : "false"}>
      <For each={props.messages}>
        {(m) => (
          <Show
            when={m.from === "system"}
            fallback={
              <Show when={m.from === "me"} fallback={
                <div class={styles.theirs}>
                  <Show when={!props.dense}>
                    <ReplyMark />
                  </Show>
                  <span>{props.reply ? props.reply(m.text) : m.text}</span>
                </div>
              }>
                <div class={styles.mine}>{m.text}</div>
              </Show>
            }
          >
            <div class={styles.system}>
              <span class={styles.systemRule} />
              {m.text}
            </div>
          </Show>
        )}
      </For>
      {props.children}
    </div>
  );
}

/** The popup's one-line composer: Enter sends and clears. */
export function Composer(props: { placeholder: string; disabled?: boolean; dense?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = createSignal("");
  const send = () => {
    const t = text().trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText("");
  };
  return (
    <div class={styles.composer} data-disabled={props.disabled ? "true" : "false"} data-dense={props.dense ? "true" : "false"}>
      <div class={styles.composerField}>
        <input
          class={styles.input}
          value={text()}
          placeholder={props.placeholder}
          disabled={props.disabled}
          aria-label={props.placeholder}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
      <button type="button" class={styles.send} aria-label="Send" disabled={props.disabled || !text().trim()} onClick={send}>
        <Icon icon={ArrowUp} class={styles.sendIcon} />
      </button>
    </div>
  );
}

/** A picture of the composer: the real one is the Chat panel's, wired in #205. */
export function ComposerShell(props: { placeholder: string; disabled?: boolean; hints?: JSX.Element; dense?: boolean }) {
  return (
    <div class={styles.composer} data-disabled={props.disabled ? "true" : "false"} data-dense={props.dense ? "true" : "false"}>
      <div class={styles.composerField}>
        <span class={styles.placeholder}>{props.placeholder}</span>
        <Show when={props.hints}>
          <span class={styles.composerHints}>{props.hints}</span>
        </Show>
      </div>
      <span class={styles.send} aria-hidden="true">
        <Icon icon={ArrowUp} class={styles.sendIcon} />
      </span>
    </div>
  );
}

export function OffNotice(props: { body: string; action: string; onStart?: () => void }) {
  return (
    <div class={styles.off}>
      <span class={styles.offTitle}>The autopilot is off</span>
      <span class={styles.offBody}>{props.body}</span>
      <Button variant="primary" size="sm" onClick={() => props.onStart?.()}>
        {props.action}
      </Button>
    </div>
  );
}

/** Stays until the user acts on it; an exit is never a toast. */
export function ErrorBanner(props: {
  /** What happened, e.g. "Autopilot session exited (signal 9)". */
  title: string;
  /** What Tori is doing about it, e.g. "Restarting, attempt 2 of 3". */
  detail: string;
  /** The popup offers it; the view has the switch's own button beside it. */
  turnOff?: boolean;
  onRestart?: () => void;
  onViewLog?: () => void;
  onTurnOff?: () => void;
}) {
  return (
    <div class={styles.error} role="alert">
      <div class={styles.errorTitle}>
        <Icon icon={TriangleAlert} class={styles.errorIcon} />
        {props.title}
      </div>
      <div class={styles.errorBody}>{props.detail}</div>
      <div class={styles.errorActions}>
        <Button size="sm" onClick={() => props.onRestart?.()}>
          Restart now
        </Button>
        <Show when={props.onViewLog}>
          {(onViewLog) => (
            <Button size="sm" variant="ghost" onClick={() => onViewLog()()}>
              View log
            </Button>
          )}
        </Show>
        <Show when={props.turnOff}>
          <Button size="sm" variant="ghost" onClick={() => props.onTurnOff?.()}>
            Turn off
          </Button>
        </Show>
      </div>
    </div>
  );
}
