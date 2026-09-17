import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import ContextMenu from "./ContextMenu";
import { MenuRow, MenuSeparator } from "./rows";

/** A stand-in for the surfaces this replaces: a tree row, a sidebar row, a tab.
 *  Deliberately plain, so what the story shows is the menu rather than the row's
 *  own chrome. */
const rowStyle = {
  padding: "var(--tori-space-3) var(--tori-space-4)",
  border: "1px dashed var(--border-default)",
  "border-radius": "var(--tori-radius-md)",
  color: "var(--fg-default)",
  cursor: "default",
} as const;

const meta = {
  title: "Components/ContextMenu",
  component: ContextMenu,
  args: {
    style: rowStyle,
    children: "Right-click me",
    items: [
      { label: "Rename", onClick: () => {} },
      { label: "Reveal in Finder", onClick: () => {} },
      { separator: true },
      { label: "Delete", onClick: () => {}, danger: true },
    ],
  },
} satisfies Meta<typeof ContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole component: right-click the row. Escape closes it, so does a click
 *  outside, and the arrows, Home/End and typing a row's first letters all move
 *  the highlight - none of which the hand-rolled menu this replaces could do. */
export const Playground: Story = {};

/** What a row can say about itself. `danger` and `warn` are colour only;
 *  `disabled` is the primitive's own state, so the row is skipped by the arrows
 *  and by typeahead as well as being unclickable. */
export const RowStates: Story = {
  args: {
    items: [
      { label: "Open", onClick: () => {} },
      { label: "Discard changes", onClick: () => {}, warn: true },
      { label: "Delete branch", onClick: () => {}, danger: true },
      { separator: true },
      { label: "Push (no upstream)", onClick: () => {}, disabled: true },
    ],
  },
};

/** What the menu is acting on, when the row alone does not say it. Inside a
 *  Topic two members hold the same `package.json`, so the tree's row menu
 *  leads with the repo. Kobalte's group label: the arrows skip it, and the group
 *  it names is announced before the first row rather than the name being read as
 *  an option. */
export const WithHeading: Story = {
  args: {
    items: [
      { heading: "web" },
      { label: "Rename", onClick: () => {} },
      { label: "Delete", onClick: () => {}, danger: true },
    ],
  },
};

/** Rows with more than a label: an icon, a count, a trailing control. `items` is
 *  the shorthand; `menu` is the escape hatch, and both render the same chrome
 *  because they go through the same row layer. */
export const CustomRows: Story = {
  args: {
    menu: (
      <>
        <MenuRow onClick={() => {}}>
          <span>main</span>
          <span style={{ "margin-left": "auto", color: "var(--fg-muted)" }}>
            up to date
          </span>
        </MenuRow>
        <MenuRow onClick={() => {}}>
          <span>feature/menus</span>
          <span style={{ "margin-left": "auto", color: "var(--fg-muted)" }}>
            3 ahead
          </span>
        </MenuRow>
        <MenuSeparator />
        <MenuRow onClick={() => {}} danger>
          Delete this worktree
        </MenuRow>
      </>
    ),
  },
};

/** A row with nothing to offer. `disabled` leaves the right-click alone
 *  entirely, so the browser's own menu opens instead of an empty surface - which
 *  is what a `tori://` view tab wants. */
export const Disabled: Story = {
  args: { disabled: true, children: "Right-click me (browser menu)" },
};

/** What an enclosing surface can see. HistoryPanel needs this: it holds its own
 *  popover open while one of its rows has a menu up, and gates its
 *  document-level arrow handler on the same signal. */
export const ReportsItsOpenState: Story = {
  render: (args) => {
    const [open, setOpen] = createSignal(false);
    return (
      <div style={{ display: "grid", gap: "var(--tori-space-4)" }}>
        <ContextMenu {...args} onOpenChange={setOpen} />
        <span style={{ color: "var(--fg-muted)", "font-size": "var(--tori-text-md)" }}>
          menu is {open() ? "open" : "closed"}
        </span>
      </div>
    );
  },
};
