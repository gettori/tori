import { Show, onMount } from "solid-js";
import { Square, Volume2 } from "lucide-solid";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import { reading, reset, stop } from "../../utils/speech";
import styles from "./ReadingChip.module.css";

export default function ReadingChip() {
  // Speech is native and outlives a webview reload, which would come back
  // with no chip for what is still playing.
  onMount(() => void reset());
  return (
    <Show when={reading()}>
      <div class={styles.chip} role="status">
        <Icon icon={Volume2} />
        <span>Reading aloud</span>
        <IconButton size="xs" icon={<Icon icon={Square} />} tooltip="Stop reading" onClick={() => void stop()} />
      </div>
    </Show>
  );
}
