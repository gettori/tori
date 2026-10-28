import { Show, onMount } from "solid-js";
import { Square, Volume2 } from "lucide-solid";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import Tooltip from "../Tooltip/Tooltip";
import { changeRate, reading, reset, stop } from "../../utils/speech";
import { settings } from "../../panels/Settings/settingsStore";
import styles from "./ReadingChip.module.css";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export function nextSpeed(rate: number): number {
  return SPEEDS.find((s) => s > rate + 1e-9) ?? SPEEDS[0];
}

const speedLabel = (rate: number) => `${+rate.toFixed(2)}x`;

export default function ReadingChip() {
  // Speech is native and outlives a webview reload, which would come back
  // with no chip for what is still playing.
  onMount(() => void reset());
  return (
    <Show when={reading()}>
      <div class={styles.chip} role="status">
        <Icon icon={Volume2} />
        <span>Reading aloud</span>
        <Tooltip
          as="button"
          type="button"
          class={styles.speed}
          label="Change the reading speed"
          onClick={() => void changeRate(nextSpeed(settings.speech.rate))}
        >
          {speedLabel(settings.speech.rate)}
        </Tooltip>
        <IconButton size="xs" icon={<Icon icon={Square} />} tooltip="Stop reading" onClick={() => void stop()} />
      </div>
    </Show>
  );
}
