import { For, Show } from "solid-js";
import styles from "./TooltipLines.module.css";

/**
 * A tooltip body for a surface that has more than one thing to say.
 *
 * Most tooltips are a phrase and want none of this. This is for the two in the
 * sidebar that answer with a run of facts: a branch's sync standing and its
 * pull request. Flat, those read as a dump, because nothing in five equal
 * sentences says which one the pointer was asking about.
 *
 * `lead` is what the glyph under the pointer means, `rest` is what the surface
 * volunteered alongside it. One step of tone between them is the whole design;
 * anything more would be chrome competing with the row it describes.
 */
export default function TooltipLines(props: { lead: readonly string[]; rest?: readonly string[] }) {
  return (
    <span class={styles.lines}>
      <For each={props.lead}>{(line) => <span class={styles.lead}>{line}</span>}</For>
      <Show when={props.rest?.length}>
        <For each={props.rest}>{(line) => <span class={styles.rest}>{line}</span>}</For>
      </Show>
    </span>
  );
}
