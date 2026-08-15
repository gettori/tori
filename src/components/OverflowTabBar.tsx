import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  For,
  Show,
  type JSX,
} from "solid-js";
import { computeVisibleCount, moveIntoView, type Reserves } from "../utils/tabOverflow";
import Dropdown from "./Menu/Dropdown";
import { MenuRow } from "./Menu/rows";
import Tooltip from "./Tooltip/Tooltip";

// A tab bar that never scrolls: it renders only the tabs that fully fit, plus a
// `+N` button whose dropdown lists the rest. Generic over the tab item type T;
// the consumer supplies the tab and menu-row markup. Fit is measured from an
// inert ghost row (so gaps/padding/borders are layout-accurate); the active tab
// is pulled into view for *display only* (never mutating the canonical order),
// while clicking an overflow item persists a reference-preserving reorder.
export default function OverflowTabBar<T>(props: {
  items: T[];
  activeId: string | null;
  idOf: (t: T) => string;
  onActivate: (id: string) => void;
  onReorder: (next: T[]) => void;
  /** The tab's markup. Called twice per tab: once for the row on screen, and
   *  once with `ghost` set for the inert measuring copy.
   *
   *  A consumer whose tab carries a context menu should skip it for the ghost.
   *  The menu is invisible either way, but mounting one per tab twice doubles
   *  the machinery for a row nobody can reach, and leaves the document with two
   *  triggers claiming the same tab. */
  renderTab: (t: T, ghost?: boolean) => JSX.Element;
  renderMenuItem: (t: T) => JSX.Element;
  trailing?: JSX.Element;
  class?: string;
}) {
  let bar!: HTMLDivElement;
  let ghost!: HTMLDivElement;
  let countSample: HTMLButtonElement | undefined;
  let trailingEl: HTMLDivElement | undefined;

  const [visibleCount, setVisibleCount] = createSignal(props.items.length);
  const [menuOpen, setMenuOpen] = createSignal(false);

  // Display order: pull the active tab into the last visible slot for rendering
  // only (no onReorder), so resizing never reorders the user's canonical tabs.
  const displayOrder = createMemo((): T[] => {
    const items = props.items;
    const vc = visibleCount();
    const active = props.activeId;
    if (!active) return items;
    const idx = items.findIndex((t) => props.idOf(t) === active);
    if (idx < 0 || idx < vc) return items;
    return moveIntoView(items, active, vc - 1, props.idOf);
  });
  const visible = () => displayOrder().slice(0, visibleCount());
  const overflow = () => displayOrder().slice(visibleCount());

  function measure() {
    if (!bar || !ghost) return;
    const children = Array.from(ghost.children).filter(
      (c) => c !== countSample,
    ) as HTMLElement[];
    const ghostLeft = ghost.getBoundingClientRect().left;
    const extents = children.map((c) => c.getBoundingClientRect().right - ghostLeft);
    const cs = getComputedStyle(bar);
    let count = 0;
    if (countSample) {
      const cm = getComputedStyle(countSample);
      count = countSample.offsetWidth + parseFloat(cm.marginLeft) + parseFloat(cm.marginRight);
    }
    const reserves: Reserves = {
      padding: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight),
      trailing: trailingEl?.offsetWidth ?? 0,
      count,
      safety: 6,
    };
    setVisibleCount(computeVisibleCount(extents, bar.clientWidth, reserves));
  }

  let ro: ResizeObserver | undefined;
  onMount(() => {
    requestAnimationFrame(measure);
    ro = new ResizeObserver(() => measure());
    ro.observe(bar);
    ro.observe(ghost); // content-width changes (tab added, dirty dot) re-measure
  });
  onCleanup(() => ro?.disconnect());

  // Re-measure when the item set changes.
  createEffect(() => {
    props.items.length;
    requestAnimationFrame(measure);
  });

  // Close the menu if its contents drained (last overflow tab closed).
  createEffect(() => {
    if (menuOpen() && overflow().length === 0) setMenuOpen(false);
  });

  function pickOverflow(id: string) {
    props.onReorder(moveIntoView(props.items, id, visibleCount() - 1, props.idOf));
    props.onActivate(id);
    setMenuOpen(false);
  }

  return (
    <div class={props.class} ref={bar} style={{ position: "relative" }}>
      {/* Inert ghost row: every tab in canonical order + a count sample, used
          only to measure true widths (gaps/padding/borders included). */}
      <div class={`${props.class ?? ""} otab-ghost`} ref={ghost} aria-hidden="true">
        <For each={props.items}>{(t) => props.renderTab(t, true)}</For>
        <button class="tab-overflow-count" ref={countSample}>
          +{Math.max(1, props.items.length)}
        </button>
      </div>

      <For each={visible()}>{(t) => props.renderTab(t)}</For>

      <Show when={overflow().length > 0}>
        {/* The `+N` button already belongs to its `Tooltip`, so the menu wraps
            it. Unlike the tab rows' wrapper this one keeps a box: a dropdown is
            anchored on its trigger's rect, and a `display: contents` element has
            none, so the menu would open in the window's top-left corner. An
            inline-flex box around one flex item is the same width the button
            was, margins included, so the strip lays out unchanged. */}
        <Dropdown
          as="span"
          wrapper
          class="tab-overflow-wrap"
          open={menuOpen()}
          onOpenChange={setMenuOpen}
          placement="bottom-start"
          menu={
            <For each={overflow()}>
              {(t) => (
                <MenuRow onClick={() => pickOverflow(props.idOf(t))}>
                  {props.renderMenuItem(t)}
                </MenuRow>
              )}
            </For>
          }
        >
          <Tooltip
            as="button"
            type="button"
            class="tab-overflow-count"
            classList={{ active: menuOpen() }}
            label={`${overflow().length} more`}
            aria-label={`${overflow().length} more`}
            // Kobalte writes these on the trigger, which is the wrapper, and
            // they cannot be taken off it (`wrapper` removes its `role` and tab
            // stop, not its ARIA). The button is what the keyboard reaches, so
            // it says this too.
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
          >
            +{overflow().length}
          </Tooltip>
        </Dropdown>
      </Show>

      <div class="otab-trailing" ref={trailingEl}>
        {props.trailing}
      </div>
    </div>
  );
}
