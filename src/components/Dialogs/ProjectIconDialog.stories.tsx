import type { Meta, StoryObj } from "storybook-solidjs-vite";
import ProjectIconDialog from "./ProjectIconDialog";

// **Upload is inert here, deliberately.** Both halves of it need a Tauri host:
// `onPickFile` is the native file dialog, and previewing whatever it returns
// goes through `convertFileSrc`, which reads Tauri's injected internals to build
// an asset URL. Storybook is a plain browser page, so the stories below hand the
// picker a resolver that returns null (a user who cancelled) and never seed a
// stored image. Clicking "Upload image…" therefore does nothing, which is the
// honest rendering of this component outside the app rather than a broken story.
//
// Everything else is real: the three ways to have an icon are one selection, so
// picking a glyph un-chooses automatic, and the grid filters over the same fixed
// set the space dialog uses.
const noFile = () => Promise.resolve<string | null>(null);

const meta = {
  title: "Dialogs/ProjectIconDialog",
  component: ProjectIconDialog,
  argTypes: {
    projectName: { control: "text" },
    seed: { control: "text" },
    icon: { control: "text" },
    busy: { control: "boolean" },
  },
  args: {
    projectName: "sway",
    seed: "/Users/you/Projects/sway",
    icon: null,
    iconFile: null,
    favicon: null,
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
    onPickFile: noFile,
  },
} satisfies Meta<typeof ProjectIconDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing stored, so the automatic option is selected and previews the glyph
 *  derived from the project's path. */
export const Automatic: Story = {};

/** A glyph is stored, so the grid shows it selected and automatic is not. */
export const StoredGlyph: Story = {
  args: { icon: "Rocket" },
};

/** Mid-save. The confirm button is disabled and says what it is doing. */
export const Saving: Story = {
  args: { icon: "Rocket", busy: true },
};
