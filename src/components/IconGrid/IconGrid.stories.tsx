import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import Icon from "../Icon/Icon";
import { searchIcons } from "../Icon/iconRegistry";
import { SPACE_COLORS, rgbTriple, spaceHueRgb } from "../../utils/spaceTint";
import IconGrid from "./IconGrid";

const meta = {
  title: "Components/IconGrid",
  component: IconGrid,
  args: {
    "aria-label": "Icon",
    value: null,
    onChange: () => {},
    tiles: () => [],
  },
} satisfies Meta<typeof IconGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

const glyphs = (query: string) =>
  searchIcons(query).map((entry) => ({
    value: entry.name,
    label: entry.name,
    content: <Icon icon={entry.icon} />,
  }));

/** The picker as both dialogs use it: the owned search field over an
 *  eight-column scrollable set, with a leading tile that is a state rather than
 *  a search result and so holds its place while the query narrows.
 *
 *  Keyboard is the toggle-button pattern: the whole grid is one tab stop, arrows
 *  and Home/End move focus without selecting, Space or Enter commits, and those
 *  activation keys stop at the group so a dialog's Enter-to-confirm cannot fire
 *  from inside it. ArrowUp and ArrowDown move a whole row, which the primitive
 *  does not do on its own. */
export const Default: Story = {
  render: () => {
    const [icon, setIcon] = createSignal<string | null>(null);
    return (
      <IconGrid
        aria-label="Space icon"
        value={icon()}
        onChange={setIcon}
        leading={{ label: "No icon", content: "None" }}
        tiles={glyphs}
        search={{ label: "Search icons", placeholder: "Search icons" }}
      />
    );
  },
};

/** No leading tile and no search: the shape `ProjectIconPicker` reaches for when
 *  the picker's own "no icon" state lives outside the grid, on the mode buttons
 *  beside it. Nothing is selected here, so the group itself holds the tab stop.
 */
export const Bare: Story = {
  render: () => {
    const [icon, setIcon] = createSignal<string | null>(null);
    return (
      <IconGrid aria-label="Project icon" value={icon()} onChange={setIcon} tiles={() => glyphs("").slice(0, 24)} />
    );
  },
};

/** The same control as a colour row: round tiles carrying their own hue, one
 *  wrapped line rather than a scrolling grid. The leading tile derives its
 *  preview from the name it would fall back to, so "automatic" shows what it
 *  actually resolves to. */
export const Swatches: Story = {
  render: () => {
    const [colour, setColour] = createSignal<string | null>(null);
    return (
      <IconGrid
        variant="swatch"
        aria-label="Space colour"
        value={colour()}
        onChange={setColour}
        leading={{
          label: "Automatic (from the name)",
          tint: spaceHueRgb("workshop", null),
          content: <span style={{ "mix-blend-mode": "difference" }}>A</span>,
        }}
        tiles={() =>
          SPACE_COLORS.map((entry) => ({
            value: entry.name,
            label: entry.name,
            tint: rgbTriple(entry.hex),
          }))
        }
      />
    );
  },
};
