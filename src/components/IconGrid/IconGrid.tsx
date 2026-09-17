import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { ToggleGroup } from "../../lib/toggle-group";
import Tooltip from "../Tooltip/Tooltip";
import styles from "./IconGrid.module.css";

/** How many tiles a `grid` row holds.
 *
 *  One constant, two consumers: it lays the columns out (inline, since the
 *  stylesheet cannot read it) and the vertical key handler steps by it. A
 *  second copy in the stylesheet would drift the day one of them changed, and
 *  the drift would read as "ArrowDown skips a tile" rather than as a mismatch. */
const COLUMNS = 8;

/** The value the leading tile carries internally.
 *
 *  Both consumers model "no icon" / "derive the colour" as `null`, and a toggle
 *  group keys its items by string. A sentinel keeps that translation inside
 *  this component rather than asking every caller to invent one, and the
 *  underscores are what keep it from colliding with a real icon or colour name:
 *  both sets are capitalised words ("Rocket", "Amber"). */
const LEADING = "__leading__";

export interface IconGridTile {
  /** Selection value, unique within the grid. */
  value: string;
  /** The tile's accessible name *and* its tooltip text.
   *
   *  Both, because a tile is icon-only: the glyph carries no text, so the name
   *  has to be supplied, and the tooltip is the only way a sighted user reads
   *  it. See `Tooltip`'s module comment on why a description is not a name. */
  label: string;
  /** What the tile shows: a glyph, a word, or nothing at all for a swatch. */
  content?: JSX.Element;
  /** `swatch` only: the tile's hue, as an rgb channel triple.
   *
   *  A triple rather than a colour because it is composed into `rgb()` with the
   *  tile's own alpha - see `utils/spaceTint.ts`. */
  tint?: string;
}

export interface IconGridProps {
  /** `grid` is the scrollable eight-column set of square glyph tiles; `swatch`
   *  is the single wrapped row of round colour tiles. */
  variant?: "grid" | "swatch";
  /** Names the group for assistive tech. Required: the tiles are icon-only, so
   *  without it the group is an unlabelled cluster of glyph names. */
  "aria-label": string;
  /** The selected tile's value, or `null` for the leading tile. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** The tile pinned first and never filtered out.
   *
   *  It is a state rather than a search result - "None", "Automatic" - so it
   *  holds its position while the query narrows everything after it. Selected
   *  exactly when `value` is `null`. */
  leading?: Omit<IconGridTile, "value">;
  /** The tiles after the leading one, for the current query.
   *
   *  A function of the query rather than a plain array so the filtering stays
   *  with the data that knows how to filter itself; callers with no search
   *  field ignore the argument. */
  tiles: (query: string) => IconGridTile[];
  /** Renders an owned search field above the group. */
  search?: {
    label: string;
    placeholder: string;
    /** Handed the input, so a dialog can make it the initial focus. */
    ref?: (el: HTMLInputElement) => void;
    /** The query as it is typed, for a caller that draws something of its own
     *  against it. `tiles` already sees it, but a caller cannot read it back
     *  out of a function the grid calls - and what hangs off it is usually
     *  outside the grid, like the space picker's "+N more" line, which is only
     *  true while nothing is being searched for. */
    onQuery?: (query: string) => void;
  };
  class?: string;
}

/** A single-select grid of icon tiles, and the same control shaped as a row of
 *  colour swatches. Kobalte's toggle group underneath, so the whole set is one
 *  tab stop with a roving tabindex inside it, arrows and Home/End move focus
 *  without selecting, and Space/Enter select the focused tile.
 *
 *  Four contract points, each of them a thing the primitive does not give:
 *
 *  **Always exactly one selected.** Kobalte's single mode lets a press on the
 *  pressed item clear the selection (`onChange(null)`); "nothing chosen" is not
 *  a state either consumer has, so that change is dropped and the controlled
 *  `value` holds. The leading tile is how "none" is expressed, and it is a
 *  value like any other.
 *
 *  **ArrowUp/ArrowDown move a row, and only here.** Kobalte's group is
 *  one-dimensional and its vertical keys are inert: the root builds a
 *  *horizontal* keyboard delegate but hands `createSelectableCollection` no
 *  orientation at all, so that switch takes its `"vertical"` default and routes
 *  ArrowUp/ArrowDown into the delegate's `getKeyAbove`/`getKeyBelow` - which a
 *  horizontal delegate answers with `undefined`. Left and Right are the only
 *  keys that move, in a set that is visibly eight wide.
 *
 *  The handler that fixes it sits on the *item* rather than on the group, and
 *  stops the event there. A group-level handler would be at the mercy of that
 *  orientation mismatch staying exactly as it is: the group composes a caller's
 *  `onKeyDown` with its own through `composeEventHandlers`, which ignores
 *  `defaultPrevented`, so the day those vertical keys start resolving to a key
 *  this would silently move a row and then one tile more. Stopping at the item
 *  makes the behaviour ours outright instead of borrowed.
 *
 *  The swatch row keeps the plain linear behaviour: it is one wrapped row, so
 *  there is no second axis to be wrong about.
 *
 *  **The search field is outside the group, deliberately.** Kobalte's keydown
 *  guard is containment in the group's own element, not "the target is a tile",
 *  so an input inside it loses ArrowLeft/ArrowRight and Home/End to the roving
 *  focus and its caret stops moving.
 *
 *  **The group keeps a tab stop when the query eats the focused tile.** Kobalte
 *  parks the tab stop on the focused item and takes it off the container
 *  (`tabIndex` is `focusedKey == null ? 0 : -1` on the group, and
 *  `key === focusedKey ? 0 : -1` on each item), and nothing clears `focusedKey`
 *  when that item unmounts. Filter away the tile you last focused and every
 *  item reads -1 while the container reads -1 too, which takes the whole grid
 *  out of the tab order. `tabIndex` below is the same rule computed against the
 *  tiles that are actually on screen, and it wins because Kobalte spreads
 *  incoming props after its own.
 */
