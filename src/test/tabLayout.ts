// A layout for `OverflowTabBar`, and only for it.
//
// The bar's behaviour *is* a measurement: it renders the tabs that fit plus a
// `+N` for the rest, read off an inert ghost row through
// `getBoundingClientRect`. jsdom has no layout, so every width is 0,
// `computeVisibleCount` falls through to its "always show at least one" floor,
// and the visible row holds exactly one tab no matter how many are open. The
// ghost holds the rest, which is why `src/test/tabs.ts` used to look past
// `aria-hidden` to find a tab at all.
//
// That made the ghost answer for the strip. It is the wrong copy to ask: it
// carries no context menu (gettori/tori#103), and once it stops being
// interactive at all there is nothing there to ask. So rather than teach the
// tests a better way to reach the ghost, this gives the bar a real width and
// puts the tabs where a browser would put them.
//
// **Scoped to the bar on purpose.** The overrides answer only for elements in
// an `.otab-ghost` strip and the bar around it, and delegate everything else to
// jsdom untouched. A blanket "every element is 120px wide" would change what
// CodeMirror, the dialogs and the slider measure, none of which asked for a
// layout.

/** One tab's width. Uniform, so a test can compute what should fit. */
export const TAB_WIDTH = 120;

/** The `+N` button's width, reserved by `computeVisibleCount` once anything
 *  overflows. */
export const COUNT_WIDTH = 40;

/** Wide enough that every tab fits, so a test that does not care about overflow
 *  never has to think about it. Overflow tests narrow it deliberately. */
export const DEFAULT_BAR_WIDTH = 4000;

let barWidth = DEFAULT_BAR_WIDTH;

/**
 * Narrow (or widen) the bar for one test, in px.
 *
 * With `TAB_WIDTH` at 120 and the `+N` button reserved at 40 plus 6px of
 * safety, a 500px bar fits three tabs and collapses the rest: the arithmetic is
 * `computeVisibleCount`'s, and stating the width in the test is what makes the
 * expected count readable. Reset after every test.
 */
export function setTabBarWidth(px: number): void {
  barWidth = px;
}

export function resetTabBarWidth(): void {
  barWidth = DEFAULT_BAR_WIDTH;
}

const isGhost = (el: Element) => el.classList.contains("otab-ghost");
const isCountSample = (el: Element) => el.classList.contains("tab-overflow-count");

/** The bar is whatever holds the ghost. It has no class of its own here: the
 *  consumer passes one, and vitest stubs CSS Modules to the empty string. */
const isBar = (el: Element) => Array.from(el.children).some(isGhost);

/** Tabs, in the order the ghost renders them. The count sample sits in the same
 *  row and is not one. */
const ghostTabs = (ghost: Element) => Array.from(ghost.children).filter((c) => !isCountSample(c));

function rectAt(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: 0,
    width,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Install the overrides. Called once from `domSetup.ts`, so every `dom` test
 * gets a measurable tab bar and no test gets anything else.
 */
export function installTabLayout(): void {
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (isGhost(this)) return rectAt(0, ghostTabs(this).length * TAB_WIDTH);
    const parent = this.parentElement;
    if (parent && isGhost(parent) && !isCountSample(this)) {
      // `measure()` reads `right - ghostLeft`, so these are the cumulative
      // extents the real strip would have.
      const i = ghostTabs(parent).indexOf(this);
      if (i >= 0) return rectAt(i * TAB_WIDTH, TAB_WIDTH);
    }
    return realRect.call(this);
  };

  const realOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (isCountSample(this)) return COUNT_WIDTH;
      return realOffsetWidth?.get?.call(this) ?? 0;
    },
  });

  const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      if (isBar(this)) return barWidth;
      return realClientWidth?.get?.call(this) ?? 0;
    },
  });
}
