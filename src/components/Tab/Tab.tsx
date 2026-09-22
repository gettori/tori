import { splitProps, Show, createContext, useContext, type JSX } from "solid-js";
import { Tabs } from "../../lib/tabs";
import Tooltip, { type TooltipPlacement } from "../Tooltip/Tooltip";
import styles from "./Tab.module.css";

/** Where a tab sits in its strip's **canonical** list, 1-based. */
export type TabPosition = { index: number; total: number };

type TabRowValue = {
  inert: boolean;
  position: (value: string) => TabPosition | undefined;
};

const RowContext = createContext<TabRowValue>({
  inert: false,
  position: () => undefined,
});

/**
 * What a strip tells the tabs inside it, over and above Kobalte's own context.
 *
 * Both facts belong to the strip and neither can travel as a prop, because a
 * strip like `OverflowTabBar` does not build its tabs: the consumer hands it a
 * `renderTab` and a JSX element is already-constructed DOM by the time the bar
 * sees it. A context is the one seam left.
 *
 * `inert` marks a subtree as scaffolding rather than as tabs. `position` is how
 * an overflowing strip stays honest: `aria-posinset`/`aria-setsize` have to
 * count the tabs that are *open*, not the ones that happen to fit.
 */
export function TabRow(props: {
  inert?: boolean;
  position?: (value: string) => TabPosition | undefined;
  children: JSX.Element;
}) {
  return (
    <RowContext.Provider
      value={{
        get inert() {
          return props.inert ?? false;
        },
        get position() {
          return props.position ?? (() => undefined);
        },
      }}
    >
      {props.children}
    </RowContext.Provider>
  );
}

export interface TabProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onClose" | "type" | "title"> {
  /** Narrower than the native attribute, which Solid still types with the
   *  long-dead `"menu"` value. Nothing in Tori passes it. */
  type?: "submit" | "reset" | "button";
  /** This tab's key in the enclosing `Tabs.Root`, and what `onChange` reports.
   *
   *  Required, because a tab belongs to a tablist: selection, the roving tab
   *  stop and arrow navigation all come from the strip above rather than from
   *  the call site, and a `Tab` with no `Root` over it throws rather than
   *  quietly rendering something that looks like a tab and behaves like a
   *  button. The one exception is a strip's own scaffolding, which says so with
   *  `TabRow inert`. */
  value: string;
  /** Leading glyph. */
  icon?: JSX.Element;
  /** The label. */
  children?: JSX.Element;
  /** Extra content after the label, before the close (e.g. dirty/touched dots). */
  trailing?: JSX.Element;
  /** When set, renders a trailing close affordance. Pointer-only by design; the
   *  announced path is Delete or Backspace on the focused tab. See the note on
   *  the component. */
  onClose?: (e: MouseEvent | KeyboardEvent) => void;
  /** Hover/focus tooltip - typically the full path behind a truncated label.
   *  Unlike `Button` and `IconButton` this does *not* backfill the accessible
   *  name; see the note on the component. */
  tooltip?: string;
  tooltipPlacement?: TooltipPlacement;
  /** Keep the tooltip reachable while the tab is `disabled`. Off by default,
   *  and opted into per site with a reason - see `Tooltip`. */
  tooltipWhenDisabled?: boolean;
}

/** The shared tab pill: transparent at rest, a quiet fill when active or
 *  hovered. Icon + label, with an optional close button. Used by the editor,
 *  terminal and Settings strips so they read and scale identically.
 *
 *  **The selected look comes from Kobalte, not from a prop.** The trigger
 *  carries `data-selected` when the strip above it says so, and the pill paints
 *  off that, so what is highlighted and what is selected cannot drift.
 *
 *  **`tooltip` does not become the accessible name here**, which is the one way
 *  this differs from `Button` and `IconButton`. Those two backfill a name from
 *  the tooltip because an icon-only control has none of its own; a tab always
 *  has visible text. An `aria-label` on a tab *replaces* that text as the name
 *  rather than adding to it, so backfilling the full path would silently rename
 *  every tab in the app and break the `getByRole("tab", { name })` queries
 *  written against the label - see the gotcha of the same name in the vault.
 *
 *  ## Why the close button is hidden from assistive tech
 *
 *  `role="tablist"` may own nothing but `role="tab"`, and axe enforces it: a
 *  labelled close button beside the trigger fails `aria-required-children`, and
 *  a wrapper does not help, because axe reads through a presentational element
 *  to the button underneath. Inside the trigger it fails `nested-interactive`
 *  instead, which is the defect this component was fixing (#115).
 *
 *  So the close is a pointer affordance and nothing else: `aria-hidden`, out of
 *  the tab order, with Delete and Backspace on the focused tab as the path that
 *  is actually announced. That is one stop per strip rather than two per tab,
 *  which is what the strips wanted anyway, and it is why there is no
 *  `closeLabel` prop - a name on a hidden element is read by nobody. Tests
 *  reach it through `data-tab-close`.
 *
 *  ## Inert tabs
 *
 *  Inside a `TabRow inert` this renders the same boxes with every interactive
 *  part disabled and no `role` at all. That is what `OverflowTabBar`'s
 *  measuring ghost needs: it has to lay out exactly like the real row to be
 *  worth measuring, while joining neither the accessibility tree nor Kobalte's
 *  collection, where it would register a second item under every key. `disabled`
 *  rather than a `<span>`, so the boxes stay identical and `aria-hidden-focus`
 *  has nothing to find. */
