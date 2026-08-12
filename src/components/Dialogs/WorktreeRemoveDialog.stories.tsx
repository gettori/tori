import type { Meta, StoryObj } from "storybook-solidjs-vite";
import WorktreeRemoveDialog from "./WorktreeRemoveDialog";

// The states worth looking at are the ones the sidebar reaches asynchronously:
// the status flags arrive after the dialog is already on screen, so "checking…"
// is a real frame a user sees, not a loading placeholder that flashes past.
const meta = {
  title: "Dialogs/WorktreeRemoveDialog",
  component: WorktreeRemoveDialog,
  argTypes: {
    label: { control: "text" },
    path: { control: "text" },
    branch: { control: "text" },
    dirty: { control: "boolean" },
    unpushed: { control: "boolean" },
    hasRemote: { control: "boolean" },
    runningCount: { control: "number" },
    busy: { control: "boolean" },
  },
  args: {
    label: "feature/omnibox",
    path: "/Users/you/Projects/sway/feature-omnibox",
    branch: "feature/omnibox",
    dirty: false,
    unpushed: false,
    hasRemote: false,
    runningCount: 0,
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof WorktreeRemoveDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A clean worktree: nothing is lost, so there is no warning to read. */
export const Clean: Story = {};

/** The status has not come back yet. Both flags are null, so neither the
 *  reassurance nor the warning can be shown honestly. */
export const StillChecking: Story = {
  args: { dirty: null, unpushed: null },
};

/** Work that exists nowhere else, plus live terminals that will be killed. This
 *  is the state the dialog was built for. */
export const LosesWork: Story = {
  args: { dirty: true, unpushed: true, hasRemote: true, runningCount: 2 },
};

/** A detached worktree with no branch: no branch row, and no local-delete
 *  checkbox to offer. */
export const NoBranch: Story = {
  args: { branch: null },
};

/** Mid-removal. The confirm button is disabled and says so, and the dialog
 *  stays up because the operation can still raise a credential prompt. */
export const Removing: Story = {
  args: { busy: true, hasRemote: true },
};