export default function IconGrid(props: IconGridProps) {
  const [query, setQuery] = createSignal("");
  // Mirrors Kobalte's internal `focusedKey`, which is not readable from here.
  // It is set from the same events the primitive sets its own from - an item
  // taking focus, however it got there - so the two agree.
  const [focused, setFocused] = createSignal<string | null>(null);

  const tiles = createMemo(() => props.tiles(props.search ? query() : ""));
  const shown = createMemo(() => {
    const values = new Set(tiles().map((t) => t.value));
    if (props.leading) values.add(LEADING);
    return values;
  });

  const selected = () => props.value ?? LEADING;
  const onChange = (next: string | string[] | null) => {
    if (next == null || Array.isArray(next)) return;
    const value = next === LEADING ? null : next;
    if (value !== props.value) props.onChange(value);
  };

  // Enter and Space both reach a dialog's own `onKeyDown` otherwise, and both
  // dialogs confirm on Enter: one keystroke would pick a tile and submit.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  };

  const onTileKeyDown = (e: KeyboardEvent) => {
    if (props.variant === "swatch") return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const tile = e.currentTarget as HTMLElement;
    const group = tile.closest("[role='group']");
    if (!group) return;

    e.preventDefault();
    // Before the bounds check, not after: a clamped move is still this
    // component's answer, and letting the refused one through would put the
    // edges back under the primitive's control.
    e.stopPropagation();

    const all = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    const from = all.indexOf(tile as HTMLButtonElement);
    if (from < 0) return;
    const to = e.key === "ArrowDown" ? from + COLUMNS : from - COLUMNS;
    if (to < 0 || to >= all.length) return;
    all[to].focus();
  };

  // The spec arrives as an accessor, not a snapshot: a leading tile's tint can
  // depend on state this component never sees - `SpaceDialog` previews the hue
  // its space would derive from the name being typed two fields up - and
  // reading it once at mount would freeze that preview.
  const tile = (value: string, spec: () => Omit<IconGridTile, "value">) => (
    <Tooltip
      as={ToggleGroup.ButtonItem}
      value={value}
      label={spec().label}
      aria-label={spec().label}
      class={styles.tile}
      style={spec().tint != null ? { "--tile-tint": spec().tint } : undefined}
      onKeyDown={onTileKeyDown}
      onFocus={() => setFocused(value)}
    >
      {spec().content}
    </Tooltip>
  );

  return (
    <>
      <Show when={props.search}>
        {(search) => (
          <input
            ref={search().ref}
            class={styles.search}
            value={query()}
            placeholder={search().placeholder}
            aria-label={search().label}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              search().onQuery?.(e.currentTarget.value);
            }}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
        )}
      </Show>
      <ToggleGroup.Root
        value={selected()}
        onChange={onChange}
        onKeyDown={onKeyDown}
        aria-label={props["aria-label"]}
        tabIndex={focused() != null && shown().has(focused()!) ? -1 : 0}
        class={props.class}
        classList={{
          [styles.group]: true,
          [styles[props.variant ?? "grid"]]: true,
        }}
        style={
          props.variant === "swatch"
            ? undefined
            : { "grid-template-columns": `repeat(${COLUMNS}, 1fr)` }
        }
      >
        <Show when={props.leading}>{(spec) => tile(LEADING, spec)}</Show>
        <For each={tiles()}>{(spec) => tile(spec.value, () => spec)}</For>
      </ToggleGroup.Root>
    </>
  );
}
