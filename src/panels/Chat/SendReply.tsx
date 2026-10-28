import { createSignal, Show } from "solid-js";
import Button from "../../components/Button/Button";
import { requestSend, type SessionTarget } from "../../utils/safeSend";
import { fromSide } from "./sideChats";
import styles from "./SideDrawer.module.css";

export default function SendReply(props: { target: SessionTarget; text: string }) {
  const [busy, setBusy] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [refusal, setRefusal] = createSignal<string | null>(null);
  async function send() {
    setBusy(true);
    setRefusal(null);
    const result = await requestSend({ ...props.target, text: fromSide(props.text), submit: true });
    setBusy(false);
    if (result.kind === "sent") setSent(true);
    else if (result.kind === "blocked") setRefusal(result.reason ?? "The chat could not take it, so nothing was sent.");
    else setRefusal("The chat did not answer, so nothing was sent.");
  }
  return (
    <div class={styles.sendReply}>
      <Button size="sm" disabled={busy() || sent()} onClick={() => void send()}>
        {sent() ? "Sent" : "Send to chat"}
      </Button>
      <Show when={refusal()}>
        {(reason) => (
          <span class={styles.sendNote} role="status">
            {reason()}
          </span>
        )}
      </Show>
    </div>
  );
}
