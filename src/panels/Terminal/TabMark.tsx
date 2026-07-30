import { Show } from "solid-js";
import Icon from "../../components/Icon/Icon";
import { providerIcon } from "../../components/Icon/ProviderIcon";
import { STATUS_LABEL, type SessionStatus } from "../../utils/sessionStatus";
import styles from "./TabMark.module.css";

/**
 * A chat tab's leading glyph: whose agent it is, and what it is doing.
 *
 * **One glyph position, not one glyph per state.** The mark keeps its shape as
 * a session goes from idle to working and back, because a shape change in a
 * dense tab strip reads as movement and pulls the eye to a tab that merely went
 * quiet. Working is ambient - you do not act on it, you just want to know
 * something is alive - so it is carried by tint and a slow pulse.
 *
 * **Except for the one state that is a request.** Waiting for approval (and a
 * budget stop, which blocks the same way) is not a status, it is a question
 * with your name on it, so it gets the badge: a shape difference that survives
 * colourblindness, a glanced-at strip and a greyscale screenshot. It also stops
 * pulsing, because nothing is running.
 *
 * The status is only ever the chat tier's, which the session's own event stream
 * states outright. Nothing here is inferred from a probe.
 */
export default function TabMark(props: {
  /** The adapter driving this tab, for the provider mark itself. */
  agentId?: string;
  /** What the session is doing, or null for a tab with no live chat behind it
   *  (closing, or not yet registered) - which renders the resting mark rather
   *  than nothing, so the strip does not twitch as a session starts. */
  status: SessionStatus | null;
}) {
  const working = () => props.status === "executing";
  const needsYou = () => props.status === "waitingForApproval" || props.status === "budgetStopped";
  // The tooltip is the whole status vocabulary, spelled the way the sidebar and
  // the command palette spell it: one name per state across the app.
  const label = () => (props.status && props.status !== "none" ? STATUS_LABEL[props.status] : null);

  return (
    <span
      class={styles.mark}
      classList={{ [styles.working]: working(), [styles.needsYou]: needsYou() }}
      title={label() ?? undefined}
      // Only the states worth interrupting a screen reader for. Idle is the
      // absence of news, and every tab announcing "Idle" would bury the one
      // that is asking for something.
      aria-label={working() || needsYou() ? label()! : undefined}
    >
      <Icon icon={providerIcon(null, props.agentId)} size={13} />
      <Show when={needsYou()}>
        <span class={styles.badge} aria-hidden="true" />
      </Show>
    </span>
  );
}
