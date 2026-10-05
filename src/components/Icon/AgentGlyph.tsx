import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { agents } from "../../utils/agents";
import { agentMark } from "./agentMarks";
import styles from "./AgentGlyph.module.css";

/**
 * One agent's logo, or its initial when Tori has no logo for it.
 *
 * The fallback is a letter rather than a generic robot on purpose: four
 * identical robots in a column say less than four different letters, and a
 * shared placeholder reads as "these are the same kind of thing" when the whole
 * point of the column is telling them apart.
 *
 * **Resolution never guesses.** `findAdapter` is not used here even though it
 * takes exactly this id: it falls back to the first bundled adapter for an
 * unknown one, which would quietly put Anthropic's mark on somebody else's
 * agent. This looks the adapter up itself and takes the miss.
 */
export default function AgentGlyph(props: {
  /** Adapter id. */
  id: string;
  /** Supplies the initial when there is no mark, so it must be the name the
   *  reader sees rather than the id. */
  label: string;
  /** Box side in px, before `--ui-scale`. */
  size?: number;
}) {
  const size = () => props.size ?? 20;
  /** The adapter's declared `icon` first, then the id, for a caller whose
   *  adapter has not resolved yet. */
  const mark = () => {
    const declared = agents().find((a) => a.id === props.id)?.icon;
    return agentMark(declared) ?? agentMark(props.id);
  };
  return (
    <span class={styles.glyph} style={{ "--glyph-size": `calc(${size()}px * var(--ui-scale))` }} aria-hidden="true">
      <Show when={mark()} fallback={<span class={styles.letter}>{props.label.slice(0, 1)}</span>}>
        {(Mark) => <Dynamic component={Mark()} size={`calc(${Math.round(size() * 0.7)}px * var(--ui-scale))`} />}
      </Show>
    </span>
  );
}
