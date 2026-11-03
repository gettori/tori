import { Show } from "solid-js";
import { Unlink } from "lucide-solid";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import PathBox from "./PathBox";
import { GLOBAL_NAME } from "../../utils/globalSpace";
import styles from "./Dialogs.module.css";

const listed = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export default function DetachConfirm(props: {
  name: string;
  path: string;
  sessions: number;
  leaves: string[];
  empties: string[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const forgets = () => {
    const parts = [
      props.sessions > 0 ? `its ${props.sessions} ${props.sessions === 1 ? "session closes" : "sessions close"}` : "",
      props.leaves.length > 0 ? `it leaves ${listed(props.leaves)}` : "",
    ].filter(Boolean);
    return parts.length ? `Tori forgets this folder: ${parts.join(" and ")}.` : "Tori forgets this folder.";
  };
  return (
    <Dialog
      open
      size="confirm"
      title={`Detach ${props.name}?`}
      description={GLOBAL_NAME}
      lead={<Icon icon={Unlink} />}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={props.busy} onClick={() => props.onConfirm()}>
            {props.busy ? "Detaching…" : "Detach"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <PathBox path={props.path} detail="And everything in it, including .git" fate="stays" />
        <p class={styles.detachText}>{forgets()} Attach it again any time.</p>
        <Show when={props.empties.length > 0}>
          <p class={styles.detachText}>
            {listed(props.empties)} {props.empties.length === 1 ? "has" : "have"} no other project, so{" "}
            {props.empties.length === 1 ? "it is" : "they are"} deleted with the detach.
          </p>
        </Show>
      </div>
    </Dialog>
  );
}
