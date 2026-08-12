import type { Meta, StoryObj } from "storybook-solidjs-vite";
import SpaceDialog from "./SpaceDialog";

// One component, two dialogs, and the difference is worth clicking through:
// "new" creates a folder, so the name is validated and permanent, while "edit"
// creates nothing, so the name is locked and the icon is the only thing left to
// change. The colour row's first swatch is not a colour but a state - it hands
// the hue back to the name, and previews what that derives to.
const meta = {
  title: "Dialogs/SpaceDialog",
  component: SpaceDialog,
  argTypes: {
    mode: { control: "inline-radio", options: ["new", "edit"] },
    name: { control: "text" },
    icon: { control: "text" },
    color: { control: "text" },
    busy: { control: "boolean" },
  },
  args: {
    mode: "new",
    name: "",
    icon: null,
    color: null,
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof SpaceDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Empty, which is also the invalid state: Create is disabled and the field says
 *  why. Try a slash or a leading dot to see the other two. */
export const NewSpace: Story = {};

/** A name that will pass, so the automatic swatch has a hue to derive. */
export const NewSpaceNamed: Story = {
  args: { name: "work" },
};

/** Editing an existing space: the name is locked (still named for a screen
 *  reader by the line above it), and the stored icon and colour are
 *  preselected. */
export const EditSpace: Story = {
  args: { mode: "edit", name: "work", icon: "Rocket", color: "Amber" },
};

/** Mid-save. The confirm button is disabled and says what it is doing. */
export const Saving: Story = {
  args: { mode: "edit", name: "work", icon: "Rocket", busy: true },
};
