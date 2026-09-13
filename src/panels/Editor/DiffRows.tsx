import { createMemo, For, Show } from "solid-js";
import { toSideBySide, type DiffRow, type Seg } from "../../utils/diffView";
import { overlay, paintRows, type Span } from "../../utils/syntaxRows";
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

// `segs[0]` is the marker, which is never part of the run.
function changedRange(segs: Seg[]): [number, number] | null {
  let at = 0;
  for (const s of segs.slice(1)) {
    if (s.changed) return [at, at + s.text.length];
    at += s.text.length;
  }
  return null;
}

/** A line's text, with the changed tokens wrapped when the row was paired. */
function lineContent(r: DiffRow, spans: Span[] | null) {
  const segs = (r.kind === "del" || r.kind === "add") && r.segs;
  if (spans) {
    const range = segs ? changedRange(segs) : null;
    const pieces = range ? overlay(spans, range[0], range[1]) : spans.map((s) => ({ ...s, changed: false }));
    return (
      <>
        <span class={styles.marker}>{r.kind === "context" ? " " : r.text.slice(0, 1) || " "}</span>
        <For each={pieces}>
          {(p) => <span class={`${p.cls ?? ""} ${p.changed ? styles.wordChanged : ""}`}>{p.text}</span>}
        </For>
      </>
    );
  }
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

/** Line-level staging, when the surface rendering the hunk offers it.
 *
 *  Indices are into the hunk body the rows were built from, which is what the
 *  backend selects by. Only changed lines are offered: a context line is in both
 *  versions, so there is nothing about it to stage. */
export type LineSelection = {
  has: (index: number) => boolean;
  toggle: (index: number) => void;
};

export default function DiffRows(props: {
  rows: DiffRow[];
  twoColumn: boolean;
  selection?: LineSelection;
  /** The file the hunk belongs to, for its language. Without it the rows
   *  render plain. */
  path?: string;
}) {
  const painted = createMemo(() => (props.path ? paintRows(props.rows, props.path) : null));
  const numbered = createMemo(() => props.rows.some((r) => r.oldLine !== null || r.newLine !== null));
  const digits = createMemo(
    () => String(props.rows.reduce((max, r) => Math.max(max, r.oldLine ?? 0, r.newLine ?? 0), 0)).length,
  );

  function cell(row: DiffRow | null, index: number | null, only?: "old" | "new") {
    // Read once, not per render: whether a surface offers line staging is a
    // property of the surface, so a read-only diff (a commit, a transcript)
    // gets no handlers and no roles at all rather than inert ones on every
    // line of a five-thousand-line diff.
    const selectable = !!props.selection && !!row && (row.kind === "add" || row.kind === "del") && index !== null;
    const toggle = () => props.selection!.toggle(index!);
    const picked = () => selectable && props.selection!.has(index!);
    const spans = () => (index === null ? null : (painted()?.[index] ?? null));
    return (
      <div
        class={`${styles.diffLine} ${row ? (styles[rowClass(row)] ?? "") : styles.sideEmpty} ${
          selectable ? styles.selectable : ""
        } ${picked() ? styles.selected : ""} ${spans() ? styles.painted : ""} ${numbered() ? styles.numbered : ""}`}
        data-old={only === "new" ? undefined : (row?.oldLine ?? undefined)}
        data-new={only === "old" ? undefined : (row?.newLine ?? undefined)}
        style={digits() > 4 ? { "--diff-num-digits": digits() } : undefined}
        onClick={selectable ? toggle : undefined}
        // A line is in the selection or it is not, which is what a checkbox
        // is. Reachable by keyboard for the same reason the conflicted row is
        // a button: a control only the mouse can reach is half a control.
        role={selectable ? "checkbox" : undefined}
        aria-checked={selectable ? picked() : undefined}
        tabIndex={selectable ? 0 : undefined}
        onKeyDown={
          selectable
            ? (e: KeyboardEvent) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggle();
              }
            : undefined
        }
      >
        {row ? lineContent(row, spans()) : " "}
      </div>
    );
  }

  return (
    <Show
      when={props.twoColumn}
      fallback={<For each={props.rows}>{(r, i) => cell(r, i())}</For>}
    >
      {/* Side-by-side: one scroll container holding both columns, so the two
          sides scroll together by construction rather than by syncing. */}
      <div class={styles.sideBySide}>
        <For each={toSideBySide(props.rows)}>
          {(side) => (
            <div class={styles.sideRow}>
              {cell(side.left, side.leftIndex, "old")}
              {cell(side.right, side.rightIndex, "new")}
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
