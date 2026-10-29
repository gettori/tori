import { For, createMemo } from "solid-js";
import styles from "./DictationWave.module.css";

export default function DictationWave(props: { levels: number[]; busy: boolean }) {
  // Newest in the middle, spreading out to both sides: the voice comes from
  // the centre of the box and moves outward as it ages.
  const mirrored = createMemo(() => [...props.levels, ...[...props.levels].reverse()]);
  const centre = () => (mirrored().length - 1) / 2;
  return (
    <div class={styles.wave} classList={{ [styles.busy]: props.busy }}>
      <div class={styles.bars} aria-hidden="true">
        <For each={mirrored()}>
          {(level, i) => {
            const away = () => Math.abs(i() - centre()) / centre();
            return (
              <span
                class={styles.bar}
                style={{
                  "--level": props.busy ? 0.3 : level,
                  "--away": away(),
                }}
              />
            );
          }}
        </For>
      </div>
      <span class={styles.label} role="status">
        {props.busy ? "Turning what you said into text" : "Listening. Press Escape to drop it"}
      </span>
    </div>
  );
}
