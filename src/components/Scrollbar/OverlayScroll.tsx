import { createSignal, onCleanup, onMount, splitProps, type JSX } from "solid-js";
import styles from "./OverlayScroll.module.css";

/**
 * A scroll container whose scrollbar floats over the content instead of
 * reserving a gutter.
 *
 * The global `::-webkit-scrollbar` recipe in base.css cannot do this: styling
 * that pseudo opts a surface out of macOS's overlay behaviour, so the styled
 * bar takes its width from the content box. The only way to a bar that truly
 * costs no space is to hide the native one and draw our own, which is what
 * this is. Native scrolling is untouched - wheel, trackpad, keyboard and
 * programmatic scrolls all drive the real scroller; only the *picture* of the
 * bar is ours.
 *
 * The thumb appears while the container is hovered or actively scrolling and
 * fades otherwise, and its track stops 6px short of both ends, so the pill
 * floats inside the box instead of running rail to rail.
 *
 * Sizing: the wrapper is a column flex, so a `max-height` (or flex sizing) on
 * `props.class` constrains the viewport and the content scrolls inside it.
 *
 * Anything else passed lands on that wrapper, so a caller can hang its own
 * handlers (a drop target, say) off the whole box rather than off the content,
 * which would only cover the rows and not the space under them.
 */
export default function OverlayScroll(
  props: { class?: string; children: JSX.Element } & JSX.HTMLAttributes<HTMLDivElement>,
) {
  const [local, rest] = splitProps(props, ["class", "children"]);
  let viewport!: HTMLDivElement;
  let content!: HTMLDivElement;
  let track!: HTMLDivElement;

  const [thumb, setThumb] = createSignal({ size: 0, offset: 0 });
  const [scrollable, setScrollable] = createSignal(false);
  const [hovering, setHovering] = createSignal(false);
  const [scrolling, setScrolling] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;

  const measure = () => {
    const { scrollHeight, clientHeight, scrollTop } = viewport;
    // The 1px slack forgives subpixel rounding, which otherwise shows a
    // useless thumb on a container that cannot actually move.
    const canScroll = scrollHeight > clientHeight + 1;
    setScrollable(canScroll);
    if (!canScroll) return;
    const trackH = track.clientHeight;
    // Floored so a very long document still leaves something to grab.
    const size = Math.max(24, (clientHeight / scrollHeight) * trackH);
    const offset = (scrollTop / (scrollHeight - clientHeight)) * (trackH - size);
    setThumb({ size, offset });
  };

  const onScroll = () => {
    measure();
    setScrolling(true);
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => setScrolling(false), 800);
  };

  // Thumb drag maps pointer travel to scroll distance at the track's ratio,
  // on window listeners so a fast drag that leaves the pill keeps scrolling.
  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startTop = viewport.scrollTop;
    const { scrollHeight, clientHeight } = viewport;
    const travel = track.clientHeight - thumb().size;
    const perPx = travel > 0 ? (scrollHeight - clientHeight) / travel : 0;
    const move = (ev: PointerEvent) => {
      viewport.scrollTop = startTop + (ev.clientY - startY) * perPx;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
    };
    setDragging(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  onMount(() => {
    measure();
    // Guarded because jsdom implements neither ResizeObserver nor layout:
    // there, every measurement is zero anyway, so observing nothing loses
    // nothing and the tests that render through this keep working.
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(viewport);
      ro.observe(content);
      onCleanup(() => ro.disconnect());
    }
    onCleanup(() => clearTimeout(fadeTimer));
  });

  const shown = () => scrollable() && (hovering() || scrolling() || dragging());

  return (
    <div
      {...rest}
      class={`${styles.frame} ${local.class ?? ""}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div class={styles.viewport} ref={viewport} onScroll={onScroll}>
        <div ref={content}>{local.children}</div>
      </div>
      {/* Purely presentational: the real scroller above is what assistive
          tech and the keyboard already drive. */}
      <div class={styles.track} classList={{ [styles.shown]: shown() }} ref={track} aria-hidden="true">
        <div
          class={styles.thumb}
          classList={{ [styles.dragging]: dragging() }}
          style={{ height: `${thumb().size}px`, transform: `translateY(${thumb().offset}px)` }}
          onPointerDown={startDrag}
        />
      </div>
    </div>
  );
}