export default function Tab(props: TabProps) {
  const row = useContext(RowContext);
  const [local, rest] = splitProps(props, [
    "value",
    "icon",
    "children",
    "trailing",
    "onClose",
    "class",
    "type",
    "tooltip",
    "tooltipPlacement",
    "tooltipWhenDisabled",
  ]);

  // Composed rather than assigned: this handler is written after `{...rest}`,
  // so a call site's own `onKeyDown` would otherwise be dropped without a word.
  const onKeyDown = (e: KeyboardEvent) => {
    (rest.onKeyDown as ((e: KeyboardEvent) => void) | undefined)?.(e);
    if (!local.onClose) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    e.stopPropagation();
    local.onClose(e);
  };

  // `auxclick` fires for the right button too, and that one opens the menu.
  const onAuxClick = (e: MouseEvent) => {
    if (row.inert || !local.onClose || e.button !== 1) return;
    e.preventDefault();
    local.onClose(e);
  };

  const at = () => row.position(local.value);

  const content = () => (
    <>
      {local.icon}
      {local.children != null && <span class={styles.label}>{local.children}</span>}
      {local.trailing}
    </>
  );

  return (
    // Always a wrapper, close button or not, so the pill's fill and radius live
    // in one place instead of moving between the wrapper and the trigger
    // depending on whether the strip closes tabs. `presentation` is what keeps
    // it out of the tablist's owned children.
    <span
      role={row.inert ? undefined : "presentation"}
      // The tab's whole box. `data-tab-id` rides the trigger, which stops short
      // of the close, so a reader that wants the tab measures this instead.
      data-tab-pill=""
      class={local.class}
      classList={{ [styles.pill]: true }}
      onAuxClick={onAuxClick}
    >
      <Show
        when={!row.inert}
        fallback={
          <button type="button" disabled class={styles.tab}>
            {content()}
          </button>
        }
      >
        <Tabs.Trigger
          {...rest}
          value={local.value}
          // The trigger has to *be* the tooltip's control, so the two
          // polymorphics stack rather than nest. Kobalte types `as` as a bare
          // `ValidComponent` and resolves the child's props from it, which a
          // component generic in its element cannot satisfy; the runtime is one
          // props object either way.
          as={Tooltip as unknown as "button"}
          label={local.tooltip}
          placement={local.tooltipPlacement}
          whenDisabled={local.tooltipWhenDisabled}
          // Same cast, one prop further: `as` above types the child's props as
          // a `<button>`'s, and Kobalte narrows `type` to its own `"button"`
          // default. Nothing in Tori passes a tab the other two values.
          type={(local.type ?? "button") as "button"}
          // Counted over the strip's canonical list rather than the rendered
          // one. Kobalte writes neither, and a strip that drops tabs to fit
          // would otherwise announce "3 of 5" for the third of twelve open
          // files.
          aria-posinset={at()?.index}
          aria-setsize={at()?.total}
          class={styles.tab}
          onKeyDown={onKeyDown}
        >
          {content()}
        </Tabs.Trigger>
      </Show>
      {local.onClose && (
        <button
          type="button"
          class={styles.close}
          data-tab-close=""
          tabindex={-1}
          aria-hidden="true"
          disabled={row.inert}
          onClick={(e) => {
            e.stopPropagation();
            local.onClose!(e);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
}
