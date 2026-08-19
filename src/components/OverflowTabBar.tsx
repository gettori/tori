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
import { tabGesture } from "../utils/tabGesture";
import { Tabs } from "../lib/tabs";
import { TabRow } from "./Tab/Tab";
import Dropdown from "./Menu/Dropdown";
import { MenuRow } from "./Menu/rows";
import Tooltip from "./Tooltip/Tooltip";

let measures = 0;
/** How many ghost measurements have run, across every bar in the window. A
 *  measurement reads layout, so a click in one pane paying for one in every
 *  other pane is the storm this counts. */
export function __measuresForTests(): number {
  return measures;
}

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
  /** The bar's own element, for a consumer that hit-tests against its box. */
  ref?: (el: HTMLElement) => void;
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
    measures++;
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

  /** What the bar is handling right now, and whether it is a user selecting a
   *  tab. Marked in the capture phase and read from inside a handler Kobalte
   *  owns; `tabGesture` is where the lifetime and the exclusions are explained,
   *  and it is deliberately not a flag this file clears by hand. */
  const gesture = tabGesture();

  /**
   * Keep activation on the click rather than on the press.
   *
   * Kobalte's tab trigger selects on mouse press and offers no way to ask for
   * press-up: `shouldSelectOnPressUp` is not a `Tabs.Trigger` prop, and
   * `composeEventHandlers` ignores `defaultPrevented`, so a handler passed in
   * beside Kobalte's cannot veto it. The editor's tabs are `draggable` and a
   * drag is a press that never becomes a click, so without this, carrying a
   * tab's path out to the terminal would load that file first.
   *
   * Capture on the bar, so the trigger's own listeners never run. This stops
   * *listeners*, not default actions, so focus-on-press and the drag itself are
   * untouched. With no press recorded, Kobalte's click handler takes the
   * selection instead, which is the branch it uses for touch and pen.
   *
   * Scoped to the triggers: the `+N` button and the close buttons are not tabs
   * and keep every event they had.
   */
  function onPress(e: Event) {
    gesture.mark(e);
    if (gesture.live()) e.stopPropagation();
  }

  let ro: ResizeObserver | undefined;
  onMount(() => {
    bar.addEventListener("pointerdown", onPress, true);
    bar.addEventListener("click", gesture.mark, true);
    bar.addEventListener("keydown", gesture.mark, true);
    onCleanup(() => {
      bar.removeEventListener("pointerdown", onPress, true);
      bar.removeEventListener("click", gesture.mark, true);
      bar.removeEventListener("keydown", gesture.mark, true);
    });
    requestAnimationFrame(measure);
    ro = new ResizeObserver(() => measure());
    ro.observe(bar);
    ro.observe(ghost); // content-width changes (tab added, dirty dot) re-measure
  });
  onCleanup(() => ro?.disconnect());

  // On the ids, not the list: every strip gets a fresh array whenever any pane's
  // placement changes, so a click in one pane re-measured the ghost in all of
  // them. A NUL joins, since a tab id is a path and a path can hold a space.
  const idKey = createMemo(() => props.items.map(props.idOf).join("\u0000"));
  createEffect(() => {
    idKey();
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

  /** Where a tab sits in the list the consumer holds, which is not the row on
   *  screen: the whole point of this bar is that the two differ. */
  function positionOf(id: string) {
    const index = props.items.findIndex((t) => props.idOf(t) === id);
    return index < 0 ? undefined : { index: index + 1, total: props.items.length };
  }

  /**
   * Kobalte's selection, filtered down to the changes a user actually made.
   *
   * `TabsRoot` force-selects the first key whenever the value it is given names
   * no rendered tab, and calls `onChange` on the way. That is a heal, not a
   * click, and forwarding it would not blank the selection, it would open a
   * different file: closing the active tab puts the strip in exactly that state
   * for one render, before the panel has picked what comes next.
   *
   * The gesture is what separates the two, rather than the state: a heal runs
   * from an effect with nothing but a render behind it. Gating on the state
   * instead would swallow a real click on a strip that starts with nothing
   * selected, since Kobalte's heal picks the leftmost tab and so does a user.
   *
   * Closing a tab is the case that makes this worth getting right, and both
   * ways of closing one land on the same side of the line. A click on the close
   * button has no tab above it, because the button is a *sibling* of the
   * trigger. A Delete or Backspace does land on the tab, and the heal it causes
   * arrives while that keystroke is still dispatching, which is why
   * `tabGesture` refuses to call a close keystroke a selection.
   */
  function onChange(next: string) {
    if (!gesture.live()) return;
    if (next === props.activeId) return;
    props.onActivate(next);
  }

  return (
    // Root sits *inside* the bar rather than above it, so the planned single
    // merged editor+terminal strip is one bar over a mixed item list and a
    // split is two instances of it.
    <Tabs.Root
      class={props.class}
      ref={(el: HTMLDivElement) => {
        bar = el;
        props.ref?.(el);
      }}
      style={{ position: "relative" }}
      activationMode="automatic"
      // Never null: Kobalte reads `undefined` as "uncontrolled" and takes the
      // selection over for good. An empty key keeps it controlled and names
      // nothing, which `onChange` above is what handles.
      value={props.activeId ?? ""}
      onChange={onChange}
    >
      {/* Inert ghost row: every tab in canonical order + a count sample, used
          only to measure true widths (gaps/padding/borders included). `TabRow
          inert` is what keeps it out of both the accessibility tree and
          Kobalte's collection, where it would register a second item under
          every key the real row already holds. */}
      <TabRow inert>
        <div class={`${props.class ?? ""} otab-ghost`} ref={ghost} aria-hidden="true">
          <For each={props.items}>{(t) => props.renderTab(t, true)}</For>
          <button class="tab-overflow-count" ref={countSample} disabled>
            +{Math.max(1, props.items.length)}
          </button>
        </div>
      </TabRow>

      {/* `.otab-list` is `display: contents`: the tablist has to wrap the tabs
          and nothing else (a tablist may own no other role), while the strip
          stays the one flex row it was, with `+N` and the trailing action
          beside the tabs rather than inside them. */}
      <TabRow position={positionOf}>
        <Tabs.List class="otab-list">
          <For each={visible()}>{(t) => props.renderTab(t)}</For>
        </Tabs.List>
      </TabRow>

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
    </Tabs.Root>
  );
}
