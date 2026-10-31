import { Show } from "solid-js";
import { Bot } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import styles from "./Chat.module.css";

export default function PromptFrom(props: { name: string; onOpen?: () => void }) {
  return (
    <span class={styles.promptFrom}>
      <Icon icon={Bot} size={12} />
      from{" "}
      <Show when={props.onOpen} fallback={<span class={styles.promptFromName}>{props.name}</span>}>
        {(open) => (
          <button type="button" class={`${styles.promptFromName} ${styles.promptFromLink}`} onClick={() => open()()}>
            {props.name}
          </button>
        )}
      </Show>
    </span>
  );
}
