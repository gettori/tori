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
import Menu, { MenuRow } from "./Menu/Menu";
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
  renderTab: (t: T) => JSX.Element;
  renderMenuItem: (t: T) => JSX.Element;
  trailing?: JSX.Element;
  class?: string;
}) {
  let bar!: HTMLDivElement;
  let ghost!: HTMLDivElement;
  let countSample: HTMLButtonElement | undefined;
  let countBtn: HTMLButtonElement | undefined;
  let trailingEl: HTMLDivElement | undefined;

  const [visibleCount, setVisibleCount] = createSignal(props.items.length);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPos, setMenuPos] = createSignal({ left: 0, top: 0 });

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

  function openMenu() {
    if (!countBtn) return;
    const r = countBtn.getBoundingClientRect();
    setMenuPos({ left: r.left, top: r.bottom + 2 });
    setMenuOpen(true);
  }
  function toggleMenu() {
    if (menuOpen()) setMenuOpen(false);
    else openMenu();
  }
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
        <For each={props.items}>{(t) => props.renderTab(t)}</For>
        <button class="tab-overflow-count" ref={countSample}>
          +{Math.max(1, props.items.length)}
        </button>
      </div>

      <For each={visible()}>{(t) => props.renderTab(t)}</For>

      <Show when={overflow().length > 0}>
        <Tooltip
          as="button"
          type="button"
          class="tab-overflow-count"
          classList={{ active: menuOpen() }}
          ref={countBtn}
          label={`${overflow().length} more`}
          aria-label={`${overflow().length} more`}
          onClick={toggleMenu}
        >
          +{overflow().length}
        </Tooltip>
      </Show>

      <div class="otab-trailing" ref={trailingEl}>
        {props.trailing}
      </div>

      <Show when={menuOpen()}>
        <Menu
          x={menuPos().left}
          y={menuPos().top}
          anchorEl={countBtn}
          onClose={() => setMenuOpen(false)}
        >
          <For each={overflow()}>
            {(t) => <MenuRow onClick={() => pickOverflow(props.idOf(t))}>{props.renderMenuItem(t)}</MenuRow>}
          </For>
        </Menu>
      </Show>
    </div>
  );
}
