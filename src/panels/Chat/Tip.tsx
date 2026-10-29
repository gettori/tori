import { For, Show } from "solid-js";
import styles from "./Chat.module.css";

export type TipContent = {
  heading: string;
  lines?: readonly string[];
  /** Quoted content, kept in its own lines and font: a selection's code, a
   *  queued message. */
  excerpt?: string | null;
  /** Something wrong with the thing, in the danger tone. */
  warn?: string | null;
  /** What clicking does, last and dimmest. */
  hint?: string | null;
};

/** The one tooltip body for everything above the composer, so a tile, a lane and
 *  a queued message answer "what is this" in the same order. */
export default function Tip(props: TipContent) {
  return (
    <div class={styles.tip}>
      <div class={styles.tipTitle}>{props.heading}</div>
      <For each={props.lines ?? []}>{(line) => <div class={styles.tipLine}>{line}</div>}</For>
      <Show when={props.excerpt}>{(text) => <pre class={styles.tipExcerpt}>{text()}</pre>}</Show>
      <Show when={props.warn}>{(text) => <div class={styles.tipWarn}>{text()}</div>}</Show>
      <Show when={props.hint}>{(text) => <div class={styles.tipHint}>{text()}</div>}</Show>
    </div>
  );
}

/** The first `max` lines of `text`, marked when there was more. */
export function excerptOf(text: string | null | undefined, max = 6): string | null {
  if (!text?.trim()) return null;
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n...` : lines.join("\n");
}
