import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Tags } from "lucide-solid";
import SpaceTile, { ModeTile } from "./SpaceTile";
import type { MenuItem } from "../../components/Menu/rows";
import type { Rollup } from "../../utils/sessionStatus";

const MENU: MenuItem[] = [
  { label: "Rename space", onClick: () => {} },
  { label: "Change colour", onClick: () => {} },
  { separator: true },
  { label: "Remove space", onClick: () => {}, danger: true },
];

function rollup(r: Partial<Rollup>) {
  return () => ({
    waitingForApproval: 0,
    waitingForAnswer: 0,
    prAttention: 0,
    executing: 0,
    idle: 0,
    running: 0,
    ...r,
  });
}

/** The strip's own flex row. A tile is shrink-to-fit inside one, and the lit
 *  tile's pill only reads right with neighbours beside it to push against. */
function Strip(props: { children: JSX.Element }) {
  return (
    <div style={{ display: "flex", "align-items": "center", gap: "3px", padding: "4px 0 0" }}>{props.children}</div>
  );
}

const meta = {
  title: "Panels/LeftSidebar/SpaceTile",
  component: SpaceTile,
  args: {
    name: "work",
    color: "Sky",
    menu: MENU,
    onClick: () => {},
  },
  decorators: [
    (Story) => (
      <Strip>
        <Story />
      </Strip>
    ),
  ],
} satisfies Meta<typeof SpaceTile>;

export default meta;
type Story = StoryObj<typeof meta>;

/** At rest: a 30px square with the space's initial and nothing else. Twelve of
 *  these sit side by side, so anything more than the glyph turns the bar into a
 *  row of competing chips. */
export const Resting: Story = {};

/** The space the tree below is showing. The fill says which tile is lit; the
 *  pill opening to the name says it has one to show, and the glyph takes the
 *  space's own hue - the one thing that tells two tiles apart at a glance. */
export const Lit: Story = {
  args: { active: true, nameWidth: "44px" },
};

/** An icon from the registry replaces the initial. The name still capitalizes,
 *  so the stored lowercase key is not what the strip reads back. */
export const WithIcon: Story = {
  args: { name: "infra", icon: "server", color: "Emerald", active: true, nameWidth: "36px" },
};

/** Sessions hidden inside a space that is not the active one bubble to its
 *  corner. The square has room for one state, so it shows the one that wins
 *  (waiting, then executing, then idle, then running) and leaves the rest to
 *  the title. */
export const Bubbling: Story = {
  args: { name: "side", color: "Rose", rollup: rollup({ waitingForApproval: 2, executing: 1 }) },
};

/** The lit tile bubbles too, for a project the filter hid entirely: it never
 *  rendered, so there is no row of its own for the rollup to land on. */
export const LitAndBubbling: Story = {
  args: {
    active: true,
    nameWidth: "44px",
    rollup: rollup({ executing: 3 }),
  },
};

/** Mid-reorder. The tile being carried dims, and the tile the drop would land
 *  against takes a gold bar on that side. */
export const Dragging: Story = {
  decorators: [
    (Story) => (
      <Strip>
        <Story />
        <SpaceTile name="side" color="Rose" menu={MENU} dropBefore />
        <SpaceTile name="infra" color="Lime" menu={MENU} />
      </Strip>
    ),
  ],
  args: { dragging: true },
};

/** The whole strip as the sidebar draws it: the spaces, then the rule, then
 *  Topics. Only one tile in the set is ever lit, because the tree below can
 *  only be showing one thing. */
export const TheStrip: Story = {
  decorators: [
    () => (
      <Strip>
        <SpaceTile name="work" color="Sky" menu={MENU} active nameWidth="44px" />
        <SpaceTile name="side" color="Rose" menu={MENU} rollup={rollup({ idle: 1 })} />
        <SpaceTile name="infra" icon="server" color="Lime" menu={MENU} />
        <SpaceTile name="archive" color="Slate" menu={MENU} rollup={rollup({ running: 12 })} />
        <div style={{ width: "1px", "align-self": "stretch", margin: "2px", background: "var(--border-default)" }} />
        <ModeTile label="Topics" glyph={Tags} />
      </Strip>
    ),
  ],
};

/** Switching modes moves the pill off the spaces entirely: Topics is not a
 *  space and has no hue of its own, so lit it takes the brand. */
export const TopicsLit: Story = {
  decorators: [
    () => (
      <Strip>
        <SpaceTile name="work" color="Sky" menu={MENU} rollup={rollup({ executing: 1 })} />
        <SpaceTile name="side" color="Rose" menu={MENU} />
        <div style={{ width: "1px", "align-self": "stretch", margin: "2px", background: "var(--border-default)" }} />
        <ModeTile label="Topics" glyph={Tags} active nameWidth="52px" />
      </Strip>
    ),
  ],
};
