import type { Meta, StoryObj } from "storybook-solidjs-vite";
import SpaceDialog from "./SpaceDialog";

// One component, two dialogs, and the difference is worth clicking through:
// "new" creates a folder, so the name is validated and permanent, while "edit"
// creates nothing, so the name is locked and colour and icon are all that is
// left to change. Both open on an appearance that is already chosen - the chips
// preview it, the die rerolls it - so neither picker ever gates a submit. The
// colour popover's first swatch is not a colour but a state: it hands the hue
// back to the name, and previews what that derives to.
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
    spaces: ["work", "side", "archive"],
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof SpaceDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Empty, where the dialog starts: Create is off and the help line is the
 *  default copy, not an error. Type `work` for the collision, or a slash or a
 *  leading dot for the two the server would refuse. */
export const NewSpace: Story = {};

/** A name that collides with one already in the base folder: Create stays off,
 *  the help line becomes the reason, and the field turns red. */
export const NewSpaceTaken: Story = {
  args: { name: "work" },
};

/** A name that will pass, so the preview has initials to fall back to and the
 *  automatic swatch a hue to derive. */
export const NewSpaceNamed: Story = {
  args: { name: "side-quest" },
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
