import { createEffect, For, Show } from "solid-js";
import Button from "../../components/Button/Button";
import ApprovalDraft from "../Chat/ApprovalDraft";
import { answering } from "../Chat/answering";
import { asksForTab, type SocketAsk } from "../../utils/socketAsks";
import styles from "./Terminal.module.css";

function TabApproval(props: { ask: SocketAsk; active: boolean }) {
  let reject: HTMLButtonElement | undefined;
  const { sending, send } = answering(() => props.ask.id);
  // Only on a shown tab: a hidden one taking focus would pull it out of whatever has it.
  createEffect(() => props.active && reject?.focus());
  return (
    <div class={styles.tabApproval} role="alertdialog" aria-label={props.ask.question}>
      <span class={styles.termRestoreText}>This tab asks: {props.ask.question}</span>
      <Show when={props.ask.approval}>{(approval) => <ApprovalDraft approval={approval()} />}</Show>
      <div class={styles.tabApprovalActions}>
        <Button ref={reject} size="sm" variant="primary" disabled={sending()} onClick={() => send("Reject")}>
          Reject
        </Button>
        <Button size="sm" disabled={sending()} onClick={() => send("Approve")}>
          Approve
        </Button>
      </div>
    </div>
  );
}

export default function TabApprovals(props: { tab: string; active: boolean }) {
  return (
    <Show when={asksForTab(props.tab).length}>
      <div class={styles.tabApprovals}>
        <For each={asksForTab(props.tab)}>{(ask) => <TabApproval ask={ask} active={props.active} />}</For>
      </div>
    </Show>
  );
}
