import { Show } from "solid-js";
import { fmtCost, fmtTokens, type UsageSummary } from "../../utils/chatUsage";
import styles from "./Chat.module.css";

/**
 * What the last turn cost and what the session has cost so far, in the status
 * strip's overflow menu.
 *
 * Two figures rather than one because they answer different questions and get
 * confused for each other constantly: the turn figure is "was that reply
 * expensive", the session figure is "how much have I spent in here". The
 * session one is a **sum of the turns this chat watched finish**, which is why
 * it carries its turn count - see `chatUsage.ts` for the measurement that says
 * it has to be summed rather than read off the newest frame.
 *
 * Renders nothing until a turn completes. A zero would be a claim, and before
 * the first `result` frame there is nothing to claim.
 */
export default function UsageReadout(props: { summary: UsageSummary }) {
  const turn = () => props.summary.turn;
  const session = () => props.summary.session;

  return (
    <Show when={turn()}>
      {(t) => (
        <span
          class={styles.menuNote}
          title={
            `Last turn: ${fmtTokens(t().tokens)} tokens` +
            (t().cost === null ? "" : `, ${fmtCost(t().cost!)}`) +
            `\nSession: ${fmtTokens(session().tokens)} tokens over ${session().turns} ` +
            `turn${session().turns === 1 ? "" : "s"}` +
            (session().cost === null ? "" : `, ${fmtCost(session().cost!)}`) +
            // Said only when it is true. The caveat used to be unconditional,
            // which meant a chat that started the session and watched every
            // turn of it still told the user its exact figure might be short -
            // training them to discount a number that was right.
            (props.summary.complete
              ? ""
              : `\nCounts only the turns this chat watched finish, so a resumed session's earlier turns are not included.`)
          }
        >
          {fmtTokens(t().tokens)} tok
          <Show when={t().cost !== null}> · {fmtCost(t().cost!)}</Show>
          <Show when={session().cost !== null}> · {fmtCost(session().cost!)} session</Show>
        </span>
      )}
    </Show>
  );
}
