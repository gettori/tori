import type { Meta, StoryObj } from "storybook-solidjs-vite";
import PickerModal from "./PickerModal";

// The list is the point, and it is a real `listbox`: focus stays in the filter
// field the whole time and the selection is announced through
// `aria-activedescendant`, so the way to read these stories is with the arrow
// keys rather than the mouse. Type something that matches nothing to watch the
// listbox be withdrawn rather than left owning a "No matches" line.
const BRANCHES = [
  "main",
  "develop",
  "release/2026.08",
  "feature/omnibox",
  "feature/dialog-migration",
  "feature/kobalte-menus",
  "fix/askpass-stacking",
  "fix/tint-contrast",
  "chore/deps",
  "spike/codemirror-6",
];

const meta = {
  title: "Dialogs/PickerModal",
  component: PickerModal,
  argTypes: {
    title: { control: "text" },
    placeholder: { control: "text" },
    creatable: { control: "boolean" },
    okLabel: { control: "text" },
  },
  args: {
    title: "Attach a branch",
    items: BRANCHES,
    placeholder: "Filter branches",
    onSubmit: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof PickerModal>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Select-only: OK commits a listed branch, and a name that is not on the list
 *  commits nothing at all. */
export const Playground: Story = {};

/** Creatable, which is the same dialog doing a different job: type a name no row
 *  matches and OK creates it. Enter still takes the highlighted row while any
 *  row matches, so filtering to reach an existing branch never invents one. */
export const Creatable: Story = {
  args: { title: "New branch", placeholder: "Branch name", creatable: true, okLabel: "Create" },
};

/** Long enough to scroll. The filter field stays pinned at the top of the
 *  scrolling body while the rows move past it. */
export const LongList: Story = {
  args: {
    items: Array.from({ length: 200 }, (_, i) => `origin/feature/branch-${i + 1}`),
    placeholder: "Filter 200 branches",
  },
};

/** Nothing to pick at all. The empty line stands alone, outside any listbox. */
export const Empty: Story = {
  args: { items: [] },
};
