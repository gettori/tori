import { For } from "solid-js";
import styles from "./DiffBlocks.module.css";

type BlockKind = "added" | "removed" | "neutral";

/** The host's five-square size bar: each side gets its share rounded down, and
 *  what rounding leaves over stays grey. */
function blocks(additions: number, deletions: number): BlockKind[] {
  const total = additions + deletions;
  const added = total ? Math.floor((5 * additions) / total) : 0;
  const removed = total ? Math.floor((5 * deletions) / total) : 0;
  return [
    ...Array<BlockKind>(added).fill("added"),
    ...Array<BlockKind>(removed).fill("removed"),
    ...Array<BlockKind>(5 - added - removed).fill("neutral"),
  ];
}

export default function DiffBlocks(props: { additions: number; deletions: number }) {
  return (
    <span class={styles.blocks} aria-hidden="true">
      <For each={blocks(props.additions, props.deletions)}>
        {(kind) => <span class={styles.block} data-kind={kind} />}
      </For>
    </span>
  );
}
