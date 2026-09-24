import { For, createEffect, createSignal, on, onCleanup } from "solid-js";
import dawn from "./scenes/dawn.svg?raw";
import morning from "./scenes/morning.svg?raw";
import midday from "./scenes/midday.svg?raw";
import golden from "./scenes/golden.svg?raw";
import dusk from "./scenes/dusk.svg?raw";
import night from "./scenes/night.svg?raw";
import storm from "./scenes/storm.svg?raw";
import styles from "./Horizon.module.css";

/** The times of day, and the storm, which shows at any hour. */
export type SceneKey = "dawn" | "morning" | "midday" | "golden" | "dusk" | "night" | "storm";

export const SCENE_KEYS: SceneKey[] = ["dawn", "morning", "midday", "golden", "dusk", "night", "storm"];

// Inline rather than <img>: each scene animates from a <style> of its own, and
// its last wave is painted in the page's canvas role, which an <img> cannot read.
const SCENES: Record<SceneKey, string> = { dawn, morning, midday, golden, dusk, night, storm };

/** The scene for an hour of the local day. */
export function pickScene(hour: number): SceneKey {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 11) return "morning";
  if (hour >= 11 && hour < 15) return "midday";
  if (hour >= 15 && hour < 18) return "golden";
  if (hour >= 18 && hour < 21) return "dusk";
  return "night";
}

const FADE_MS = 1200;

/** The animated sea and sky behind the cockpit's banner. A new scene fades in
 *  over the old one, which goes once it is covered. */
export default function Horizon(props: { scene: SceneKey }) {
  const [layers, setLayers] = createSignal<SceneKey[]>([props.scene]);
  createEffect(
    on(
      () => props.scene,
      (next) => {
        setLayers((l) => [...l.filter((k) => k !== next), next]);
        const done = setTimeout(() => setLayers((l) => l.slice(-1)), FADE_MS);
        onCleanup(() => clearTimeout(done));
      },
      { defer: true },
    ),
  );
  return (
    <div class={styles.horizon} aria-hidden="true">
      <For each={layers()}>{(key) => <div class={styles.scene} innerHTML={SCENES[key]} />}</For>
    </div>
  );
}
