import { Show } from "solid-js";
import dialogs from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import ApprovalDraft from "../../panels/Chat/ApprovalDraft";
import { answering } from "../../panels/Chat/answering";
import { windowAsks, type SocketAsk } from "../../utils/socketAsks";

function Asked(props: { ask: SocketAsk }) {
  let reject: HTMLButtonElement | undefined;
  const { sending, send } = answering(() => props.ask.id);
  return (
    <Dialog
      open
      size="wide"
      title="A shell outside Tori asks"
      onClose={() => send("Reject")}
      initialFocus={() => reject}
      actions={
        <>
          <Button ref={reject} disabled={sending()} onClick={() => send("Reject")}>
            Reject
          </Button>
          <Button variant="primary" disabled={sending()} onClick={() => send("Approve")}>
            Approve
          </Button>
        </>
      }
    >
      <div class={dialogs.msg}>{props.ask.question}</div>
      <Show when={props.ask.approval}>{(approval) => <ApprovalDraft approval={approval()} />}</Show>
    </Dialog>
  );
}

// Keyed, so the next ask in line gets a dialog of its own once this one is answered.
export default function ApprovalDialog() {
  return (
    <Show when={windowAsks()[0]} keyed>
      {(ask) => <Asked ask={ask} />}
    </Show>
  );
}
