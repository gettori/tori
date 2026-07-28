import { For, Show } from "solid-js";
import { toSideBySide, type DiffRow } from "../../utils/diffView";
import styles from "./DiffRows.module.css";

// One hunk's rows, rendered the same way wherever a diff appears.
//
// `diffView.ts` already owns the *computation* (which lines pair, which tokens
// changed, how rows lay out in two columns). This owns the markup that turns
// those rows into DOM. Splitting it that way is what lets a second surface
// reuse the first's diff without reimplementing either half, and is why the
// Changes panel and the transcript's diff view cannot drift apart: they are
// not two renderers kept in step, they are one renderer called twice.

function rowClass(row: DiffRow): string {
  if (row.kind === "add") return "add";
  if (row.kind === "del") return "del";
  if (row.kind === "meta") return "meta";
  return "";
}

/** A line's text, with the changed tokens wrapped when the row was paired. */
function lineContent(r: DiffRow) {
  const segs = (r.kind === "del" || r.kind === "add") && r.segs;
  if (!segs) return "text" in r ? r.text || " " : " ";
  return (
    <For each={segs}>{(s) => (s.changed ? <span class={styles.wordChanged}>{s.text}</span> : <>{s.text}</>)}</For>
  );
}

/** Classes for a caller composing a row of its own that must line up with real
 *  diff rows: the Changes panel's collapsed-gap row and its hunk header both
 *  sit in the same column flow and would drift if they styled themselves. */
export const diffRowClasses = {
  line: styles.diffLine,
  hunk: styles.hunk,
  sideRow: styles.sideRow,
};

export default function DiffRows(props: { rows: DiffRow[]; twoColumn: boolean }) {
  return (
    <Show
      when={props.twoColumn}
      fallback={
        <For each={props.rows}>
          {(r) => <div class={`${styles.diffLine} ${styles[rowClass(r)] ?? ""}`}>{lineContent(r)}</div>}
        </For>
      }
    >
      {/* Side-by-side: one scroll container holding both columns, so the two
          sides scroll together by construction rather than by syncing. */}
      <div class={styles.sideBySide}>
        <For each={toSideBySide(props.rows)}>
          {(side) => (
            <div class={styles.sideRow}>
              <div class={`${styles.diffLine} ${side.left ? (styles[rowClass(side.left)] ?? "") : styles.sideEmpty}`}>
                {side.left ? lineContent(side.left) : " "}
              </div>
              <div class={`${styles.diffLine} ${side.right ? (styles[rowClass(side.right)] ?? "") : styles.sideEmpty}`}>
                {side.right ? lineContent(side.right) : " "}
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
