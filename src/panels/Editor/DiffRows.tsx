import { createMemo, createSignal, mergeProps, onCleanup, For, Show } from "solid-js";
import { changedRange, toSideBySide, type DiffRow } from "../../utils/diffView";
import { overlay, paintRows, type Span } from "../../utils/syntaxRows";
import { editorDefaults } from "../Settings/settingsStore";
import styles from "./DiffRows.module.css";

// One hunk's rows, rendered the same way wherever a diff appears.
//
// `diffView.ts` already owns the *computation* (which lines pair, which tokens
// changed, how rows lay out in two columns). This owns the markup that turns
// those rows into DOM. Splitting it that way is what lets a second surface
// reuse the first's diff without reimplementing either half, and is why the
// Changes panel and the transcript's diff view cannot drift apart: they are
// not two renderers kept in step, they are one renderer called twice.
//
// ## Two keyboard models, both opt-in
//
// The Changes panel stages lines: every changed line is a checkbox, so every
// changed line is a tab stop. That is right for a hunk you are picking through
// and wrong for a pull request, where one file runs to thousands of rows and
// tabbing past them would be the only way out of the diff. `keyboard:
// "roving"` gives the hunk **one** tab stop that arrow keys move within, which
// is the listbox pattern and what the review surface asks for.
//
// A surface that passes neither prop gets what it always got: plain text, no
// roles, no handlers.

