import { Show } from "solid-js";
import Icon from "../../components/Icon/Icon";
import { providerIcon } from "../../components/Icon/ProviderIcon";
import { statusPresentation, type SessionStatus } from "../../utils/sessionStatus";
import type { StatusCertainty } from "../../utils/sessionDot";
import styles from "./TabMark.module.css";

/**
 * A session's leading glyph: whose agent it is, and what it is doing. Worn by
 * chat tabs, by PTY agent tabs, and by the History dropdown's rows.
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
 * **Certainty is the one thing the caller must not get wrong.** A chat states
 * its status outright through its own event stream; a PTY agent tab's is
 * composed from a pgrep probe, PTY quiet and a transcript tail, and is a good
 * guess rather than a measurement. Only the exact side is marked (see
 * `statusPresentation`), so an inferred tab renders exactly as it always has
 * and the marker means what it says wherever it appears.
 */
export default function TabMark(props: {
  /** The adapter driving this tab, for the provider mark itself. */
  agentId?: string;
  /** What the session is doing, or null for a tab with no live session behind
   *  it (closing, not yet registered, or an agent tab whose transcript has not
   *  appeared) - which renders the resting mark rather than nothing, so the
   *  strip does not twitch as a session starts. */
  status: SessionStatus | null;
  /** Measured or inferred. Defaults to inferred, which is both the safer
   *  default and the rendering every non-chat surface already had. */
  certainty?: StatusCertainty;
}) {
  const working = () => props.status === "executing";
  const needsYou = () => props.status === "waitingForApproval" || props.status === "budgetStopped";
  // The tooltip is the whole status vocabulary, spelled the way the sidebar and
  // the command palette spell it: one name per state across the app, with the
  // exact tier's "(measured)" suffix carried through by the same helper.
  const shown = () =>
    props.status && props.status !== "none"
      ? statusPresentation(props.status, props.certainty ?? "inferred")
      : null;

  return (
    <span
      class={styles.mark}
      classList={{
        [styles.working]: working(),
        [styles.needsYou]: needsYou(),
        [styles.exact]: shown()?.exact === true,
      }}
      title={shown()?.title}
      // Only the states worth interrupting a screen reader for. Idle is the
      // absence of news, and every tab announcing "Idle" would bury the one
      // that is asking for something.
      aria-label={working() || needsYou() ? shown()!.title : undefined}
    >
      <Icon icon={providerIcon(null, props.agentId)} size={13} />
      <Show when={needsYou()}>
        <span class={styles.badge} aria-hidden="true" />
      </Show>
    </span>
  );
}
