import { createEffect, onCleanup, onMount, type JSX } from "solid-js";
import styles from "./Glide.module.css";

// A row reached within this long of a real pointer move is the pointer's doing.
// Keys, and a wheel scrolling rows under a resting pointer, move no pointer.
const POINTER_MS = 100;
// Crossing a gap between rows (a menu's separator) lights nothing for a frame or
// two; the fill waits that out, so it glides on instead of blinking.
const GAP_MS = 80;

const fillLists = new WeakSet<Element>();

/** A listbox's option at `index`, for a cursor kept as an index. */
export const optionAt = (list: HTMLElement, index: number) => list.querySelectorAll('[role="option"]')[index];

/**
 * One fill behind a list's active row, gliding when the pointer moves it and
 * jumping when anything else does. Render it as the list's first child, and make
 * the list `position: relative` and `isolation: isolate`: the fill is placed from
 * the rows' layout offsets, which a list opening mid-scale does not distort, and
 * it sits under each row's own fills. A list whose rows are not on the medium
 * radius sets `--glide-radius`, and one that fades its fill sets `--glide-fill`.
 */
export default function Glide(props: {
  /** The row the list's own cursor is on, read again whenever it is placed:
   *  when the signals it reads change, and when focus moves inside the list,
   *  which is how a menu's or a select's highlight moves. */
  active?: (list: HTMLElement) => Element | null | undefined;
  /** Rows that light under a moving pointer, for a list whose cursor does not
   *  follow the pointer itself. */
  hover?: string;
  /** How far into a row its fill starts, in px. */
  inset?: (row: HTMLElement) => number;
  /** Row attributes that move the cursor without focus moving, watched while
   *  the fill shows. */
  attributes?: string[];
}): JSX.Element {
  let el!: HTMLDivElement;
  let hovered: Element | null = null;
  let lead: "cursor" | "hover" = "cursor";
  let lastMove = Number.NEGATIVE_INFINITY;
  let glideNext = false;
  let shown: HTMLElement | null = null;
  let frame = 0;
  let gap = 0;
  let resize: ResizeObserver | null = null;
  let rows: MutationObserver | null = null;

  const list = () => el.parentElement as HTMLElement;
  const pointerMoved = () => performance.now() - lastMove < POINTER_MS;

  function ownRow(row: Element | null | undefined): HTMLElement | null {
    if (!(row instanceof HTMLElement) || !row.isConnected) return null;
    let n = row.parentElement;
    while (n && !fillLists.has(n)) n = n.parentElement;
    return n === el.parentElement ? row : null;
  }

  function target(): HTMLElement | null {
    if (!el.parentElement) return null;
    const cursor = ownRow(props.active?.(list()));
    const over = ownRow(hovered);
    return lead === "hover" && over ? over : (cursor ?? over);
  }

  function request(glide?: boolean) {
    if (glide !== undefined) glideNext = glide;
    if (!frame) frame = requestAnimationFrame(place);
  }

  function place() {
    frame = 0;
    const row = target();
    if (!row) {
      if (shown && !gap) {
        gap = window.setTimeout(() => {
          gap = 0;
          if (!target()) hide();
        }, GAP_MS);
      }
      return;
    }
    clearTimeout(gap);
    gap = 0;
    const inset = props.inset?.(row) ?? 0;
    let x = inset;
    let y = 0;
    for (let n: HTMLElement | null = row; n && n !== el.offsetParent; n = n.offsetParent as HTMLElement | null) {
      x += n.offsetLeft;
      y += n.offsetTop;
    }
    el.toggleAttribute("data-glide", glideNext && shown !== null && row !== shown);
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.width = `${row.offsetWidth - inset}px`;
    el.style.height = `${row.offsetHeight}px`;
    el.toggleAttribute("data-shown", true);
    glideNext = false;
    shown = row;
    watch();
  }

  function hide() {
    el.removeAttribute("data-shown");
    shown = null;
    resize?.disconnect();
    rows?.disconnect();
    resize = rows = null;
  }

  function watch() {
    if (resize) return;
    resize = new ResizeObserver(() => request());
    rows = new MutationObserver(() => request());
    resize.observe(list());
    rows.observe(list(), {
      childList: true,
      subtree: true,
      ...(props.attributes ? { attributeFilter: props.attributes } : {}),
    });
  }

  createEffect(() => {
    if (el.parentElement) props.active?.(list());
    lead = "cursor";
    request(pointerMoved());
  });

  onMount(() => {
    const host = list();
    fillLists.add(host);
    const onMove = (e: PointerEvent) => {
      if (e.movementX !== 0 || e.movementY !== 0) lastMove = performance.now();
    };
    const onOver = (e: PointerEvent) => {
      const next = ownRow((e.target as Element).closest(props.hover!));
      if (next === hovered) return;
      hovered = next;
      if (next && pointerMoved()) lead = "hover";
      request(pointerMoved());
    };
    const onLeave = () => {
      hovered = null;
      request(false);
    };
    const onFocus = () => {
      lead = "cursor";
      request(pointerMoved());
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("focusin", onFocus);
    host.addEventListener("focusout", onFocus);
    if (props.hover) {
      host.addEventListener("pointerover", onOver);
      host.addEventListener("pointerleave", onLeave);
    }
    onCleanup(() => {
      cancelAnimationFrame(frame);
      clearTimeout(gap);
      hide();
      fillLists.delete(host);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("focusin", onFocus);
      host.removeEventListener("focusout", onFocus);
      host.removeEventListener("pointerover", onOver);
      host.removeEventListener("pointerleave", onLeave);
    });
  });

  return <div ref={el} class={styles.glide} aria-hidden="true" />;
}
