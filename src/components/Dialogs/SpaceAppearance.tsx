import { createSignal, Show } from "solid-js";
import { ChevronDown, Dices, Type } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Icon from "../Icon/Icon";
import IconGrid from "../IconGrid/IconGrid";
import Popover from "../Popover/Popover";
import {
  PICKER_ICONS,
  drawShelf,
  resolveIcon,
  restingShelf,
  searchIcons,
} from "../Icon/iconRegistry";
import { SPACE_COLORS, rgbTriple, spaceHueRgb } from "../../utils/spaceTint";
import { spaceInitials } from "../../utils/names";

/** A colour and an icon, both already chosen. `null` in either is a state
 *  rather than an absence: no colour means the hue is derived from the name,
 *  no icon means the space wears its initials. */
export type Appearance = { color: string | null; icon: string | null };

/** A random appearance, for a new space and for the reroll die.
 *
 *  Only concrete swatches, never the derived hue: rerolling onto "automatic"
 *  would land back on the value the name already produces, which reads as the
 *  die having done nothing. */
export function randomAppearance(): Appearance {
  return {
    color: SPACE_COLORS[Math.floor(Math.random() * SPACE_COLORS.length)].name,
    icon: PICKER_ICONS[Math.floor(Math.random() * PICKER_ICONS.length)].name,
  };
}

type Picker = "" | "color" | "icon";

/**
 * How a space will look, as one row: a preview tile, a chip per choice, and a
 * die that rerolls both. Shared by the two `SpaceDialog` modes, which differ
 * above this row (a name field or a locked one) and not in it.
 *
 * **The chips open pickers rather than the pickers being the row.** The colour
 * set and the icon set together are two grids and a search field, which is the
 * dialog the old build shipped: three stacked pickers where the name was the
 * only thing most of the work needed. Behind chips, the appearance arrives
 * already chosen and the dialog is one field long.
 *
 * Both pickers are the shared `Popover`, so Escape, outside presses, and focus
 * returning to the chip come from there. One at a time, because the two panels
 * overlap and the second would open under the first.
 */
