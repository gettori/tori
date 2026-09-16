import type { Meta, StoryObj } from "storybook-solidjs-vite";
import BranchRemoveDialog from "./BranchRemoveDialog";

// Three dialogs in one component, told apart by the checkboxes: remove from
// Tori's list, delete the local branch, delete the remote one. The interesting
// story is `Detach`, where clearing local delete changes what the dialog means.
const meta = {
  title: "Dialogs/BranchRemoveDialog",
  component: BranchRemoveDialog,
  argTypes: {
    branch: { control: "text" },
    unpushed: { control: "boolean" },
    hasRemote: { control: "boolean" },
    busy: { control: "boolean" },
  },
  args: {
    branch: "feature/omnibox",
    unpushed: false,
    hasRemote: false,
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof BranchRemoveDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Pushed and tracked: deleting it locally loses nothing. */
export const Pushed: Story = {
  args: { hasRemote: true },
};

/** The status has not come back yet. */
export const StillChecking: Story = {
  args: { unpushed: null },
};

/** Commits that exist on no remote. Deleting the branch is the only way to lose
 *  them, so the warning is in words rather than in a tag alone. */
export const Unpushed: Story = {
  args: { unpushed: true, hasRemote: true },
};

/** Clear "Delete local branch" in the controls and the dialog becomes a detach:
 *  the branch stays in git and only leaves Tori's list. */
export const Detach: Story = {};

/** Mid-removal. */
export const Removing: Story = {
  args: { busy: true, hasRemote: true },
};
