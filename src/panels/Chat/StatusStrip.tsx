import { Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import { Ellipsis } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import SessionStats, { type SessionDetail } from "./SessionStats";
import type { ConnectionHealth } from "./chatStore";
import styles from "./Chat.module.css";

/**
 * The one-line session readout above the transcript: what the session is doing
 * right now, the files it has touched, and the session's own figures (model,
 * prompts, turns, tool calls, compactions, context) on the same component the
 * toolbar uses. Everything occasional - fork, send-to-new-chat, rules, what the
 * session loaded - lives behind the overflow menu on the right, so the strip
 * never grows into the wall of controls it replaced.
 *
 * **What it has spent is not here**, deliberately. The session token total used
 * to sit in this row and it was the same figure `UsageReadout` shows in the
 * menu, minus that one's cost, turn count and "counts only the turns this chat
 * watched finish" caveat - so the strip carried the version most likely to be
 * misread, on a resumed session where it undercounts. It also sat beside the
 * context figure, which is a different measurement entirely (the latest turn's
 * input against the window, not a sum over turns, and no output tokens), and
 * two token numbers side by side invite being read as one.
 *
 * The elapsed clock is presentational: it starts from the moment this panel saw
 * the turn begin, which is what "how long has it been working" means to the
 * person watching it.
 */
export default function StatusStrip(props: {
  health: ConnectionHealth;
  running: boolean;
  awaitingApproval: boolean;
  /** Distinct files this session's tool calls touched. */
  files: number;
  /** This session's figures, or null before the transcript has been read (a
   *  chat with no turns yet has no file to read them from). */
  detail: SessionDetail | null;
  /** The window the one resolver produced for the session's model, or null.
   *  Threaded through rather than resolved in the stats row, so this strip and
   *  the composer meter never disagree about the denominator. */
  contextWindow: number | null;
  /** Passed straight to the stats row, which shows the provider's mark beside
   *  the model and needs the adapter for ids that do not name a vendor. */
  agentId?: string;
  onReconnect: () => void;
  /** The overflow menu's contents; the strip owns only the open/close state. */
  menu: JSX.Element;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);
  let root: HTMLDivElement | undefined;
  let timer: number | undefined;

  createEffect(
    on(
      () => props.running,
      (running) => {
        window.clearInterval(timer);
        if (!running) return;
        const started = Date.now();
        setElapsed(0);
        timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
      },
    ),
  );
  onCleanup(() => window.clearInterval(timer));

  // The menu closes on any click outside the strip, the way every dropdown in
  // the app behaves; listening only while open keeps the document handler from
  // running for a menu nobody has touched.
  createEffect(() => {
    if (!menuOpen()) return;
    const onDoc = (e: MouseEvent) => {
      if (root?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    onCleanup(() => document.removeEventListener("mousedown", onDoc));
  });

  const label = () => {
    if (props.health === "disconnected") return "Disconnected";
    if (props.health === "connecting") return "Connecting";
    if (props.awaitingApproval) return "Waiting for approval";
    return props.running ? "Working" : "Idle";
  };

  const tone = () => {
    if (props.health === "disconnected") return styles.stripBad;
    if (props.awaitingApproval) return styles.stripAttention;
    if (props.running || props.health === "connecting") return styles.stripBusy;
    return styles.stripIdle;
  };

  const clock = () => {
    const s = elapsed();
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };

  return (
    <div class={styles.strip} ref={root}>
      <span class={`${styles.stripStatus} ${tone()}`}>
        <span class={styles.stripDot} aria-hidden="true" />
        {label()}
        <Show when={props.running}>
          <span class={styles.stripTime}>{clock()}</span>
        </Show>
      </span>
      <Show when={props.health === "disconnected"}>
        <Button size="xs" onClick={() => props.onReconnect()} title="Resume this session in a new process">
          Reconnect
        </Button>
      </Show>
      <Show when={props.files > 0}>
        <span class={styles.stripSep} aria-hidden="true" />
        <span class={styles.stripItem}>
          {props.files} file{props.files === 1 ? "" : "s"}
        </span>
      </Show>
      <Show when={props.detail}>
        {(d) => (
          <>
            <span class={styles.stripSep} aria-hidden="true" />
            <SessionStats detail={d()} contextWindow={props.contextWindow} agentId={props.agentId} />
          </>
        )}
      </Show>
      <div class={styles.stripSpacer} />
      <button
        type="button"
        class={styles.stripMenuButton}
        title="Session menu"
        aria-label="Session menu"
        aria-expanded={menuOpen()}
        onClick={() => setMenuOpen(!menuOpen())}
      >
        <Icon icon={Ellipsis} />
      </button>
      <Show when={menuOpen()}>
        <div class={styles.stripMenu}>{props.menu}</div>
      </Show>
    </div>
  );
}
