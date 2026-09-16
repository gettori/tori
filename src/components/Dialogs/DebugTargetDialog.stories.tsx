import type { Meta, StoryObj } from "storybook-solidjs-vite";
import DebugTargetDialog from "./DebugTargetDialog";

// Three modes behind one segmented control, each with its own field and its own
// reason for being unavailable. The blocked stories are the ones worth reading:
// the dialog says what is missing instead of leaving a dead Start button.
const meta = {
  title: "Dialogs/DebugTargetDialog",
  component: DebugTargetDialog,
  argTypes: {
    kind: { control: "select", options: ["file", "script", "attach"] },
    filePath: { control: "text" },
    port: { control: "number" },
  },
  args: {
    kind: "file",
    filePath: "/Users/you/Projects/tori/src/index.ts",
    scripts: ["dev", "build", "test"],
    port: 9229,
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof DebugTargetDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every mode reachable from the segmented control; switch between them here. */
export const Playground: Story = {};

/** Nothing is open, so this file mode has no file to run and says which. */
export const NoFileOpen: Story = {
  args: { filePath: null },
};

/** The script picker, defaulting to the first script in declaration order. */
export const Scripts: Story = {
  args: { kind: "script" },
};

/** A project that declares none: the picker is replaced by the reason, not left
 *  as an empty select. */
export const NoScripts: Story = {
  args: { kind: "script", scripts: [] },
};

/** Attaching to an already-running inspector. Type a port outside 1024-65535 to
 *  watch Start explain itself rather than merely dim. */
export const Attach: Story = {
  args: { kind: "attach" },
};