function rowClass(row: DiffRow): string {
  if (row.kind === "add") return "add";
  if (row.kind === "del") return "del";
  if (row.kind === "meta") return "meta";
  return "";
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

/** Starting a comment on a row, when the surface offers commenting.
 *
 *  `extend` is a shift-click or shift-Enter, which grows the range to this row
 *  instead of starting a new one. The caller owns what a range may span, since
 *  only it knows the anchor rules. */
export type RowComment = {
  onComment: (index: number, extend: boolean) => void;
  /** The accessible name for one row's affordance, so the caller can name the
   *  line the way its own surface talks about lines. */
  label: (index: number) => string;
};

/// Where a hunk's one tab stop sits, and how to reach the row holding it.
///
/// Exists because a hunk is not always one `DiffRows`: a thread anchored
/// mid-hunk cuts the rows in two, and the pieces are still one hunk to a reader
/// and so must be one to the keyboard. Both halves have to be shared, not just
/// the index: moving the stop across the cut means focusing an element the
/// piece that handled the arrow key never rendered.
///
/// Indices are the hunk's throughout, so a piece reads its own rows through the
/// `offset` it was given.
export type RovingHunk = {
  at: () => number;
  setAt: (index: number) => void;
  rows: Map<number, HTMLElement>;
};

/** A holder for one hunk, for a caller that draws it in pieces. */
export function rovingHunk(): RovingHunk {
  const [at, setAt] = createSignal(0);
  return { at, setAt, rows: new Map() };
}

export default function DiffRows(allProps: {
  rows: DiffRow[];
  twoColumn: boolean;
  selection?: LineSelection;
  /** One tab stop for the whole hunk, arrow keys within it. Without this every
   *  selectable row is its own tab stop, which is the staging model. */
  keyboard?: "roving";
  /** The hunk's stop, when the caller draws the hunk in more than one piece.
   *  Left out, this instance is the whole hunk and holds its own. */
  roving?: RovingHunk;
  /** Index of `rows[0]` within the hunk. Zero unless the caller drew rows
   *  before this piece. */
  offset?: number;
  comment?: RowComment;
  /** Keys the surface handles itself, given the row they were pressed on. It
   *  returns true when it took the key, so the row does not also act on it. */
  onRowKey?: (index: number, e: KeyboardEvent) => boolean;
  /** The file the hunk belongs to, for its language. Without it the rows
   *  render plain. */
  path?: string;
}) {
  const props = mergeProps({ offset: 0 }, allProps);
  const painted = createMemo(() => (props.path ? paintRows(props.rows, props.path) : null));
  const numbered = createMemo(() => props.rows.some((r) => r.oldLine !== null || r.newLine !== null));
  const digits = createMemo(
    () => String(props.rows.reduce((max, r) => Math.max(max, r.oldLine ?? 0, r.newLine ?? 0), 0)).length,
  );

  // An index rather than a ref, so a re-render (a gap expanding, a thread
  // arriving) does not lose the position. Its own when this instance is the
  // whole hunk; the caller's when the hunk is drawn in pieces.
  const hunk = props.roving ?? rovingHunk();
  /** Move the tab stop and take the focus with it, which is the half a roving
   *  tabindex is useless without.
   *
   *  Clamped to the rows registered so far rather than to this piece: the row
   *  below the last one here is the first one of the next piece, and stopping
   *  at the cut would leave the rows past it reachable by nothing. */
  function rove(to: number) {
    const reach = [...hunk.rows.keys()];
    if (!reach.length) return;
    const at = Math.max(Math.min(...reach), Math.min(Math.max(...reach), to));
    hunk.setAt(at);
    hunk.rows.get(at)?.focus();
  }

  function cell(row: DiffRow | null, index: number | null, only?: "old" | "new") {
    // Read once, not per render: whether a surface offers line staging is a
    // property of the surface, so a read-only diff (a commit, a transcript)
    // gets no handlers and no roles at all rather than inert ones on every
    // line of a five-thousand-line diff.
    const selectable = !!props.selection && !!row && (row.kind === "add" || row.kind === "del") && index !== null;
    const commentable = !!props.comment && !!row && index !== null;
    const toggle = () => props.selection!.toggle(index!);
    const picked = () => selectable && props.selection!.has(index!);
    const spans = () => (index === null ? null : (painted()?.[index] ?? null));
    // The staging model gives every checkbox its own tab stop; roving gives the
    // hunk one. A cell with no row behind it is a side-by-side filler and is
    // never either.
    const stop = () => {
      if (props.keyboard !== "roving") return selectable ? 0 : undefined;
      if (!row || index === null) return undefined;
      return hunk.at() === props.offset + index ? 0 : -1;
    };
    return (
      <div
        class={`${styles.diffLine} ${row ? (styles[rowClass(row)] ?? "") : styles.sideEmpty} ${
          selectable ? styles.selectable : ""
        } ${picked() ? styles.selected : ""} ${spans() ? styles.painted : ""} ${numbered() ? styles.numbered : ""} ${
          commentable ? styles.commentable : ""
        } ${editorDefaults().softWrap ? styles.wrap : ""}`}
        ref={(el) => {
          if (index === null || !row) return;
          const key = props.offset + index;
          hunk.rows.set(key, el);
          onCleanup(() => {
            // Only if this row still owns the slot: a re-render registers the
            // new element before the old one cleans up, and a blind delete
            // would drop the live row out of the hunk's reach.
            if (hunk.rows.get(key) === el) hunk.rows.delete(key);
          });
        }}
        data-old={only === "new" ? undefined : (row?.oldLine ?? undefined)}
        data-new={only === "old" ? undefined : (row?.newLine ?? undefined)}
        style={digits() > 4 ? { "--diff-num-digits": digits() } : undefined}
        onClick={selectable ? toggle : undefined}
        onFocusIn={
          props.keyboard === "roving" && index !== null
            ? () => hunk.setAt(props.offset + index)
            : undefined
        }
        // A line is in the selection or it is not, which is what a checkbox
        // is. Reachable by keyboard for the same reason the conflicted row is
        // a button: a control only the mouse can reach is half a control.
        role={selectable ? "checkbox" : undefined}
        aria-checked={selectable ? picked() : undefined}
        tabIndex={stop()}
        onKeyDown={
          selectable || props.keyboard === "roving"
            ? (e: KeyboardEvent) => {
                if (index !== null && props.onRowKey?.(index, e)) {
                  e.preventDefault();
                  return;
                }
                if (props.keyboard === "roving" && index !== null) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    rove(props.offset + index + 1);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    rove(props.offset + index - 1);
                    return;
                  }
                }
                if (!selectable) return;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggle();
              }
            : undefined
        }
      >
        {/* Never a tab stop of its own. Roving promises one stop per hunk, and
            a button per row would put thousands back; `c` on the focused row is
            the keyboard's way in, which is why the caller also handles keys. */}
        <Show when={commentable}>
          <button
            type="button"
            class={styles.commentAdd}
            tabIndex={-1}
            aria-label={props.comment!.label(index!)}
            onClick={(e) => {
              e.stopPropagation();
              props.comment!.onComment(index!, e.shiftKey);
            }}
          >
            +
          </button>
        </Show>
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
