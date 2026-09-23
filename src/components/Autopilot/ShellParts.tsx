import { For, Show, type JSX } from "solid-js";
import { ArrowUp, TriangleAlert } from "lucide-solid";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import type { Decision, DecisionAction, ThreadMessage, WorkerStatus } from "./autopilot";
import styles from "./ShellParts.module.css";

// Pieces the popup and the Autopilot view both draw.

export const ref = (n: number) => `#${n}`;

/** A decision card's buttons, routed to one handler with the decision attached. */
export function decisionHandlers(
  d: Decision,
  on: {
    onDecision?: (action: DecisionAction, decision: Decision) => void;
    onOpenWorker?: (refNumber: number) => void;
  },
) {
  return {
    onApprove: () => on.onDecision?.("approve", d),
    onEdit: () => on.onDecision?.("edit", d),
    onReply: () => on.onDecision?.("reply", d),
    onDismiss: () => on.onDecision?.("dismiss", d),
    onOpenWorker: () => on.onOpenWorker?.(d.refNumber),
  };
}

export function StatusDot(props: { status: WorkerStatus }) {
  return <span class={styles.dot} data-status={props.status} aria-hidden="true" />;
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

/** The autopilot conversation. `dense` is the popup's smaller type. */
export function Thread(props: { messages: ThreadMessage[]; dense?: boolean; children?: JSX.Element }) {
  return (
    <div class={styles.thread} data-dense={props.dense ? "true" : "false"}>
      <For each={props.messages}>
        {(m) => (
          <Show
            when={m.from === "system"}
            fallback={
              <div class={m.from === "me" ? styles.mine : styles.theirs}>{m.text}</div>
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
        <Button size="sm" variant="ghost" onClick={() => props.onViewLog?.()}>
          View log
        </Button>
        <Show when={props.turnOff}>
          <Button size="sm" variant="ghost" onClick={() => props.onTurnOff?.()}>
            Turn off
          </Button>
        </Show>
      </div>
    </div>
  );
}