export default function SpaceAppearance(props: {
  /** What the preview derives its hue and its initials from. The typed name in
   *  "new", the space's own in "edit". */
  name: string;
  value: Appearance;
  onChange: (next: Appearance) => void;
}) {
  const [open, setOpen] = createSignal<Picker>("");
  // Mirrors the grid's own query, which it does not publish otherwise, so the
  // "+N more" line can go when a search is what is on screen.
  const [iconQuery, setIconQuery] = createSignal("");
  // Drawn once for the life of the dialog; see `drawShelf` on why.
  const shelf = drawShelf();
  let colorChip: HTMLButtonElement | undefined;
  let iconChip: HTMLButtonElement | undefined;
  let colorPanel: HTMLElement | undefined;
  let iconSearch: HTMLInputElement | undefined;

  // The enclosing dialog confirms on Enter from anywhere in its panel, and a
  // popover portals *into* that panel, so without this a return in the icon
  // search field creates the space instead of doing nothing. `IconGrid` already
  // stops both activation keys at its own group; this covers the field beside
  // it, which is outside that group by design (see IconGrid's module comment).
  const keepEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") e.stopPropagation();
  };

  const hue = () => spaceHueRgb(props.name, props.value.color);
  const glyph = () => resolveIcon(props.value.icon);
  const mark = () => spaceInitials(props.name);

  const resting = () => restingShelf(shelf, props.value.icon);
  const hidden = () => PICKER_ICONS.length - resting().length;

  // The query resets with the panel, because the grid is a fresh component each
  // time it opens; this mirror outlives it and would otherwise reopen claiming
  // a search that is no longer in the field.
  const toggle = (which: Picker) => {
    setIconQuery("");
    setOpen((now) => (now === which ? "" : which));
  };
  const set = (patch: Partial<Appearance>) => {
    props.onChange({ ...props.value, ...patch });
    setOpen("");
  };

  return (
    <>
      <div class={styles.appearance} style={{ "--space-hue-rgb": hue() }}>
        <div class={styles.preview}>
          <Show when={glyph()} fallback={<span class={styles.previewMark}>{mark()}</span>}>
            {(g) => <Icon icon={g()} />}
          </Show>
        </div>

        <button
          ref={colorChip}
          type="button"
          class={styles.chip}
          aria-haspopup="dialog"
          aria-expanded={open() === "color"}
          onClick={() => toggle("color")}
        >
          <span class={styles.chipDot} />
          <span>Colour</span>
          <Icon icon={ChevronDown} class={styles.chipCaret} />
        </button>

        <button
          ref={iconChip}
          type="button"
          class={styles.chip}
          aria-haspopup="dialog"
          aria-expanded={open() === "icon"}
          onClick={() => toggle("icon")}
        >
          {/* A text glyph where the space has none, so the chip previews the
              initials fallback rather than going blank. */}
          <Show when={glyph()} fallback={<Icon icon={Type} class={styles.chipGlyph} />}>
            {(g) => <Icon icon={g()} class={styles.chipGlyph} />}
          </Show>
          <span>Icon</span>
          <Icon icon={ChevronDown} class={styles.chipCaret} />
        </button>

        <button
          type="button"
          class={styles.reroll}
          aria-label="Reroll the colour and icon"
          onClick={() => {
            props.onChange(randomAppearance());
            setOpen("");
          }}
        >
          <Icon icon={Dices} />
        </button>
      </div>

      <Show when={open() === "color"}>
        <Popover
          anchorEl={colorChip}
          placement="bottom-start"
          class={styles.colorPicker}
          aria-label="Space colour"
          ref={(el) => (colorPanel = el)}
          // The panel itself: the swatches are one roving tab stop, and landing
          // the keyboard on whichever of the thirteen happens to be selected
          // would scroll the choice out from under the eye. From the panel, Tab
          // enters the row at that stop, which is where arrow keys take over.
          initialFocus={() => colorPanel}
          onClose={() => setOpen("")}
        >
          <div class={styles.pickerCaps}>Colour</div>
          {/* "Automatic" is a state, not a swatch: it hands the hue back to the
              name, which is what an untouched space already uses. Its own
              preview shows what that derives to, so the choice is visible
              rather than a leap. */}
          <IconGrid
            variant="swatch"
            aria-label="Space colour"
            value={props.value.color}
            onChange={(color) => set({ color })}
            leading={{
              label: "Automatic (from the name)",
              tint: spaceHueRgb(props.name, null),
              content: <span class={styles.swatchAuto}>A</span>,
            }}
            tiles={() =>
              SPACE_COLORS.map((entry) => ({
                value: entry.name,
                label: entry.name,
                tint: rgbTriple(entry.hex),
              }))
            }
          />
          <div class={styles.pickerNote}>Tints the window behind this space.</div>
        </Popover>
      </Show>

      <Show when={open() === "icon"}>
        <Popover
          anchorEl={iconChip}
          placement="bottom-end"
          class={styles.iconPicker}
          aria-label="Space icon"
          // The field, because the set is long enough that finding an icon
          // starts with typing its name.
          initialFocus={() => iconSearch}
          onClose={() => setOpen("")}
        >
          <div class={styles.pickerBody} onKeyDown={keepEnter}>
            {/* "No icon" is a state, not a search result, so it stays put while
                the grid filters - otherwise clearing an icon would need the
                query cleared first. It wears the initials it would fall back
                to, so what the state means is on the tile. */}
            <IconGrid
              aria-label="Space icon"
              value={props.value.icon}
              onChange={(icon) => set({ icon })}
              leading={{
                label: "No icon - use initials",
                content: <span class={styles.iconNone}>{mark()}</span>,
              }}
              tiles={(query) =>
                (query.trim() ? searchIcons(query) : resting()).map((entry) => ({
                  value: entry.name,
                  label: entry.name,
                  content: <Icon icon={entry.icon} />,
                }))
              }
              search={{
                label: "Search icons",
                placeholder: "Search icons",
                ref: (el) => (iconSearch = el),
                onQuery: setIconQuery,
              }}
            />
            {/* Only at rest. During a search the grid is showing every match,
                so there is no remainder to name. */}
            <Show when={!iconQuery().trim() && hidden() > 0}>
              <div class={styles.pickerMore}>+{hidden()} more, search to reach them</div>
            </Show>
          </div>
        </Popover>
      </Show>
    </>
  );
}
